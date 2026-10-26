// PROVA: scarica le ultime ore di pioggia (tipo 2) e livello (tipo 6) di alcune stazioni dell'Osservatorio Alpi Orientali
// e stampa nel log com'è fatta la risposta. NON pubblica nulla: serve solo a capire il formato dei dati.
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = (process.env.OSSERVATORIO_BASE || 'https://www.amicoalpiorientali.eu/CoDataService').replace(/\/$/, '');
const USER = process.env.OSSERVATORIO_USER, PASS = process.env.OSSERVATORIO_PASSWORD;
const OUT = process.env.OUT_DIR || 'out-osservatorio';
if (!USER || !PASS) { console.error('Mancano i segreti OSSERVATORIO_USER / OSSERVATORIO_PASSWORD.'); process.exit(1); }

const PIOGGIA = { 1174: 'Arsiè', 1167: 'Cismon del Grappa', 1172: 'San Nazario', 1157: 'Foza', 10179: 'Rubbio', 1198: 'Gallio Campomulo', 1206: 'Tresché Conca', 1200: 'Malga Portule' };
const LIVELLO = { 1154: 'Brenta a Campo San Martino', 1167: 'Cismon del Grappa', 1155: 'Cismon a Fonzaso', 1173: 'Valgadena a Valstagna' };

async function chiama(percorso, opz = {}) {
  let errore;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(BASE + percorso, { ...opz, signal: AbortSignal.timeout(90000) });
      const t = await r.text();
      if ([502, 503, 504].includes(r.status)) { errore = new Error(`${percorso.split('?')[0]}: risposta ${r.status}`); await new Promise(x => setTimeout(x, 5000 * (i + 1))); continue; }
      if (!r.ok) throw new Error(`${percorso.split('?')[0]}: risposta ${r.status} ${t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`);
      try { return JSON.parse(t); } catch { return t; }
    } catch (e) { if (/risposta 4\d\d/.test(String(e.message))) throw e; errore = e; await new Promise(x => setTimeout(x, 5000 * (i + 1))); }
  }
  throw errore;
}

const fd = new FormData(); fd.append('userName', USER); fd.append('password', PASS);
const risp = await chiama('/api/Auth/login', { method: 'POST', body: fd });
const token = String(typeof risp === 'string' ? risp : (risp.token || '')).replace(/^"|"$/g, '').replace(/^Bearer\s+/i, '').trim();
if (!token) { console.error('Token non ottenuto.'); process.exit(1); }
console.log('Login eseguito.');

const p2 = n => String(n).padStart(2, '0');
const fmt = d => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
const adesso = new Date();
const inizio = new Date(adesso.getTime() - 6 * 3600000), fine = new Date(adesso.getTime() + 4 * 3600000);   // finestra fino a 4 h nel futuro: mostra qual è l'ultimo dato disponibile
console.log(`Ora di esecuzione: ${adesso.toISOString()} (UTC) · richiesta da ${fmt(inizio)} a ${fmt(fine)} (le date sono interpretate dal servizio: si confronta con le ore restituite)`);
const H = { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } };
const risultato = {};
const riepilogo = (nome, r) => {
  if (!Array.isArray(r)) { console.log(nome + ': risposta non è un elenco: ' + JSON.stringify(r).slice(0, 300)); return; }
  const per = {};
  r.forEach(x => { (per[x.idstazione] = per[x.idstazione] || []).push(x); });
  Object.keys(per).forEach(id => {
    const d = per[id], u = d[d.length - 1], somma = d.reduce((a, x) => a + (+x.valore || 0), 0), max = d.reduce((a, x) => Math.max(a, +x.valore || 0), 0);
    console.log(`  stazione ${id}: ${d.length} letture, prima ${d[0].dataora}, ultima ${u.dataora} = ${u.valore} · somma ${somma.toFixed(3)} · massimo ${max}`);
  });
};
for (const [tipo, nome, stazioni, extra] of [[2, 'PIOGGIA al minuto', PIOGGIA, {}], [2, 'PIOGGIA aggregata per ORA', PIOGGIA, { aggregationInterval: 'HOUR' }], [6, 'LIVELLO', LIVELLO, {}]]) {
  const q = new URLSearchParams({ stationIDs: Object.keys(stazioni).join(','), startDate: fmt(inizio), endDate: fmt(fine), format: 'JSON', ...extra });
  try {
    const r = await chiama(`/api/measures/${tipo}?${q}`, H);
    risultato[nome] = r;
    console.log(`\n${nome} (tipo ${tipo})`);
    riepilogo(nome, r);
    if (extra.aggregationInterval) console.log('  esempio: ' + JSON.stringify(r).slice(0, 500));
  } catch (e) { console.log(`\n${nome}: errore ${e.message}`); }
}
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/misure-prova.json`, JSON.stringify(risultato, null, 1));
