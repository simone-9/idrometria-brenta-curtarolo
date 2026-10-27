// Scarica lo STORICO ORARIO ARPAV (ambienteveneto.it) di Barzizza e Limena e lo scrive nel formato dell'archivio,
// così lo legge scripts/analisi-archivio.mjs (copertura, piene, tempo di viaggio Barzizza → Limena, coefficiente).
// Uso: node scripts/scarica-ambienteveneto.mjs <cartella-uscita> [anni]     (anni: quanti anni indietro, default 6)
// Non salva né pubblica nulla: la cartella serve solo all'analisi nello stesso flusso.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] || 'storico';
const ANNI = Math.max(1, +(process.argv[3] || process.env.ANNI || 6));
const BASE = process.env.AMBIENTEVENETO_URL || 'https://www.ambienteveneto.it/datiorari/getXmlSensore.php';
// codice sul sito -> codice usato dall'app e dall'analisi
const STAZIONI = { 5751: ['300005751', 'Brenta a Barzizza (Bassano del Grappa)'], 5777: ['300005777', 'Brenta a Limena (Curtarolo)'] };
const pausa = ms => new Promise(r => setTimeout(r, ms));
const num = s => { const v = parseFloat(String(s ?? '').replace(',', '.')); return isFinite(v) ? v : null; };   // ">>" e vuoti = nessun dato

async function scarica(cd, an) {
  const url = `${BASE}?cd=${cd}&an=${an}&csv`;
  let err;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'idrometria-protezione-civile-curtarolo' }, signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw new Error('risposta ' + r.status);
      return await r.text();
    } catch (e) { err = e; await pausa(4000 * (i + 1)); }
  }
  throw new Error(`${url}: ${err && err.message ? err.message : err}`);
}

// righe "IDSTAZIONE;GIORNO;MESE;ANNO;ORA;LIVIDRO_MIN;LIVIDRO_MED;LIVIDRO_MAX;PORT_MIN;PORT_MED;PORT_MAX" (ora solare, ora di fine intervallo)
function leggi(testo, cd, an) {
  const righe = testo.split(/\r?\n/).filter(x => x.trim());
  if (!righe.length) return [];
  if (/<html|<!doctype/i.test(righe[0] + (righe[1] || ''))) throw new Error(`cd=${cd} an=${an}: risposta non CSV (${righe[0].slice(0, 80)})`);
  const out = [];
  for (const r of righe) {
    const c = r.split(';');
    if (c.length < 8 || !/^\d+$/.test(c[1].trim())) continue;   // intestazione o righe non dati
    const [g, m, a, h] = [c[1], c[2], c[3], c[4]].map(x => parseInt(x, 10));
    const liv = num(c[6]), q = num(c[9]);
    if (![g, m, a, h].every(isFinite) || (liv == null && q == null)) continue;
    const t = Date.UTC(a, m - 1, g, h) - 3600000;   // ora solare (UTC+1) → UTC
    out.push([t, liv, q]);
  }
  return out;
}

const anno = new Date().getUTCFullYear();
const indice = { stazioni: {} };
for (const [cd, [id, nome]] of Object.entries(STAZIONI)) {
  indice.stazioni[id] = nome;
  const righe = [];
  for (let an = anno - ANNI + 1; an <= anno; an++) {
    try {
      const d = leggi(await scarica(cd, an), cd, an);
      console.log(`${nome} ${an}: ${d.length} ore`);
      for (const x of d) righe.push(x);
    } catch (e) { console.log(`::warning::${nome} ${an}: ${e.message}`); }
    await pausa(700);
  }
  if (!righe.length) { console.log(`::error::Nessun dato scaricato per ${nome}: indirizzo o formato diversi da quelli attesi.`); process.exitCode = 1; }
  const cart = join(OUT, 'dati', id); mkdirSync(cart, { recursive: true });
  const per = {};   // un file per anno, nel formato dell'archivio: "AAAA-MM-GGThh:mmZ,livello,portata"
  for (const [t, l, q] of righe.sort((a, b) => a[0] - b[0])) {
    const iso = new Date(t).toISOString().slice(0, 16) + 'Z';
    (per[iso.slice(0, 4)] = per[iso.slice(0, 4)] || ['istante,livello,portata']).push(`${iso},${l ?? ''},${q ?? ''}`);
  }
  for (const [a, r] of Object.entries(per)) writeFileSync(join(cart, a + '.csv'), r.join('\n') + '\n');
}
writeFileSync(join(OUT, 'indice.json'), JSON.stringify(indice));
