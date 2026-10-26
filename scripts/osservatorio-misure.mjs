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
const fine = new Date(), inizio = new Date(fine.getTime() - 24 * 3600000);
const risultato = {};
for (const [tipo, nome, stazioni] of [[2, 'PIOGGIA', PIOGGIA], [6, 'LIVELLO', LIVELLO]]) {
  const q = new URLSearchParams({ stationIDs: Object.keys(stazioni).join(','), startDate: fmt(inizio), endDate: fmt(fine), format: 'JSON' });
  try {
    const r = await chiama(`/api/measures/${tipo}?${q}`, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    risultato[nome] = r;
    const testo = JSON.stringify(r);
    console.log(`\n${nome} (tipo ${tipo}) · richiesta da ${fmt(inizio)} a ${fmt(fine)} (UTC) · ${testo.length} caratteri`);
    console.log('Inizio risposta: ' + testo.slice(0, 1200));
    console.log('Fine risposta: ' + testo.slice(-500));
  } catch (e) { console.log(`\n${nome} (tipo ${tipo}): errore ${e.message}`); }
}
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/misure-prova.json`, JSON.stringify(risultato, null, 1));
