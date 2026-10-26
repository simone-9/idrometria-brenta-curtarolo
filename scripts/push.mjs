// Notifiche push dell'app (Firebase Cloud Messaging) senza dipendenze: solo Node 20.
// Legge i dispositivi registrati dall'app nella raccolta Firestore «push_dispositivi» e invia un messaggio a ciascuno.
// Richiede il segreto FIREBASE_SERVICE_ACCOUNT (JSON della chiave dell'account di servizio). Se manca, non fa nulla.
import { createSign } from 'node:crypto';

const b64u = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function chiaveServizio(env = process.env) {
  const raw = env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw.trim()) return null;
  try { const k = JSON.parse(raw); if (k.client_email && k.private_key && k.project_id) return k; } catch (e) {}
  throw new Error('FIREBASE_SERVICE_ACCOUNT non è un JSON valido di account di servizio');
}

async function accessToken(k, f) {
  const ora = Math.floor(Date.now() / 1000);
  const corpo = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64u(JSON.stringify({ iss: k.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: ora, exp: ora + 3000 }));
  const firma = b64u(createSign('RSA-SHA256').update(corpo).sign(k.private_key));
  const r = await f('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + corpo + '.' + firma });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Accesso a Google non riuscito (' + r.status + '): ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

async function elencoDispositivi(k, tok, f) {
  const out = []; let pag = '';
  do {
    const r = await f(`https://firestore.googleapis.com/v1/projects/${k.project_id}/databases/(default)/documents/push_dispositivi?pageSize=300${pag}`, { headers: { authorization: 'Bearer ' + tok } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Lettura dei dispositivi non riuscita (' + r.status + '): ' + JSON.stringify(j).slice(0, 200));
    (j.documents || []).forEach(d => { const t = d.fields && d.fields.token && d.fields.token.stringValue; if (t) out.push({ nome: d.name, token: t }); });
    pag = j.nextPageToken ? '&pageToken=' + encodeURIComponent(j.nextPageToken) : '';
  } while (pag);
  return out;
}

// msg = { titolo, testo, tag }. Ritorna { saltato } oppure { dispositivi, inviati, rimossi }
export async function inviaPush(msg, opzioni = {}) {
  const f = opzioni.fetch || fetch, k = chiaveServizio(opzioni.env || process.env);
  if (!k) return { saltato: true };
  const tok = await accessToken(k, f), dispositivi = await elencoDispositivi(k, tok, f);
  let inviati = 0, rimossi = 0;
  for (const d of dispositivi) {
    const r = await f(`https://fcm.googleapis.com/v1/projects/${k.project_id}/messages:send`, {
      method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token: d.token, data: { titolo: String(msg.titolo), testo: String(msg.testo), tag: String(msg.tag || 'idro'), url: './' }, webpush: { headers: { Urgency: 'high', TTL: '3600' } }, android: { priority: 'HIGH' } } })
    });
    if (r.ok) { inviati++; continue; }
    const t = await r.text().catch(() => '');
    if (r.status === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT/.test(t)) {   // dispositivo non più valido: si toglie dall'elenco
      const x = await f(`https://firestore.googleapis.com/v1/${d.nome}`, { method: 'DELETE', headers: { authorization: 'Bearer ' + tok } });
      if (x.ok) rimossi++;
    } else console.log('::warning::Push non inviato (' + r.status + '): ' + t.slice(0, 160));
  }
  return { dispositivi: dispositivi.length, inviati, rimossi };
}
