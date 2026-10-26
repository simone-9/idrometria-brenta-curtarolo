// Archivio storico dei dati ARPAV (livello, portata, pioggia) per calibrare in futuro la stima della piena.
// Uso: node scripts/archivio.mjs <idro.json> <cartella-archivio>
// Scrive file CSV mensili:  dati/<id-stazione>/AAAA-MM.csv  (istante UTC, livello_m, portata)  e  dati/pioggia-<id>/AAAA-MM.csv (istante UTC, pioggia_cumulata_mm).
// Aggiunge solo le letture nuove (stesso istante = si tiene la lettura più recente). Non archivia i dati dell'Osservatorio.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const [, , FILE, DIR] = process.argv;
if (!FILE || !DIR) { console.error('Uso: node scripts/archivio.mjs <idro.json> <cartella>'); process.exit(1); }
const j = JSON.parse(readFileSync(FILE, 'utf8'));
const iso = ms => new Date(ms).toISOString().slice(0, 16) + 'Z';
const mese = ms => new Date(ms).toISOString().slice(0, 7);
const cfgNome = {};
try { for (const s of JSON.parse(readFileSync('config/stazioni.json', 'utf8')).stazioni) cfgNome[s.id] = s.nome; } catch {}

// righe: Map istante → [valori…] raggruppate per file
function aggiorna(percorso, intestazione, nuove) {   // nuove: Map iso → array di colonne (stringhe)
  const mappa = new Map();
  if (existsSync(percorso)) {
    const righe = readFileSync(percorso, 'utf8').split('\n').slice(1).filter(Boolean);
    for (const r of righe) { const c = r.split(','); mappa.set(c[0], c.slice(1)); }
  }
  let cambiate = 0;
  for (const [t, col] of nuove) {
    const vecchio = mappa.get(t);
    const merge = (vecchio || []).map((v, i) => (col[i] !== '' && col[i] != null ? col[i] : v));
    col.forEach((v, i) => { if (merge[i] === undefined) merge[i] = v; });
    if (!vecchio || merge.join(',') !== vecchio.join(',')) { mappa.set(t, merge); cambiate++; }
  }
  if (!cambiate) return 0;
  mkdirSync(dirname(percorso), { recursive: true });
  const t = [...mappa.keys()].sort();
  writeFileSync(percorso, intestazione + '\n' + t.map(k => k + ',' + mappa.get(k).join(',')).join('\n') + '\n');
  return cambiate;
}

let totale = 0;
// livello + portata
for (const id of Object.keys(j.st || {})) {
  const s = j.st[id], per = {};
  const metti = (t, i, v) => { const m = mese(t); ((per[m] = per[m] || new Map()).get(iso(t)) || (per[m].set(iso(t), ['', '']), per[m].get(iso(t))))[i] = String(v); };
  (s.dati || []).forEach(([t, v]) => metti(t, 0, v));
  (s.q || []).forEach(([t, v]) => metti(t, 1, v));
  for (const m of Object.keys(per)) totale += aggiorna(join(DIR, 'dati', id, m + '.csv'), 'istante_utc,livello_m,portata_m3s', per[m]);
}
// pioggia (cumulata giornaliera, lettura ogni 30 minuti)
for (const id of Object.keys(j.pl || {})) {
  const per = {};
  for (const [t, v] of j.pl[id].dati || []) { const m = mese(t); (per[m] = per[m] || new Map()).set(iso(t), [String(v)]); }
  for (const m of Object.keys(per)) totale += aggiorna(join(DIR, 'dati', 'pioggia-' + id, m + '.csv'), 'istante_utc,pioggia_cumulata_mm', per[m]);
}
// indice leggibile con i nomi delle stazioni
const indice = { aggiornato: new Date().toISOString(), note: 'Orari in UTC. Dati ARPAV Veneto (CC BY 4.0), automatici e non validati. La pioggia è la cumulata giornaliera dalla mezzanotte solare.',
  stazioni: Object.fromEntries(Object.keys(j.st || {}).map(id => [id, (j.st[id].nome || cfgNome[id] || id)])),
  pluviometri: Object.fromEntries(Object.keys(j.pl || {}).map(id => [id, j.pl[id].nome || id])) };
mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, 'indice.json'), JSON.stringify(indice, null, 1));
console.log(`Archivio: ${totale} righe nuove o aggiornate.`);
