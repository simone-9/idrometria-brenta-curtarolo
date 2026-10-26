// Idrometria Brenta: scarica i dati ARPAV, pubblica un JSON per l'app e avvisa su Telegram
// quando le stazioni di allerta superano la soglia di guardia G2 o G3.
// Nessuna dipendenza: richiede solo Node 20.
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SORGENTE = process.env.IDRO_SOURCE_URL || 'https://www.arpa.veneto.it/api/risorse/data-meteo/xml/Ultime48ore.xml';
const FILE_PROVA = process.env.IDRO_SOURCE_FILE || '';
const OUT = process.env.OUT_DIR || 'out';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = process.env.TELEGRAM_CHAT_ID || '';
const DRY = process.env.TELEGRAM_DRY_RUN === '1';
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
  return { run, st };
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
  const link = [...pagina.matchAll(/href=["']([^"']*BVM_(\d{6})[^"']*\.pdf)["']/gi)].map(m => ({ url: new URL(m[1].replace(/&amp;/g, '&'), CFD_URL).href, d: m[2] }));
  if (!link.length) throw new Error('nessun bollettino BVM trovato nella pagina del CFD');
  link.sort((a, b) => a.d.localeCompare(b.d));
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
    const z = {};
    for (const x of zone) {
      const m = new RegExp('^[ \\t]*' + x.id + '[ \\t]+(\\S+)', 'm').exec(sez);
      z[x.id] = m && Object.prototype.hasOwnProperty.call(CLASSI_PIOGGIA, m[1]) ? m[1] : null;   // mai un valore inventato: se non si legge resta null
    }
    return { quando: h[1], iso: `${d[3]}-${String(mese).padStart(2, '0')}-${String(+d[1]).padStart(2, '0')}`, etichetta: h[2].trim().toLowerCase(), zone: z };
  });
  if (giorni.every(g => Object.values(g.zone).every(v => v === null))) throw new Error('nessuna zona letta nel bollettino');
  const blocco = (a, b) => { const m = new RegExp(a + '\\s*([\\s\\S]*?)\\s*' + b).exec(t); return m ? m[1].replace(/\s+/g, ' ').trim() : ''; };
  return { doc: doc ? `${doc[1]}/${doc[2]}` : '', emissione, giorni, fenomeni: blocco('FENOMENI PREVISTI', 'TENDENZA'), tendenza: blocco('TENDENZA', 'Agenzia Regionale'), classi: CLASSI_PIOGGIA, zone: cfg.bollettino.zone };
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
writeFileSync(`${OUT}/idro.json`, JSON.stringify({ v: 1, run: dati.run, aggiornato: new Date().toISOString(), fonte: 'ARPAV Veneto, rete idrografica (CC BY 4.0), dati non validati', st: dati.st, meteo }));

const puoInviare = DRY || (TOKEN && CHAT);
if (!puoInviare) console.log('::warning::Mancano i segreti TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID: nessun avviso inviato.');
let problemi = 0;

for (const s of cfg.stazioni.filter(x => x.allerta)) {
  const d = dati.st[s.id];
  if (!d || !d.dati.length) { console.log(`::warning::${s.nome}: dato non presente nel file ARPAV`); continue; }
  const [t, v] = d.dati[d.dati.length - 1];
  if (Date.now() - t > 90 * 60000) console.log(`::warning::${s.nome}: ultimo dato vecchio (${oraLocale(t)})`);
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
writeFileSync(fileStato, JSON.stringify(stato));
if (problemi) process.exitCode = 1;
