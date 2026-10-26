// Idrometria Brenta: scarica i dati ARPAV, pubblica un JSON per l'app e avvisa su Telegram
// quando le stazioni di allerta superano la soglia di guardia G2 o G3.
// Nessuna dipendenza: richiede solo Node 20.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const SORGENTE = process.env.IDRO_SOURCE_URL || 'https://www.arpa.veneto.it/api/risorse/data-meteo/xml/Ultime48ore.xml';
const FILE_PROVA = process.env.IDRO_SOURCE_FILE || '';
const OUT = process.env.OUT_DIR || 'out';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = process.env.TELEGRAM_CHAT_ID || '';
const DRY = process.env.TELEGRAM_DRY_RUN === '1';
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

function leggi(xml) {
  const run = ((/<ISTANTERUN>\s*(\d{12})/.exec(xml)) || [])[1] || '';
  const st = {};
  for (const s of cfg.stazioni) {
    const m = new RegExp('<ID>\\s*' + s.id + '\\s*</ID>').exec(xml);
    if (!m) continue;
    const fine = xml.indexOf('</SENSORE>', m.index);
    const ch = xml.slice(m.index, fine < 0 ? undefined : fine);
    const g = n => { const x = new RegExp('<GUARDIA' + n + '>\\s*([-\\d.,]+)').exec(ch); return x ? num(x[1]) : null; };
    const dati = [], re = /<DATI\s+ISTANTE="(\d{12})"\s*>\s*<VM>\s*([-\d.,]+)\s*<\/VM>/g;
    let d;
    while ((d = re.exec(ch))) { const v = num(d[2]); if (isFinite(v)) dati.push([tempo(d[1]), v]); }
    dati.sort((a, b) => a[0] - b[0]);
    st[s.id] = { nome: s.nome, g: [g(1), g(2), g(3)], dati };
  }
  return { run, st };
}

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

const xml = await scarica();
const dati = leggi(xml);
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/idro.json`, JSON.stringify({ v: 1, run: dati.run, aggiornato: new Date().toISOString(), fonte: 'ARPAV Veneto, rete idrografica (CC BY 4.0), dati non validati', st: dati.st }));

const fileStato = `${OUT}/state.json`;
const stato = existsSync(fileStato) ? JSON.parse(readFileSync(fileStato, 'utf8')) : {};
const puoInviare = DRY || (TOKEN && CHAT);
if (!puoInviare) console.log('::warning::Mancano i segreti TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID: nessun avviso inviato.');
let problemi = 0;

for (const s of cfg.stazioni.filter(x => x.allerta)) {
  const d = dati.st[s.id];
  if (!d || !d.dati.length) { console.log(`::warning::${s.nome}: dato non presente nel file ARPAV`); continue; }
  const [t, v] = d.dati[d.dati.length - 1];
  if (Date.now() - t > 90 * 60000) console.log(`::warning::${s.nome}: ultimo dato vecchio (${oraLocale(t)})`);
  const liv = livello(v, d.g), prec = stato[s.id] || 0;
  if (liv >= 2 && liv > prec) {
    if (!puoInviare) continue;
    const soglia = liv === 3 ? 'G3' : 'G2';
    const sogliaVal = d.g[liv - 1];
    const testo = `🚨 <b>ALLERTA IDROMETRICA · soglia ${soglia} superata</b>\n` +
      `📍 Stazione: <b>${esc(s.nome)}</b>\n` +
      `🌊 Livello: <b>${m2(v)}</b> (soglia ${soglia}: ${m2(sogliaVal)})\n` +
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
