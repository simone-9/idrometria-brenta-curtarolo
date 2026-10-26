// ANALISI DELLO STORICO dei livelli (Osservatorio Alpi Orientali) per ricavare i tempi di viaggio della piena.
// 1) scopre da quando ci sono dati; 2) scarica a mesi i livelli di Campo San Martino, Cismon, Fonzaso e Valgadena;
// 3) trova le piene più alte a Campo San Martino e misura quanto prima sono saliti gli altri punti;
// 4) stampa nel log solo un RIASSUNTO. Non salva e non pubblica i dati scaricati.
// Segreti: OSSERVATORIO_USER, OSSERVATORIO_PASSWORD. Variabili: ANNI_MAX (default 8), PAUSA_MS (default 800).
const BASE = (process.env.OSSERVATORIO_BASE || 'https://www.amicoalpiorientali.eu/CoDataService').replace(/\/$/, '');
const USER = process.env.OSSERVATORIO_USER, PASS = process.env.OSSERVATORIO_PASSWORD;
const ANNI_MAX = +(process.env.ANNI_MAX || 8), PAUSA = +(process.env.PAUSA_MS || 800);
const LIMITE_MS = +(process.env.LIMITE_MIN || 35) * 60000, T0 = Date.now();
if (!USER || !PASS) { console.error('Mancano i segreti OSSERVATORIO_USER / OSSERVATORIO_PASSWORD.'); process.exit(1); }

const ST = { 1154: 'Brenta a Campo San Martino', 1167: 'Cismon del Grappa', 1155: 'Cismon a Fonzaso', 1173: 'Valgadena a Valstagna' };
const RIF = '1154';   // punto di riferimento: il più a valle (circa 5 km sopra Limena)
const pausa = ms => new Promise(r => setTimeout(r, ms));
const p2 = n => String(n).padStart(2, '0');
const fmt = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`; };
const dt = s => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s)); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : NaN; };   // restano in ora solare: nelle differenze non conta

let token = '';
async function chiama(percorso, opz = {}, tent = 4) {
  let err;
  for (let i = 0; i < tent; i++) {
    try {
      const r = await fetch(BASE + percorso, { ...opz, signal: AbortSignal.timeout(120000) });
      const t = await r.text();
      if ([502, 503, 504].includes(r.status)) { err = new Error(`risposta ${r.status}`); await pausa(5000 * (i + 1)); continue; }
      if (r.status === 401 && token) { await login(); opz = { ...opz, headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } }; continue; }
      if (!r.ok) throw Object.assign(new Error(`risposta ${r.status} ${t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 160)}`), { definitivo: true });
      try { return JSON.parse(t); } catch { return t; }
    } catch (e) { if (e.definitivo) throw e; err = e; await pausa(5000 * (i + 1)); }
  }
  throw err;
}
async function login() {
  const fd = new FormData(); fd.append('userName', USER); fd.append('password', PASS);
  const r = await chiama('/api/Auth/login', { method: 'POST', body: fd }, 3);
  token = String(typeof r === 'string' ? r : (r.token || '')).replace(/^"|"$/g, '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new Error('token non ottenuto');
}
async function livelli(da, a) {   // da/a in ms (ora solare)
  const q = new URLSearchParams({ stationIDs: Object.keys(ST).join(','), startDate: fmt(da), endDate: fmt(a), format: 'JSON' });
  const r = await chiama(`/api/measures/6?${q}`, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  if (!Array.isArray(r)) throw new Error('risposta non valida');
  const per = {};
  for (const x of r) { const t = dt(x.dataora), v = +x.valore; if (isFinite(t) && isFinite(v) && v > -50 && v < 100) (per[x.idstazione] = per[x.idstazione] || []).push([t, v]); }
  return per;
}

await login(); console.log('Login eseguito.');
// ---- 1) da quando ci sono dati ----
const anno = new Date().getUTCFullYear();
console.log('\nDISPONIBILITÀ (letture di livello trovate in 3 giorni di prova per trimestre):');
const prima = {};
for (let y = anno - 20; y <= anno; y++) {
  let riga = `${y}:`;
  const tot = {};
  for (const m of [0, 3, 6, 9]) {
    const a = Date.UTC(y, m, 10), b = Date.UTC(y, m, 13);
    if (a > Date.now()) continue;
    try { const per = await livelli(a, b); for (const id of Object.keys(ST)) tot[id] = (tot[id] || 0) + (per[id] ? per[id].length : 0); } catch (e) { riga += ` [errore ${e.message}]`; }
    await pausa(300);
  }
  for (const id of Object.keys(ST)) { riga += ` ${id}=${tot[id] || 0}`; if (tot[id] && (!prima[id] || y < prima[id])) prima[id] = y; }
  console.log(riga);
}
console.log('Primo anno con dati per stazione:', JSON.stringify(prima));
if (!prima[RIF]) { console.log('Nessun dato storico a Campo San Martino: analisi impossibile.'); process.exit(0); }

// ---- 2) scarico a mesi ----
const daAnno = Math.max(prima[RIF], anno - ANNI_MAX);
console.log(`\nScarico dal ${daAnno} (massimo ${ANNI_MAX} anni), a mesi…`);
const serie = {}; for (const id of Object.keys(ST)) serie[id] = [];
let mesi = 0, errori = 0, interrotto = false;
for (let y = daAnno; y <= anno && !interrotto; y++) for (let m = 0; m < 12; m++) {
  const a = Date.UTC(y, m, 1), b = Date.UTC(y, m + 1, 1);
  if (a > Date.now()) break;
  if (Date.now() - T0 > LIMITE_MS) { interrotto = true; console.log(`Tempo massimo raggiunto: ci si ferma a ${y}-${p2(m + 1)}.`); break; }
  try { const per = await livelli(a, b); for (const id of Object.keys(per)) for (const p of per[id]) serie[id].push(p); mesi++; } catch (e) { errori++; console.log(`  ${y}-${p2(m + 1)}: ${e.message}`); }
  await pausa(PAUSA);
}
for (const id of Object.keys(serie)) { serie[id].sort((a, b) => a[0] - b[0]); }
// pulizia: i sensori hanno valori impossibili (es. -9 m o 7,68 m fissi). Si scartano i fuori scala e i picchi isolati (filtro di Hampel).
const MIN_OK = -0.3, MAX_OK = 6.5;
const mediana = a => { const s = [...a].sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
for (const id of Object.keys(serie)) {
  const orig = serie[id].length;
  let s1 = serie[id].filter(p => p[1] >= MIN_OK && p[1] <= MAX_OK);
  const fuori = orig - s1.length;
  const pul = [];
  for (let i = 0; i < s1.length; i++) {
    const fin = s1.slice(Math.max(0, i - 3), i + 4).map(p => p[1]);
    if (Math.abs(s1[i][1] - mediana(fin)) > 0.6) continue;   // picco isolato di oltre 60 cm rispetto ai vicini
    pul.push(s1[i]);
  }
  console.log(`Pulizia ${ST[id]} (${id}): ${orig} letture, ${fuori} fuori scala, ${s1.length - pul.length} picchi isolati scartati.`);
  serie[id] = pul;
}
console.log(`Mesi scaricati: ${mesi}, con errore: ${errori}. Letture per stazione: ` + Object.keys(ST).map(id => `${id}=${serie[id].length}`).join(' '));

// ---- 3) piene a Campo San Martino ----
const H = 3600000;
const rif = serie[RIF];
if (rif.length < 500) { console.log('Dati insufficienti a Campo San Martino.'); process.exit(0); }
const massimoIn = (s, da, a) => { let best = null; for (const p of s) { if (p[0] < da) continue; if (p[0] > a) break; if (!best || p[1] > best[1]) best = p; } return best; };
const minimoIn = (s, da, a) => { let best = null; for (const p of s) { if (p[0] < da) continue; if (p[0] > a) break; if (!best || p[1] < best[1]) best = p; } return best; };
// massimi locali: il punto più alto in una finestra di ±36 h, con salita di almeno 0,5 m sul minimo delle 72 h precedenti
const eventi = [];
for (let i = 1; i < rif.length - 1; i++) {
  const [t, v] = rif[i];
  if (v < rif[i - 1][1] || v < rif[i + 1][1]) continue;
  const vic = massimoIn(rif, t - 36 * H, t + 36 * H);
  if (!vic || vic[0] !== t) continue;
  const mn = minimoIn(rif, t - 72 * H, t);
  if (mn && v - mn[1] >= 0.5) eventi.push({ t, v, salita: v - mn[1], t0: mn[0] });
}
eventi.sort((a, b) => b.salita - a.salita);
const top = eventi.slice(0, 20).sort((a, b) => a.t - b.t);
// momento in cui la salita arriva a metà: più stabile del picco, che può essere piatto o doppio
const meta = (s, tMin, tPk, vMin, vPk) => { const soglia = vMin + 0.5 * (vPk - vMin); for (const p of s) { if (p[0] < tMin) continue; if (p[0] > tPk) break; if (p[1] >= soglia) return p[0]; } return null; };
console.log(`\nPIENE A CAMPO SAN MARTINO con salita ≥ 0,5 m (dati puliti): ${eventi.length}. Le 20 maggiori. «metà salita» = momento in cui il livello ha fatto metà della salita:`);
const lag = { 1167: [], 1155: [], 1173: [] }, rap = { 1167: [], 1155: [], 1173: [] };
for (const e of top) {
  const tr = meta(rif, e.t0, e.t, e.v - e.salita, e.v);
  let riga = `${fmt(e.t).slice(0, 16)}  picco ${e.v.toFixed(2)} m  salita +${e.salita.toFixed(2)} m`;
  for (const id of Object.keys(lag)) {
    const s = serie[id], pk = massimoIn(s, e.t - 30 * H, e.t + 3 * H);
    if (!pk) { riga += `  | ${id}: n.d.`; continue; }
    const mn = minimoIn(s, pk[0] - 72 * H, pk[0]);
    const salitaUp = mn ? pk[1] - mn[1] : 0;
    if (!mn || salitaUp < 0.3) { riga += `  | ${id}: salita ${salitaUp.toFixed(2)} m (troppo piccola)`; continue; }
    const tu = meta(s, mn[0], pk[0], mn[1], pk[1]);
    if (tu == null || tr == null) { riga += `  | ${id}: n.d.`; continue; }
    const l = (tr - tu) / H;
    lag[id].push(l); rap[id].push(e.salita / salitaUp);
    riga += `  | ${id}: metà salita ${l.toFixed(1)} h prima (salita +${salitaUp.toFixed(2)} m)`;
  }
  console.log(riga);
}
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
console.log('\nRIEPILOGO (mediana sulle piene in cui la stazione ha una salita marcata):');
for (const id of Object.keys(lag)) {
  const l = lag[id], r = rap[id];
  console.log(`${ST[id]} (${id}): piene usate ${l.length}; anticipo della metà salita rispetto a Campo San Martino: mediana ${med(l) == null ? 'n.d.' : med(l).toFixed(1) + ' h'}` + (l.length ? ` (da ${Math.min(...l).toFixed(1)} a ${Math.max(...l).toFixed(1)} h)` : '') + `; salita a Campo San Martino / salita qui: mediana ${med(r) == null ? 'n.d.' : med(r).toFixed(2)}`);
}
console.log('\nNota: i dati sono automatici e non validati; Barzizza e Limena non sono nell\'Osservatorio, quindi questa analisi non li include.');
