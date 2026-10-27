// VERIFICA SULLO STORICO della regola di preavviso dal Cismon a Fonzaso (riquadro dell'app, nessuna notifica).
// Applica la stessa regola dell'app a tutta la storia di Fonzaso e conta quante volte la salita è stata seguita da una piena a Campo San Martino
// (veri allarmi), quante no (falsi allarmi) e quante piene sono arrivate senza preavviso. Stampa nel log solo un riassunto.
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

// ---- 3) regola dell'app applicata allo storico ----
const H = 3600000, F = serie['1155'], C = serie[RIF];
if (F.length < 500 || C.length < 500) { console.log('Dati insufficienti a Fonzaso o Campo San Martino.'); process.exit(0); }
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const finestra = (s, da, a) => s.filter(p => p[0] >= da && p[0] <= a).map(p => p[1]);
// stessa regola del riquadro: mediana delle letture dell'ultima ora meno mediana delle letture di 3-6 ore prima
function salitaA(s, t) {
  const ora = finestra(s, t - H + 1, t), prima = finestra(s, t - 6 * H, t - 3 * H);
  if (ora.length < 2 || prima.length < 4) return null;
  return med(ora) - med(prima);
}
// salita di Campo San Martino dopo l'allarme: massimo nelle 18 ore successive meno il livello tipico appena prima
function piena(t) {
  const base = finestra(C, t - 2 * H, t), dopo = finestra(C, t, t + 18 * H);
  if (base.length < 4 || dopo.length < 8) return null;
  return Math.max(...dopo) - med(base);
}
function istante(s, da, soglia) { for (const p of s) { if (p[0] < da) continue; if (p[1] >= soglia) return p[0]; } return null; }
const SOGLIE = [0.5, 1.0], PIENE = [0.5, 1.0];
const t0 = F[0][0] + 7 * H, t1 = F[F.length - 1][0];
for (const sg of SOGLIE) {
  // episodi: primo istante con salita >= soglia; poi si attende che la salita rientri sotto 0,25 m prima di contarne un altro
  const ep = []; let attivo = false;
  for (let t = t0; t <= t1; t += 15 * 60000) {
    const r = salitaA(F, t); if (r == null) continue;
    if (!attivo && r >= sg) { const p = piena(t); ep.push({ t, r, p }); attivo = true; }
    else if (attivo && r < 0.25) attivo = false;
  }
  const valutati = ep.filter(e => e.p != null);
  console.log(`\nREGOLA «Fonzaso sale di almeno ${sg} m in 3-6 ore»: ${ep.length} allarmi nello storico (${valutati.length} valutabili).`);
  for (const lim of PIENE) {
    const ok = valutati.filter(e => e.p >= lim), no = valutati.length - ok.length;
    const anticipi = ok.map(e => { const base = med(finestra(C, e.t - 2 * H, e.t)); const tt = istante(C, e.t, base + lim); return tt == null ? null : (tt - e.t) / H; }).filter(x => x != null);
    console.log(`  seguiti da una salita di almeno ${lim} m a Campo San Martino entro 18 h: ${ok.length} su ${valutati.length} (${valutati.length ? Math.round(100 * ok.length / valutati.length) : 0}%); falsi allarmi: ${no}` + (anticipi.length ? `; tempo tra allarme e salita: mediana ${med(anticipi).toFixed(1)} h (da ${Math.min(...anticipi).toFixed(1)} a ${Math.max(...anticipi).toFixed(1)})` : ''));
  }
  const ultimi = valutati.slice(-12);
  console.log('  ultimi allarmi (data, salita Fonzaso → salita Campo San Martino dopo):');
  for (const e of ultimi) console.log(`    ${fmt(e.t).slice(0, 16)}  +${e.r.toFixed(2)} m → +${e.p.toFixed(2)} m`);
}
// piene di Campo San Martino arrivate senza preavviso (regola a 0,5 m): nessun allarme nelle 3-16 ore prima
console.log('\nPIENE A CAMPO SAN MARTINO senza preavviso (salita di almeno 0,8 m su 24 ore, regola a 0,5 m):');
const piene = []; let ultima = -Infinity;
for (let i = 1; i < C.length - 1; i++) {
  const [t, v] = C[i];
  if (t - ultima < 36 * H) continue;
  if (v < C[i - 1][1] || v < C[i + 1][1]) continue;
  const mn = Math.min(...finestra(C, t - 24 * H, t));
  if (v - mn >= 0.8) { piene.push({ t, v, s: v - mn }); ultima = t; }
}
let con = 0, senza = 0;
for (const e of piene) {
  let trovato = false;
  for (let t = e.t - 16 * H; t <= e.t - 3 * H; t += 15 * 60000) { const r = salitaA(F, t); if (r != null && r >= 0.5) { trovato = true; break; } }
  if (trovato) con++; else { senza++; console.log(`  ${fmt(e.t).slice(0, 16)}  picco ${e.v.toFixed(2)} m, salita +${e.s.toFixed(2)} m: nessun preavviso`); }
}
console.log(`Piene totali ${piene.length}: con preavviso ${con}, senza ${senza}.`);
console.log('\nNota: dati automatici e non validati dell\'Osservatorio; Limena non è incluso. I conteggi dipendono dalla qualità dei dati di Fonzaso.');
