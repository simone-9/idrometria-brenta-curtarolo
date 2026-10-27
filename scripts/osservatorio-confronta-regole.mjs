// CONFRONTO DI REGOLE DI PREAVVISO sullo storico: Fonzaso da solo, Fonzaso + altri livelli, Fonzaso + pioggia, pioggia da sola.
// Per ogni regola stampa quanti allarmi dà, quanti sono veri (salita a Campo San Martino entro 18 h) e quante piene coglie.
// Applica la stessa regola dell'app a tutta la storia di Fonzaso e conta quante volte la salita è stata seguita da una piena a Campo San Martino
// (veri allarmi), quante no (falsi allarmi) e quante piene sono arrivate senza preavviso. Stampa nel log solo un riassunto.
// 1) scopre da quando ci sono dati; 2) scarica a mesi i livelli di Campo San Martino, Cismon, Fonzaso e Valgadena;
// 3) trova le piene più alte a Campo San Martino e misura quanto prima sono saliti gli altri punti;
// 4) stampa nel log solo un RIASSUNTO. Non salva e non pubblica i dati scaricati.
// Segreti: OSSERVATORIO_USER, OSSERVATORIO_PASSWORD. Variabili: ANNI_MAX (default 8), PAUSA_MS (default 800).
const BASE = (process.env.OSSERVATORIO_BASE || 'https://www.amicoalpiorientali.eu/CoDataService').replace(/\/$/, '');
const USER = process.env.OSSERVATORIO_USER, PASS = process.env.OSSERVATORIO_PASSWORD;
const ANNI_MAX = +(process.env.ANNI_MAX || 8), PAUSA = +(process.env.PAUSA_MS || 800);
const LIMITE_MS = +(process.env.LIMITE_MIN || 110) * 60000, T0 = Date.now();
if (!USER || !PASS) { console.error('Mancano i segreti OSSERVATORIO_USER / OSSERVATORIO_PASSWORD.'); process.exit(1); }

const ST = { 1154: 'Brenta a Campo San Martino', 1167: 'Cismon del Grappa', 1155: 'Cismon a Fonzaso', 1173: 'Valgadena a Valstagna' };
const RIF = '1154';   // punto di riferimento: il più a valle (circa 5 km sopra Limena)
const pausa = ms => new Promise(r => setTimeout(r, ms));
const p2 = n => String(n).padStart(2, '0');
const fmt = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`; };
const dt = s => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s)); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : NaN; };   // restano in ora solare: nelle differenze non conta

const PST = { 1174: 'Arsiè', 1172: 'San Nazario', 1157: 'Foza', 10179: 'Rubbio', 1167: 'Cismon del Grappa', 1198: 'Gallio Campomulo', 1206: 'Tresché Conca', 1200: 'Malga Portule' };
const PIO = {}; for (const id of Object.keys(PST)) PIO[id] = new Map();   // pioggia oraria (mm) per stazione: ora (ms/3600000) -> mm
const VIVA = {};   // stazioni con almeno una lettura nel mese: 'YYYY-MM' -> Set di id
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
async function pioggia(da, a) {
  const q = new URLSearchParams({ stationIDs: Object.keys(PST).join(','), startDate: fmt(da), endDate: fmt(a), format: 'JSON' });
  let r;
  try { r = await chiama(`/api/measures/2?${q}`, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } }); }
  catch (e) { if (a - da > 3 * 86400000) { const m = Math.floor((da + a) / 2); await pioggia(da, m); await pioggia(m, a); return; } throw e; }
  if (!Array.isArray(r)) throw new Error('risposta pioggia non valida');
  for (const x of r) {
    const t = dt(x.dataora), v = +x.valore, id = x.idstazione;
    if (!isFinite(t) || !isFinite(v) || v < 0 || v > 50 || !PIO[id]) continue;
    const h = Math.floor(t / 3600000); PIO[id].set(h, (PIO[id].get(h) || 0) + v);
    const mk = new Date(t).toISOString().slice(0, 7); (VIVA[mk] = VIVA[mk] || new Set()).add(String(id));
  }
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
for (let y = anno - 7; y <= anno; y++) {
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
  try { await pioggia(a, b); } catch (e) { errori++; console.log(`  pioggia ${y}-${p2(m + 1)}: ${e.message}`); }
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
console.log('Ore con pioggia per stazione: ' + Object.keys(PST).map(id => `${PST[id]}=${PIO[id].size}`).join(' '));
console.log(`Mesi scaricati: ${mesi}, con errore: ${errori}. Letture per stazione: ` + Object.keys(ST).map(id => `${id}=${serie[id].length}`).join(' '));

// ---- 3) confronto delle regole ----
const H = 3600000, F = serie['1155'], C = serie[RIF], K = serie['1167'], V = serie['1173'];
if (F.length < 500 || C.length < 500) { console.log('Dati insufficienti.'); process.exit(0); }
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const fin = (s, da, a) => { const o = []; for (let i = lowerBound(s, da); i < s.length && s[i][0] <= a; i++) o.push(s[i][1]); return o; };
function lowerBound(s, t) { let lo = 0, hi = s.length; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m][0] < t) lo = m + 1; else hi = m; } return lo; }
function salitaA(s, t) { const ora = fin(s, t - H + 1, t), prima = fin(s, t - 6 * H, t - 3 * H); if (ora.length < 2 || prima.length < 4) return null; return med(ora) - med(prima); }
function piena(t) { const base = fin(C, t - 2 * H, t), dopo = fin(C, t, t + 18 * H); if (base.length < 4 || dopo.length < 8) return null; return Math.max(...dopo) - med(base); }
// pioggia: somma sulle ultime n ore per stazione; si usano le stazioni con dati nel mese (le ore senza letture contano zero)
function pioggiaA(t, n) {
  const h1 = Math.floor(t / H), viva = VIVA[new Date(t).toISOString().slice(0, 7)];
  if (!viva || viva.size < 3) return null;
  let somma = 0, max = 0;
  for (const id of viva) { let x = 0; for (let h = h1 - n + 1; h <= h1; h++) x += PIO[id].get(h) || 0; somma += x; if (x > max) max = x; }
  return { media: somma / viva.size, max };
}
const REGOLE = [
  ['Fonzaso sale ≥ 1,0 m', f => f.rF >= 1],
  ['Fonzaso sale ≥ 0,5 m', f => f.rF >= 0.5],
  ['Fonzaso ≥ 0,5 m E pioggia media 12 h ≥ 15 mm', f => f.rF >= 0.5 && f.p12 >= 15],
  ['Fonzaso ≥ 0,5 m E pioggia media 12 h ≥ 25 mm', f => f.rF >= 0.5 && f.p12 >= 25],
  ['Fonzaso ≥ 0,3 m E pioggia media 6 h ≥ 15 mm', f => f.rF >= 0.3 && f.p6 >= 15],
  ['Fonzaso ≥ 0,5 m E Cismon del Grappa ≥ 0,3 m', f => f.rF >= 0.5 && f.rK >= 0.3],
  ['Fonzaso ≥ 0,5 m E Valgadena ≥ 0,3 m', f => f.rF >= 0.5 && f.rV >= 0.3],
  ['Cismon del Grappa sale ≥ 0,5 m', f => f.rK >= 0.5],
  ['Cismon del Grappa ≥ 0,5 m E Valgadena ≥ 0,3 m', f => f.rK >= 0.5 && f.rV >= 0.3],
  ['Pioggia media 12 h ≥ 25 mm', f => f.p12 >= 25],
  ['Pioggia media 24 h ≥ 40 mm', f => f.p24 >= 40],
  ['Pioggia massima di una stazione in 6 h ≥ 40 mm', f => f.m6 >= 40],
  ['Fonzaso ≥ 1,0 m O pioggia media 12 h ≥ 35 mm', f => f.rF >= 1 || f.p12 >= 35],
  ['Fonzaso ≥ 0,5 m E (pioggia media 12 h ≥ 15 mm O Cismon ≥ 0,3 m)', f => f.rF >= 0.5 && (f.p12 >= 15 || f.rK >= 0.3)]
];
// piene di Campo San Martino (salita ≥ 0,8 m su 24 ore)
const piene = []; { let ultima = -Infinity;
  for (let i = 1; i < C.length - 1; i++) { const [t, v] = C[i]; if (t - ultima < 36 * H) continue; if (v < C[i - 1][1] || v < C[i + 1][1]) continue;
    const mn = Math.min(...fin(C, t - 24 * H, t)); if (v - mn >= 0.8) { piene.push({ t, v, s: v - mn, colte: [] }); ultima = t; } } }
const t0 = Math.max(F[0][0], C[0][0]) + 24 * H, t1 = Math.min(F[F.length - 1][0], C[C.length - 1][0]) - 18 * H;
const anniTot = (t1 - t0) / (365.25 * 24 * H);
const stato = REGOLE.map(() => ({ attivo: false, libero: 0, ep: [] }));
let passi = 0, base05 = 0, base10 = 0, validi = 0, senzaPioggia = 0;
for (let t = t0; t <= t1; t += 15 * 60000) {
  const p = pioggiaA(t, 6); if (!p) senzaPioggia++;
  const f = { rF: salitaA(F, t), rK: salitaA(K, t), rV: salitaA(V, t), p6: p ? p.media : null, m6: p ? p.max : null };
  const p12 = pioggiaA(t, 12), p24 = pioggiaA(t, 24); f.p12 = p12 ? p12.media : null; f.p24 = p24 ? p24.media : null;
  for (const k of ['rF', 'rK', 'rV', 'p6', 'm6', 'p12', 'p24']) if (f[k] == null) f[k] = -Infinity;   // dato mancante: la condizione non scatta
  if (passi++ % 4 === 0) { const pn = piena(t); if (pn != null) { validi++; if (pn >= 0.5) base05++; if (pn >= 1) base10++; } }
  REGOLE.forEach(([nome, fn], i) => {
    const st = stato[i], on = fn(f);
    if (on) { st.libero = 0; if (!st.attivo) { st.attivo = true; st.ep.push({ t, p: piena(t) }); } }
    else if (st.attivo && ++st.libero >= 12) st.attivo = false;   // si riarma dopo 3 ore senza condizione
  });
}
console.log(`\nPERIODO ANALIZZATO: ${fmt(t0).slice(0, 10)} → ${fmt(t1).slice(0, 10)} (${anniTot.toFixed(1)} anni). Istanti senza dati di pioggia utilizzabili: ${Math.round(100 * senzaPioggia / passi)}%.`);
console.log(`A CASO (un istante qualsiasi): salita ≥ 0,5 m a Campo San Martino nelle 18 h successive ${Math.round(100 * base05 / validi)}% dei casi; ≥ 1 m ${Math.round(100 * base10 / validi)}%.`);
console.log(`PIENE di riferimento (salita ≥ 0,8 m su 24 h): ${piene.length}.\n`);
console.log('N. | regola | allarmi/anno | veri (≥0,5 m) | veri (≥1 m) | piene colte | anticipo');
REGOLE.forEach(([nome], i) => {
  const ev = stato[i].ep.filter(e => e.p != null), n = ev.length;
  const h05 = ev.filter(e => e.p >= 0.5).length, h10 = ev.filter(e => e.p >= 1).length;
  let colte = 0; const lead = [];
  for (const pi of piene) { const e = stato[i].ep.filter(x => x.t >= pi.t - 16 * H && x.t <= pi.t - 1 * H).sort((a, b) => a.t - b.t)[0]; if (e) { colte++; pi.colte.push(i + 1); lead.push((pi.t - e.t) / H); } }
  console.log(`${String(i + 1).padStart(2)} | ${nome} | ${(n / anniTot).toFixed(1)} | ${h05}/${n} (${n ? Math.round(100 * h05 / n) : 0}%) | ${h10}/${n} (${n ? Math.round(100 * h10 / n) : 0}%) | ${colte}/${piene.length} | ${lead.length ? 'picco ' + med(lead).toFixed(1) + ' h dopo' : '-'}`);
});
console.log('\nPIENE E REGOLE CHE LE HANNO COLTE (numeri della tabella):');
for (const pi of piene) console.log(`  ${fmt(pi.t).slice(0, 16)}  picco ${pi.v.toFixed(2)} m, salita +${pi.s.toFixed(2)} m: ${pi.colte.length ? pi.colte.join(', ') : 'nessuna'}`);
console.log('\nNota: dati automatici non validati; la pioggia usa solo le stazioni attive nel mese e conta zero nelle ore senza letture. Limena non è incluso. Un buon preavviso ha pochi allarmi/anno, molti «veri» e molte piene colte.');
