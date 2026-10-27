// Analisi dell'archivio ARPAV (ramo "archivio"): copertura dei dati e, quando ci sono abbastanza piene,
// tempo di viaggio Barzizza → Limena e coefficiente da inserire nelle «Impostazioni della stima» dell'app.
// Uso: node scripts/analisi-archivio.mjs <cartella-archivio>
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv[2] || 'archivio';
const MONTE = '300005751', VALLE = '300005777';   // Barzizza e Limena
const H = 3600000;
if (!existsSync(join(DIR, 'dati'))) { console.log('Archivio vuoto o non trovato: ' + DIR); process.exit(0); }
let nomi = {}; try { nomi = JSON.parse(readFileSync(join(DIR, 'indice.json'), 'utf8')).stazioni || {}; } catch {}

function carica(id) {   // → { liv: [[t,v]], q: [[t,v]] } ordinati
  const cart = join(DIR, 'dati', id);
  const liv = [], q = [];
  if (!existsSync(cart)) return { liv, q };
  for (const f of readdirSync(cart).filter(x => x.endsWith('.csv')).sort()) {
    for (const r of readFileSync(join(cart, f), 'utf8').split('\n').slice(1)) {
      if (!r) continue;
      const [t, l, p] = r.split(',');
      const ms = Date.parse(t.replace('Z', ':00Z'));
      if (!isFinite(ms)) continue;
      if (l !== '' && isFinite(+l)) liv.push([ms, +l]);
      if (p !== undefined && p !== '' && isFinite(+p)) q.push([ms, +p]);
    }
  }
  liv.sort((a, b) => a[0] - b[0]); q.sort((a, b) => a[0] - b[0]);
  return { liv, q };
}
const mediana = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
function pulisci(s) {   // fuori scala e picchi isolati
  const a = s.filter(p => p[1] >= -0.3 && p[1] <= 8);
  return a.filter((p, i) => Math.abs(p[1] - mediana(a.slice(Math.max(0, i - 3), i + 4).map(x => x[1]))) <= 0.6);
}
const iso = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

// ---- 1) copertura ----
console.log('COPERTURA DELL\'ARCHIVIO (livello):');
const ids = readdirSync(join(DIR, 'dati')).filter(x => !x.startsWith('pioggia-'));
const dati = {};
for (const id of ids) {
  const d = carica(id); dati[id] = d;
  if (!d.liv.length) { console.log(`- ${nomi[id] || id}: nessuna lettura di livello`); continue; }
  let buchi = 0, maxBuco = 0;
  for (let i = 1; i < d.liv.length; i++) { const g = d.liv[i][0] - d.liv[i - 1][0]; if (g > 2 * H) { buchi++; maxBuco = Math.max(maxBuco, g / H); } }
  const giorni = (d.liv[d.liv.length - 1][0] - d.liv[0][0]) / 86400000;
  console.log(`- ${nomi[id] || id}: ${d.liv.length} letture da ${iso(d.liv[0][0])} a ${iso(d.liv[d.liv.length - 1][0])} (${giorni.toFixed(1)} giorni), buchi oltre 2 h: ${buchi}${buchi ? ` (il più lungo ${maxBuco.toFixed(0)} h)` : ''}, con portata: ${d.q.length}`);
}
const m = pulisci((dati[MONTE] || { liv: [] }).liv), v = pulisci((dati[VALLE] || { liv: [] }).liv);
if (m.length < 100 || v.length < 100) { console.log('\nDati insufficienti a Barzizza o Limena per l\'analisi.'); process.exit(0); }

// ---- 2) piene a Barzizza ----
const maxIn = (s, da, a) => { let b = null; for (const p of s) { if (p[0] < da) continue; if (p[0] > a) break; if (!b || p[1] > b[1]) b = p; } return b; };
const minIn = (s, da, a) => { let b = null; for (const p of s) { if (p[0] < da) continue; if (p[0] > a) break; if (!b || p[1] < b[1]) b = p; } return b; };
const meta = (s, tMin, tPk, vMin, vPk) => { const so = vMin + 0.5 * (vPk - vMin); for (const p of s) { if (p[0] < tMin) continue; if (p[0] > tPk) break; if (p[1] >= so) return p[0]; } return null; };
const SALITA_MIN = +(process.env.SALITA_MIN || 0.4);   // m di salita a Barzizza perché una piena sia considerata
const eventi = [];
for (let i = 1; i < m.length - 1; i++) {
  const [t, lv] = m[i];
  if (lv < m[i - 1][1] || lv < m[i + 1][1]) continue;
  const vic = maxIn(m, t - 24 * H, t + 24 * H);
  if (!vic || vic[0] !== t) continue;
  const mn = minIn(m, t - 48 * H, t);
  if (mn && lv - mn[1] >= SALITA_MIN) eventi.push({ t, lv, salita: lv - mn[1], t0: mn[0], v0: mn[1] });
}
console.log(`\nPIENE A BARZIZZA con salita ≥ ${SALITA_MIN} m: ${eventi.length}`);
const lagPk = [], lagMeta = [], coppie = [];
for (const e of eventi) {
  const pkV = maxIn(v, e.t - 2 * H, e.t + 24 * H);
  const mnV = pkV && minIn(v, e.t0 - 6 * H, pkV[0]);
  if (!pkV || !mnV) { console.log(`${iso(e.t)}  Barzizza picco ${e.lv.toFixed(2)} m (+${e.salita.toFixed(2)}): Limena n.d.`); continue; }
  const salV = pkV[1] - mnV[1];
  if (salV < 0.15) { console.log(`${iso(e.t)}  Barzizza picco ${e.lv.toFixed(2)} m (+${e.salita.toFixed(2)}): a Limena la salita è troppo piccola (${salV.toFixed(2)} m)`); continue; }
  const tm = meta(m, e.t0, e.t, e.v0, e.lv), tv = meta(v, mnV[0], pkV[0], mnV[1], pkV[1]);
  const lp = (pkV[0] - e.t) / H, lm = tm != null && tv != null ? (tv - tm) / H : null;
  lagPk.push(lp); if (lm != null) lagMeta.push(lm);
  coppie.push([e.salita, salV]);
  console.log(`${iso(e.t)}  Barzizza picco ${e.lv.toFixed(2)} m (+${e.salita.toFixed(2)})  →  Limena picco ${pkV[1].toFixed(2)} m (+${salV.toFixed(2)})  ritardo picco ${lp.toFixed(1)} h, ritardo metà salita ${lm == null ? 'n.d.' : lm.toFixed(1) + ' h'}`);
}

// ---- 3) risultato ----
console.log('\nRISULTATO');
if (coppie.length < 5) {
  console.log(`Piene utilizzabili: ${coppie.length}. Ne servono almeno 5 per dare un valore: per ora la stima non va tarata, lasciala spenta. Continua ad accumulare dati.`);
  process.exit(0);
}
const lagM = mediana(lagMeta), lagP = mediana(lagPk);
// coefficiente k: pendenza di regressione per l'origine (salita Limena ≈ k × salita Barzizza)
const k = coppie.reduce((s, [x, y]) => s + x * y, 0) / coppie.reduce((s, [x]) => s + x * x, 0);
const rapporti = coppie.map(([x, y]) => y / x);
const q1 = [...lagMeta].sort((a, b) => a - b)[Math.floor(lagMeta.length * 0.25)], q3 = [...lagMeta].sort((a, b) => a - b)[Math.floor(lagMeta.length * 0.75)];
console.log(`Piene utilizzabili: ${coppie.length}`);
console.log(`Tempo di viaggio Barzizza → Limena: mediana ${lagM == null ? 'n.d.' : lagM.toFixed(1) + ' h (metà salita)'}, ${lagP.toFixed(1)} h (picco); tra il 25° e il 75° percentile: ${q1 == null ? 'n.d.' : q1.toFixed(1) + '-' + q3.toFixed(1) + ' h'}`);
console.log(`Coefficiente k (salita a Limena / salita a Barzizza): ${k.toFixed(2)}; rapporto mediano ${mediana(rapporti).toFixed(2)}, da ${Math.min(...rapporti).toFixed(2)} a ${Math.max(...rapporti).toFixed(2)}`);
console.log(`\nIMPOSTAZIONI SUGGERITE per l'app: tempo di viaggio ${lagM == null ? lagP.toFixed(1) : lagM.toFixed(1)} ore, coefficiente ${k.toFixed(2)}.`);
console.log('Se la dispersione è ampia (intervallo largo, rapporti molto diversi) la stima resta indicativa. Dati ARPAV automatici e non validati.');
