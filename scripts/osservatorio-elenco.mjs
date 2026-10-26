// Elenco reti, stazioni e sensori dell'API "Export Data" dell'Osservatorio delle Alpi Orientali.
// Serve a capire quali stazioni (pioggia/livello) ci sono vicino al bacino del Brenta. Non scrive nulla sul servizio.
// Credenziali: segreti OSSERVATORIO_USER e OSSERVATORIO_PASSWORD (mai nel codice, mai nel log).
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = (process.env.OSSERVATORIO_BASE || 'https://www.amicoalpiorientali.eu/CoDataService').replace(/\/$/, '');
const USER = process.env.OSSERVATORIO_USER, PASS = process.env.OSSERVATORIO_PASSWORD;
const OUT = process.env.OUT_DIR || 'out-osservatorio';
// riquadro approssimativo del bacino del Brenta (Valsugana, Grappa, Bassano, Curtarolo)
const BOX = { latMin: 45.35, latMax: 46.25, lonMin: 11.15, lonMax: 12.0 };
if (!USER || !PASS) { console.error('Mancano i segreti OSSERVATORIO_USER / OSSERVATORIO_PASSWORD.'); process.exit(1); }

async function chiama(percorso, opz = {}) {
  let errore;
  for (let i = 0; i < 4; i++) {   // 502/503/504 possono essere momentanei: si riprova con pause crescenti
    try {
      const r = await fetch(BASE + percorso, { ...opz, signal: AbortSignal.timeout(60000) });
      const t = await r.text();
      if ([502, 503, 504].includes(r.status)) { errore = new Error(`${percorso}: risposta ${r.status} (tentativo ${i + 1} di 4)`); await new Promise(x => setTimeout(x, 5000 * (i + 1))); continue; }
      if (!r.ok) throw new Error(`${percorso}: risposta ${r.status} ${t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 150)}`);
      try { return JSON.parse(t); } catch { return t; }
    } catch (e) { if (/risposta 4\d\d/.test(String(e.message))) throw e; errore = e; await new Promise(x => setTimeout(x, 5000 * (i + 1))); }
  }
  throw errore;
}
const get = (p, tok) => chiama(p, { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' } });

const fd = new FormData(); fd.append('userName', USER); fd.append('password', PASS);
const risp = await chiama('/api/Auth/login', { method: 'POST', body: fd });
let token = typeof risp === 'string' ? risp.replace(/^"|"$/g, '') : (risp.token || risp.accessToken || risp.access_token || risp.jwt || '');
token = String(token).replace(/^Bearer\s+/i, '').trim();   // il servizio risponde già «Bearer <token>»
if (!token) { console.error('Login riuscito ma token non riconosciuto. Chiavi della risposta: ' + (typeof risp === 'object' ? Object.keys(risp).join(', ') : typeof risp)); process.exit(1); }
console.log('Login eseguito.');

const num = x => { const n = parseFloat(String(x).replace(',', '.')); return isFinite(n) ? n : null; };
const campo = (o, nomi) => { for (const k of Object.keys(o || {})) if (nomi.includes(k.toLowerCase())) return o[k]; return undefined; };
const coord = s => ({ lat: num(campo(s, ['lat', 'latitude', 'latitudine', 'y'])), lon: num(campo(s, ['lon', 'lng', 'longitude', 'longitudine', 'x'])) });
const dentro = c => c.lat != null && c.lon != null && c.lat >= BOX.latMin && c.lat <= BOX.latMax && c.lon >= BOX.lonMin && c.lon <= BOX.lonMax;

const tipi = await get('/api/measures', token).catch(e => { console.log('Tipi di misura non letti: ' + e.message); return []; });
console.log('TIPI DI MISURA (id → nome):');
console.log(JSON.stringify(tipi).slice(0, 3000));

const reti = await get('/api/networks', token);
console.log(`\nRETI: ${Array.isArray(reti) ? reti.length : '?'}`);
const risultato = { tipi, reti: [], nelBacino: [], tutte: [] };
for (const rete of Array.isArray(reti) ? reti : []) {
  const id = campo(rete, ['id', 'idrete', 'networkid']);
  const nome = campo(rete, ['name', 'nome', 'description', 'descrizione', 'networkname', 'nomerete']) ?? JSON.stringify(rete).slice(0, 120);
  let stazioni = [];
  try { stazioni = await get(`/api/networks/${id}/stations`, token); } catch (e) { console.log(`Rete ${id} (${nome}): stazioni non lette: ${e.message}`); }
  stazioni = Array.isArray(stazioni) ? stazioni : [];
  if (stazioni.length) { console.log('  Esempio di stazione (campi disponibili): ' + JSON.stringify(stazioni[0]).slice(0, 700)); risultato.tutte = stazioni; }
  console.log(`- rete ${id} «${nome}»: ${stazioni.length} stazioni`);
  risultato.reti.push({ id, nome, stazioni: stazioni.length });
  for (const s of stazioni) {
    const c = coord(s);
    if (!dentro(c)) continue;
    const sid = campo(s, ['id', 'idstazione', 'stationid']);
    let sens = [];
    try { sens = await get(`/api/stations/${sid}/sensors`, token); } catch (e) { sens = [{ errore: e.message }]; }
    risultato.nelBacino.push({ rete: nome, stazione: s, sensori: sens });
  }
}
console.log(`\nSTAZIONI NEL RIQUADRO DEL BRENTA: ${risultato.nelBacino.length}`);
for (const x of risultato.nelBacino) {
  const s = x.stazione, c = coord(s);
  const nome = campo(s, ['name', 'nome', 'description', 'descrizione']);
  console.log(`* ${nome} (id ${campo(s, ['id', 'idstazione', 'stationid'])}) rete «${x.rete}» lat ${c.lat} lon ${c.lon} · sensori: ${JSON.stringify(x.sensori).slice(0, 400)}`);
}
if (!risultato.nelBacino.length && Array.isArray(reti) && reti.length) console.log('Nessuna stazione nel riquadro: forse i nomi dei campi coordinate sono diversi. Vedi il file elenco.json negli artefatti.');
console.log('\nTUTTE LE STAZIONI (nome · id · coordinate se presenti):');
console.log((risultato.tutte || []).map(x => { const c = coord(x); return `${campo(x, ['name', 'nome', 'description', 'descrizione', 'stationname']) ?? '?'} · ${campo(x, ['id', 'idstazione', 'stationid']) ?? '?'}${c.lat != null ? ` · ${c.lat},${c.lon}` : ''}`; }).join('\n'));
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/elenco.json`, JSON.stringify(risultato, null, 1));
