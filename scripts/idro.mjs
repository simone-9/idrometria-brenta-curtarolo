// Idrometria Brenta: scarica i dati ARPAV, pubblica un JSON per l'app e avvisa su Telegram
// quando le stazioni di allerta superano la soglia di guardia G2 o G3.
// Nessuna dipendenza: richiede solo Node 20.
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inviaPush, chiaveServizio, leggiCollezione, scriviDocumento } from './push.mjs';

const SORGENTE = process.env.IDRO_SOURCE_URL || 'https://www.arpa.veneto.it/api/risorse/data-meteo/xml/Ultime48ore.xml';
const FILE_PROVA = process.env.IDRO_SOURCE_FILE || '';
const OUT = process.env.OUT_DIR || 'out';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = process.env.TELEGRAM_CHAT_ID || '';
const DRY = process.env.TELEGRAM_DRY_RUN === '1';
const PROVA_PUSH = process.env.TEST_PUSH === '1';   // avvio manuale con «prova_push»: invia solo una notifica push di prova
const PROVA = process.env.TEST_MESSAGGIO === '1';   // avvio manuale con «prova»: invia un messaggio di test e non tocca lo stato degli avvisi
const PAGINA_GENERICA = 'https://www.arpa.veneto.it/dati-ambientali/dati-in-diretta/meteo-idro-nivo/idro_prec';
const cfg = JSON.parse(readFileSync('config/stazioni.json', 'utf8'));

const num = x => parseFloat(String(x).replace(',', '.'));
// ARPAV pubblica in orario solare (UTC+1 fisso)
const tempo = s => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)) - 3600000;
const m2 = v => v.toFixed(2).replace('.', ',') + ' m';
const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function oraLocale(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.hour}:${p.minute} del ${p.day}/${p.month}/${p.year}`;
}

async function scarica() {
  if (FILE_PROVA) return readFileSync(FILE_PROVA, 'utf8');
  let errore;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(SORGENTE, { headers: { 'User-Agent': 'idrometria-protezione-civile-curtarolo' }, signal: AbortSignal.timeout(45000) });
      if (!r.ok) throw new Error('risposta ' + r.status);
      const t = await r.text();
      if (!/<SENSORE>/.test(t)) throw new Error('risposta non valida');
      return t;
    } catch (e) { errore = e; await new Promise(r => setTimeout(r, 4000)); }
  }
  throw errore;
}

function sensore(xml, id) {
  const m = new RegExp('<ID>\\s*' + id + '\\s*</ID>').exec(xml);
  if (!m) return null;
  const fine = xml.indexOf('</SENSORE>', m.index);
  const ch = xml.slice(m.index, fine < 0 ? undefined : fine);
  const g = n => { const x = new RegExp('<GUARDIA' + n + '>\\s*([-\\d.,]+)').exec(ch); return x ? num(x[1]) : null; };
  const dati = [], re = /<DATI\s+ISTANTE="(\d{12})"\s*>\s*<VM>\s*([-\d.,]+)\s*<\/VM>/g;
  let d;
  while ((d = re.exec(ch))) { const v = num(d[2]); if (isFinite(v)) dati.push([tempo(d[1]), v]); }
  dati.sort((a, b) => a[0] - b[0]);
  const u = /<UNITNM>\s*(?:<!\[CDATA\[)?\s*([^<\]\s][^<\]]*)/.exec(ch);
  return { g: [g(1), g(2), g(3)], dati, unita: u ? u[1].trim() : '' };
}

function leggi(xml) {
  const run = ((/<ISTANTERUN>\s*(\d{12})/.exec(xml)) || [])[1] || '';
  const st = {};
  for (const s of cfg.stazioni) {
    const l = sensore(xml, s.id);
    if (!l) continue;
    const q = s.portata ? sensore(xml, s.portata) : null;
    st[s.id] = { nome: s.nome, g: l.g, dati: l.dati, q: q ? q.dati : [], qu: q ? (q.unita || 'm³/s').replace('m3', 'm³') : '' };
  }
  // pluviometri: pioggia cumulata (mm) dalla mezzanotte solare, ogni 30 minuti
  const pl = {};
  for (const s of cfg.pluviometri || []) {
    const l = sensore(xml, s.id);
    if (l) pl[s.id] = { nome: s.nome, dati: l.dati };
  }
  return { run, st, pl };
}

const portataRiga = d => {
  if (!d.q || !d.q.length) return '';
  const [tq, vq] = d.q[d.q.length - 1];
  return `💧 Portata: <b>${vq.toFixed(1).replace('.', ',')} ${esc(d.qu || 'm³/s')}</b> (ore ${oraLocale(tq).split(' del ')[0]})\n`;
};
const livello = (v, g) => { let l = 0; g.forEach((x, i) => { if (x != null && v >= x) l = i + 1; }); return l; };

async function telegram(testo) {
  if (DRY) { console.log('--- MESSAGGIO TELEGRAM (prova) ---\n' + testo + '\n----------------------------------'); return true; }
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text: testo, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  if (!r.ok) { console.log('::error::Telegram ha risposto ' + r.status + ' ' + (await r.text()).slice(0, 200)); return false; }
  return true;
}


// ---------- Bollettino di vigilanza meteorologica (CFD Veneto): classi di pioggia per zona ----------
const CFD_URL = 'https://www.regione.veneto.it/web/protezione-civile/cfd';
const CLASSI_PIOGGIA = { '-': 'assente', '1': '<10 mm', '2': '10-30 mm', '3': '30-60 mm', '4': '>60 mm' };
const MESI = { gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6, luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12 };

async function pdfBollettino() {
  if (process.env.BVM_SOURCE_FILE) return { buf: readFileSync(process.env.BVM_SOURCE_FILE), url: '' };
  const h = { 'User-Agent': 'idrometria-protezione-civile-curtarolo' };
  const pagina = await (await fetch(CFD_URL, { headers: h, signal: AbortSignal.timeout(45000) })).text();
  // il nome del file può essere seguito da altro nell'indirizzo (es. ".pdf/codice?t=..."): si cerca BVM_aammgg (bollettino) o AVM_aammgg (avviso) ovunque nel link
  const link = [...pagina.matchAll(/href=["']([^"']*(?:BVM|AVM)_(\d{6})[^"']*)["']/gi)].map(m => ({ url: new URL(m[1].replace(/&amp;/g, '&'), CFD_URL).href, d: m[2], avviso: /AVM_/i.test(m[1]) }));
  if (!link.length) {
    const visti = [...pagina.matchAll(/href=["']([^"']*(?:\.pdf|documents|vigilanza)[^"']*)["']/gi)].map(m => m[1]);
    console.log(`::warning::Pagina CFD letta (${pagina.length} caratteri), link a documenti/PDF visti: ${visti.length}. Esempi: ${visti.slice(0, 8).join(' | ') || 'nessuno'}`);
    throw new Error('nessun bollettino/avviso BVM/AVM trovato nella pagina del CFD');
  }
  link.sort((a, b) => a.d.localeCompare(b.d) || (a.avviso - b.avviso));   // il più recente; a parità di data l'avviso (aggiorna il bollettino)
  const l = link[link.length - 1];
  const r = await fetch(l.url, { headers: h, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('bollettino: risposta ' + r.status);
  return { buf: Buffer.from(await r.arrayBuffer()), url: l.url };
}
function testoPdf(buf) {
  const f = join(mkdtempSync(join(tmpdir(), 'bvm-')), 'b.pdf');
  writeFileSync(f, buf);
  return execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8', maxBuffer: 20e6 });
}
// Colonne della tabella dei fenomeni (posizione del primo carattere nel testo "-layout" e nome): il resto della riga di ogni zona si assegna alla colonna più vicina
const COLONNE_FEN = [[13, 'pioggia'], [25, 'temporali'], [39, 'temporaliForti'], [50, 'neve<100'], [62, 'neve100-500'], [73, 'neve500-1500'], [84, 'neve1500-2000'], [98, 'ghiaccio'], [116, 'vento<500'], [136, 'vento500-1500'], [155, 'vento1500-2500'], [172, 'caldo']];
// Fenomeni previsti per una zona (escluse pioggia e valori "-"): [[colonna, livello, testo]]. Se la riga non si legge bene torna [] (mai valori inventati)
function fenomeniZona(sez, id) {
  const righe = sez.split('\n');
  const i = righe.findIndex(r => new RegExp('^[ \\t]*' + id + '[ \\t]').test(r));
  if (i < 0) return [];
  const r1 = righe[i], r2 = righe[i + 1] || '';
  const toc = [];
  for (const m of r1.slice(0, 200).matchAll(/(?<!\S)\S+/g)) {
    if (m.index < 8) continue;                                  // la sigla della zona
    let best = null;
    for (const c of COLONNE_FEN) { const d = Math.abs(c[0] - m.index); if (d <= 7 && (!best || d < best.d)) best = { d, k: c[1] }; }
    if (best) toc.push({ k: best.k, v: m[0], x: m.index + m[0].length / 2, t: '' });
  }
  if (!toc.length) return [];
  for (const s of r2.matchAll(/\S+(?: \S+)*/g)) {               // segmenti di testo separati da almeno due spazi
    const cx = s.index + s[0].length / 2;
    let best = null;
    for (const o of toc) { const d = Math.abs(o.x - cx); if (d <= 9 && (!best || d < best.d)) best = { d, o }; }
    if (best) best.o.t = (best.o.t ? best.o.t + ' ' : '') + s[0].replace(/\s+/g, ' ').trim();
  }
  return toc.filter(o => o.k !== 'pioggia' && o.v !== '-' && /^\d+$/.test(o.v)).map(o => [o.k, o.v, o.t]);
}
function leggiBollettino(t, zone) {
  const doc = /Documento n\.\s*(\d+)\s*\/\s*(\d{4})/.exec(t);
  const emissione = ((/Emissione:\s*([^\n\r]+)/.exec(t) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const teste = [...t.matchAll(/FENOMENI METEOROLOGICI PREVISTI PER\s+(OGGI|DOMANI)\s*-\s*([^\n\r]+)/g)];
  if (!teste.length) throw new Error('struttura del bollettino non riconosciuta');
  const giorni = teste.map((h, i) => {
    const iniz = h.index, fineProssimo = i + 1 < teste.length ? teste[i + 1].index : -1;
    const fineTesto = t.indexOf('FENOMENI PREVISTI', iniz);
    const fine = fineProssimo > 0 ? fineProssimo : (fineTesto > 0 ? fineTesto : t.length);
    const sez = t.slice(iniz, fine);
    const d = /(\d{1,2})\s+([A-Za-zàèéìòù]+)\s+(\d{4})/.exec(h[2]);
    const mese = d ? MESI[d[2].toLowerCase()] : 0;
    if (!d || !mese) throw new Error('data del bollettino non riconosciuta');
    const z = {}, fen = {};
    for (const x of zone) {
      try { fen[x.id] = fenomeniZona(sez, x.id); } catch { fen[x.id] = []; }
      const m = new RegExp('^[ \\t]*' + x.id + '[ \\t]+(\\S+)', 'm').exec(sez);
      z[x.id] = m && Object.prototype.hasOwnProperty.call(CLASSI_PIOGGIA, m[1]) ? m[1] : null;   // mai un valore inventato: se non si legge resta null
    }
    return { quando: h[1], iso: `${d[3]}-${String(mese).padStart(2, '0')}-${String(+d[1]).padStart(2, '0')}`, etichetta: h[2].trim().toLowerCase(), zone: z, fen };
  });
  if (giorni.every(g => Object.values(g.zone).every(v => v === null))) throw new Error('nessuna zona letta nel bollettino');
  const blocco = (a, b) => { const m = new RegExp(a + '\\s*([\\s\\S]*?)\\s*' + b).exec(t); return m ? m[1].replace(/\s+/g, ' ').trim() : ''; };
  return { tipo: /AVVISO\s+DI\s+VIGILANZA/i.test(t) ? 'Avviso' : 'Bollettino', doc: doc ? `${doc[1]}/${doc[2]}` : '', emissione, giorni, fenomeni: blocco('FENOMENI PREVISTI', 'TENDENZA'), tendenza: blocco('TENDENZA', 'Agenzia Regionale'), classi: CLASSI_PIOGGIA, zone: cfg.bollettino.zone };
}


// ---------- Osservatorio delle Alpi Orientali: livelli e pioggia nel bacino del Brenta (serve account, segreti OSSERVATORIO_*) ----------
async function osservatorio(c) {
  if (!c || !c.attivo) return null;
  const utente = process.env.OSSERVATORIO_USER, pw = process.env.OSSERVATORIO_PASSWORD;
  if (!utente || !pw) { console.log('Osservatorio: segreti non impostati, lettura saltata.'); return null; }
  const base = (process.env.OSSERVATORIO_BASE || c.base).replace(/\/$/, '');
  const chiama = async (percorso, opz = {}) => {
    let err;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(base + percorso, { ...opz, signal: AbortSignal.timeout(90000) });
        const t = await r.text();
        if ([502, 503, 504].includes(r.status)) { err = new Error(`${percorso.split('?')[0]}: risposta ${r.status}`); await new Promise(x => setTimeout(x, 4000 * (i + 1))); continue; }
        if (!r.ok) throw Object.assign(new Error(`${percorso.split('?')[0]}: risposta ${r.status}`), { definitivo: true });
        try { return JSON.parse(t); } catch { return t; }
      } catch (e) { if (e.definitivo) throw e; err = e; await new Promise(x => setTimeout(x, 4000 * (i + 1))); }
    }
    throw err;
  };
  const fd = new FormData(); fd.append('userName', utente); fd.append('password', pw);
  const r0 = await chiama('/api/Auth/login', { method: 'POST', body: fd });
  const token = String(typeof r0 === 'string' ? r0 : (r0.token || '')).replace(/^"|"$/g, '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new Error('token non ottenuto');
  const H = { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } };
  const p2 = n => String(n).padStart(2, '0');
  const fmt = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`; };
  const solare = Date.now() + 3600000;   // le date del servizio sono in ora solare (UTC+1), come ARPAV
  const dt = s => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s)); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 3600000 : NaN; };
  const scarica = async (tipo, lista, ore) => {
    const q = new URLSearchParams({ stationIDs: lista.map(x => x.id).join(','), startDate: fmt(solare - ore * 3600000), endDate: fmt(solare + 3600000), format: 'JSON' });
    const r = await chiama(`/api/measures/${tipo}?${q}`, H);
    if (!Array.isArray(r)) throw new Error('risposta non valida per il tipo ' + tipo);
    const per = {};
    for (const x of r) { const t = dt(x.dataora), v = +x.valore; if (isFinite(t) && isFinite(v)) (per[x.idstazione] = per[x.idstazione] || []).push([t, v]); }
    return per;
  };
  const liv = await scarica(6, c.livello, 48), pio = await scarica(2, c.pioggia, 30);
  const out = { aggiornato: new Date().toISOString(), livello: {}, pioggia: {} };
  for (const s of c.livello) if (liv[s.id]) out.livello[s.id] = { nome: s.nome, dati: liv[s.id].sort((a, b) => a[0] - b[0]) };
  for (const s of c.pioggia) {
    const d = pio[s.id]; if (!d) continue;
    d.sort((a, b) => a[0] - b[0]);
    const B = 600000, bucket = {};                      // somma ogni 10 minuti (fine intervallo)
    for (const [t, v] of d) { const k = Math.ceil(t / B) * B; bucket[k] = (bucket[k] || 0) + v; }
    out.pioggia[s.id] = { nome: s.nome, ultimo: d[d.length - 1][0], dati: Object.keys(bucket).map(Number).sort((a, b) => a - b).map(k => [k, Math.round(bucket[k] * 100) / 100]) };
  }
  return out;
}

const xml = await scarica();
const dati = leggi(xml);
mkdirSync(OUT, { recursive: true });
const fileStato = `${OUT}/state.json`;
const stato = existsSync(fileStato) ? JSON.parse(readFileSync(fileStato, 'utf8')) : {};

// bollettino meteo: se non si riesce a leggerlo si riusa l'ultimo letto bene (segnato come non aggiornato)
let meteo = null;
try {
  const b = await pdfBollettino();
  meteo = leggiBollettino(testoPdf(b.buf), cfg.bollettino.zone);
  meteo.url = b.url;
  stato.meteo = meteo;
} catch (e) {
  console.log('::warning::Bollettino meteo non letto: ' + (e && e.message ? e.message : e));
  if (stato.meteo) meteo = Object.assign({}, stato.meteo, { nonAggiornato: true });
}
let os = null;
try {
  os = await osservatorio(cfg.osservatorio);
  if (os) stato.os = os;
} catch (e) {
  console.log('::warning::Osservatorio Alpi Orientali non letto: ' + (e && e.message ? e.message : e));
  if (stato.os) os = Object.assign({}, stato.os, { nonAggiornato: true });
}
writeFileSync(`${OUT}/idro.json`, JSON.stringify({ v: 1, run: dati.run, aggiornato: new Date().toISOString(), fonte: 'ARPAV Veneto, rete idrografica (CC BY 4.0), dati non validati', st: dati.st, pl: dati.pl, meteo, os }));

const puoInviare = DRY || (TOKEN && CHAT);
if (!puoInviare) console.log('::warning::Mancano i segreti TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID: nessun avviso inviato.');
let problemi = 0;
let pushAttivo = false; try { const ks = chiaveServizio(); pushAttivo = !!ks; console.log(ks ? `Push: attive (progetto ${ks.project_id})` : '::warning::Push NON attive: il segreto FIREBASE_SERVICE_ACCOUNT è vuoto o non esiste (controlla il nome e di averlo salvato in Settings → Secrets and variables → Actions)'); } catch (e) { console.log('::warning::' + e.message); }
stato.push = stato.push && typeof stato.push === 'object' ? stato.push : {};

for (const s of cfg.stazioni.filter(x => x.allerta)) {
  const d = dati.st[s.id];
  if (!d || !d.dati.length) { console.log(`::warning::${s.nome}: dato non presente nel file ARPAV`); continue; }
  const [t, v] = d.dati[d.dati.length - 1];
  if (Date.now() - t > 90 * 60000) console.log(`::warning::${s.nome}: ultimo dato vecchio (${oraLocale(t)})`);
  // notifica push dell'app a ogni superamento di G1, G2 o G3 (stato proprio, indipendente da Telegram)
  if (!PROVA && !PROVA_PUSH && pushAttivo && Date.now() - t <= 90 * 60000) {
    const lp = livello(v, d.g), pp = stato.push[s.id];
    if (pp == null) stato.push[s.id] = lp;   // primo controllo: si memorizza lo stato senza avvisare
    else if (lp > pp) {
      const nomeBreve = s.nome.replace(/^Brenta a /, '');
      try {
        const esito = await inviaPush({ titolo: `${nomeBreve} supera Guardia ${lp}`, testo: `Livello ${m2(v)} (soglia ${m2(d.g[lp - 1])}) · ore ${oraLocale(t).split(' del ')[0]}`, tag: `idro-${s.id}-${lp}` });
        console.log(`Push ${nomeBreve} G${lp}: ${esito.inviati}/${esito.dispositivi} dispositivi, ${esito.rimossi} rimossi`);
        stato.push[s.id] = lp;
      } catch (e) { console.log('::error::Push non inviato: ' + e.message); problemi++; }
    } else if (lp < pp) {
      const sp = d.g[pp - 1];
      if (sp == null || v < sp - (cfg.isteresi ?? 0.05)) stato.push[s.id] = lp;   // rientrata: si riarma l'avviso
    }
  }
  if (PROVA_PUSH) {
    if (s === cfg.stazioni.filter(x => x.allerta)[0]) {
      if (!pushAttivo) { console.log('::error::Prova push: notifiche non attive (manca il segreto FIREBASE_SERVICE_ACCOUNT)'); problemi++; }
      else try { const e = await inviaPush({ titolo: 'PROVA · notifica idrometria', testo: 'Test del sistema di avvisi: nessuna soglia superata.', tag: 'idro-prova' }); console.log(`Push di prova: ${e.inviati}/${e.dispositivi} dispositivi, ${e.rimossi} rimossi`); if (!e.dispositivi) console.log('::warning::Nessun dispositivo registrato: apri l\'app, tocca lo schermo e accetta le notifiche'); } catch (e) { console.log('::error::Push di prova non inviato: ' + e.message); problemi++; }
    }
    continue;
  }
  if (PROVA) {
    if (!puoInviare) continue;
    const link = esc(s.link || PAGINA_GENERICA);
    const testo = `🧪 <b>PROVA · simulazione avviso idrometrico</b>\n<i>Nessuna soglia superata: è solo un test del sistema di avvisi.</i>\n` +
      `📍 Stazione: <b>${esc(s.nome)}</b>\n` +
      `🌊 Livello attuale: <b>${m2(v)}</b> (G2: ${d.g[1] != null ? m2(d.g[1]) : 'n.d.'} · G3: ${d.g[2] != null ? m2(d.g[2]) : 'n.d.'})\n` +
      portataRiga(d) +
      `🕒 Ultimo dato alle ${oraLocale(t)}\n` +
      `🔗 <a href="${link}">Stazione ARPAV</a>`;
    if (!(await telegram(testo))) problemi++;
    continue;
  }
  const liv = livello(v, d.g), prec = stato[s.id] || 0;
  if (liv >= 2 && liv > prec) {
    if (!puoInviare) continue;
    const soglia = liv === 3 ? 'G3' : 'G2';
    const sogliaVal = d.g[liv - 1];
    const testo = `🚨 <b>ALLERTA IDROMETRICA · soglia ${soglia} superata</b>\n` +
      `📍 Stazione: <b>${esc(s.nome)}</b>\n` +
      `🌊 Livello: <b>${m2(v)}</b> (soglia ${soglia}: ${m2(sogliaVal)})\n` +
      portataRiga(d) +
      `🕒 Rilevato alle ${oraLocale(t)}\n` +
      `🔗 <a href="${esc(s.link || PAGINA_GENERICA)}">Stazione ARPAV</a>\n` +
      `<i>Fonte ARPAV, dato non validato.</i>`;
    if (await telegram(testo)) stato[s.id] = liv; else problemi++;
  } else if (liv < prec) {
    const sogliaPrec = d.g[prec - 1];
    if (sogliaPrec == null || v < sogliaPrec - (cfg.isteresi ?? 0.05)) stato[s.id] = liv;   // rientrata: si riarma l'avviso
  }
}
// ---- Registro automatico degli eventi di piena (Firestore, raccolta idro_eventi): picchi e orari dei passaggi di soglia a Barzizza e Limena,
// con il tempo di viaggio osservato tra i due picchi. Un evento si apre quando una delle due stazioni supera G1 e si chiude dopo 6 ore sotto G1.
async function registroEpisodi() {
  const ID_MONTE = '300005751', ID_RIF = '300005777', ST = [[ID_MONTE, 'Barzizza'], [ID_RIF, 'Limena']], dd = {};
  for (const [id, nome] of ST) { const x = dati.st[id]; if (!x || !x.dati.length || !x.g || x.g[0] == null) return; dd[id] = { nome, g: x.g, serie: x.dati }; }
  const ora = Date.now(), ultimoT = Math.max(...ST.map(([id]) => dd[id].serie[dd[id].serie.length - 1][0]));
  let ep = stato.episodio || null;
  if (!ep) {
    const cand = ST.flatMap(([id]) => dd[id].serie.filter(([t, v]) => v >= dd[id].g[0] && t > (stato.episodioFine || 0)).map(([t]) => t));
    if (!cand.length) return;
    const inizio = Math.min(...cand);
    ep = { id: new Date(inizio).toISOString().slice(0, 16).replace(/[-:T]/g, ''), inizio, fine: null, ultimoSopra: inizio, st: {} };
  }
  for (const [id, nome] of ST) {
    const d = dd[id], da = ep.inizio - 12 * 3600000;
    if (!ep.st[id]) ep.st[id] = { nome, max: null, base: Math.min(...d.serie.filter(([t]) => t >= da && t <= ep.inizio + 3600000).map(([, v]) => v), ...d.serie.map(([, v]) => v).slice(0, 1)), soglie: {} };
    const e = ep.st[id];
    d.serie.filter(([t]) => t >= da).forEach(([t, v]) => {
      if (!e.max || v > e.max.v) e.max = { t, v };
      d.g.forEach((g, i) => { if (g != null && v >= g && !e.soglie[i + 1]) e.soglie[i + 1] = { t, v }; });
      if (v >= d.g[0] && t > ep.ultimoSopra) ep.ultimoSopra = t;
    });
  }
  if (ora - ep.ultimoSopra > 6 * 3600000 && ora - ultimoT < 90 * 60000) {   // chiuso: 6 ore sotto G1 con dati aggiornati
    ep.fine = ep.ultimoSopra;
    const b = ep.st[ID_MONTE], l = ep.st[ID_RIF], h = (l.max.t - b.max.t) / 3600000, sB = b.max.v - b.base, sL = l.max.v - l.base;
    if (sB >= 0.3 && sL >= 0.3 && h >= 0.5 && h <= 24) { ep.ritardoOre = Math.round(h * 10) / 10; ep.kStima = Math.round(sL / sB * 100) / 100; }
    stato.episodio = null; stato.episodioFine = ep.fine;
  } else stato.episodio = ep;
  const iso = t => (t == null ? null : new Date(t).toISOString());
  const stz = Object.fromEntries(Object.entries(ep.st).map(([id, e]) => [id, { nome: e.nome, max: e.max && { v: e.max.v, t: iso(e.max.t) }, base: e.base, soglie: Object.fromEntries(Object.entries(e.soglie).map(([i, x]) => [i, { v: x.v, t: iso(x.t) }])) }]));
  const doc = { id: ep.id, inizio: iso(ep.inizio), fine: iso(ep.fine), aperto: !ep.fine, stazioni: stz, ritardoOre: ep.ritardoOre ?? null, kStima: ep.kStima ?? null, aggiornato: new Date().toISOString() };
  const firma = JSON.stringify({ ...doc, aggiornato: 0 });
  if (stato.episodioScritto === ep.id + firma) return;
  if (pushAttivo) { await scriviDocumento('idro_eventi', ep.id, doc); console.log(`Registro eventi: ${ep.id} ${ep.fine ? 'chiuso' : 'aperto'}${ep.ritardoOre ? ', tempo di viaggio ' + ep.ritardoOre + ' h' : ''}`); }
  stato.episodioScritto = ep.id + firma;
}
if (!PROVA && !PROVA_PUSH) { try { await registroEpisodi(); } catch (e) { console.log('::warning::Registro eventi non aggiornato: ' + e.message); } }
// notifica push quando sale il livello dell'allerta CFD (zona E1) per oggi o domani: legge lo storico scritto dal monitoraggio automatico
if (pushAttivo && !PROVA && !PROVA_PUSH) {
  try {
    const RANGO = { VERDE: 0, GIALLA: 1, ARANCIONE: 2, ROSSA: 3 };
    const dmy = d => { const p = Object.fromEntries(new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(d).map(x => [x.type, x.value])); return `${+p.day}/${+p.month}/${p.year}`; };
    const norm = s => { const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${+m[1]}/${+m[2]}/${m[3]}` : ''; };
    const giorni = [[dmy(new Date()), 'oggi'], [dmy(new Date(Date.now() + 86400000)), 'domani']];
    const righe = (await leggiCollezione('allerte_cfd_veneto')) || [];
    const cfd = stato.push.cfd && typeof stato.push.cfd === 'object' ? stato.push.cfd : {}, primo = !stato.push.cfdInit, nuovo = {};
    for (const [data, quando] of giorni) {
      const ult = righe.map(r => r.campi).filter(c => norm(c.data) === data && c.fonte && RANGO[c.livello] != null).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))[0];
      if (!ult) continue;
      const rango = RANGO[ult.livello];
      const prec = cfd[data] != null ? cfd[data] : 0;
      if (!primo && rango > prec) {
        const att = Object.values(ult.rischi || {}).filter(v => v && v.livello && v.livello !== 'VERDE').map(v => `${v.nome}: ${v.livello}`);
        const e = await inviaPush({ titolo: `Allerta ${ult.livello} per ${quando}`, testo: `Zona E1 Curtarolo${att.length ? ' · ' + att.join(', ') : ''}`, tag: `cfd-${data.replace(/\//g, '-')}-${rango}`, icona: '⚠️' });
        console.log(`Push allerta CFD ${ult.livello} (${quando}): ${e.inviati}/${e.dispositivi} dispositivi`);
      }
      cfd[data] = rango; nuovo[data] = rango; stato.push.cfd = cfd;   // livello sceso: si aggiorna senza avvisare
    }
    stato.push.cfd = nuovo; stato.push.cfdInit = true;
  } catch (e) { console.log('::warning::Controllo allerte CFD per le push non riuscito: ' + e.message); }
}
writeFileSync(fileStato, JSON.stringify(stato));
if (problemi) process.exitCode = 1;
