# Idrometria Brenta · Protezione Civile Curtarolo

Ogni 10 minuti un piccolo programma su GitHub (GitHub Actions):

1. scarica i livelli ARPAV (file `Ultime48ore.xml`, licenza CC BY 4.0);
2. pubblica un file `idro.json` con le stazioni utili, che l'app legge (ramo `data` di questo archivio);
3. manda un messaggio **Telegram** quando **Barzizza** o **Limena** superano la soglia di guardia **G2** o **G3**, con stazione, livello, ora e link. Per ogni soglia l'avviso parte una volta sola; riparte se il livello rientra sotto la soglia (con un margine di 5 cm) e poi la supera di nuovo.

I dati ARPAV sono automatici e non validati: gli avvisi sono un aiuto per la sala operativa e non sostituiscono i bollettini ufficiali.

## Messa in funzione (una volta sola)

1. **Archivio.** Su GitHub crea un archivio **pubblico** (per esempio `idrometria-curtarolo`) e carica tutto il contenuto di questa cartella (anche la cartella nascosta `.github`). Pubblico serve perché l'app possa leggere i dati e perché i minuti di esecuzione sono gratuiti. Qui non c'è nulla di riservato: token e codici vanno nei *segreti*, mai nei file.
2. **Bot Telegram.** Su Telegram scrivi a **@BotFather**, invia `/newbot`, scegli nome e username. Ti dà un *token* (lungo, con i due punti): non condividerlo.
3. **Chat degli avvisi.** Crea un gruppo Telegram (o usa il tuo account), aggiungi il bot e scrivi un messaggio nel gruppo. Poi apri nel browser `https://api.telegram.org/bot<TOKEN>/getUpdates` (al posto di `<TOKEN>` il token) e cerca `"chat":{"id":...`: quel numero (per i gruppi è negativo, es. `-1001234567890`) è il *chat id*.
4. **Segreti.** In GitHub: archivio → Settings → Secrets and variables → Actions → *New repository secret*. Crea due segreti: `TELEGRAM_BOT_TOKEN` (il token) e `TELEGRAM_CHAT_ID` (il chat id).
5. **Permessi.** Settings → Actions → General → Workflow permissions → *Read and write permissions* → Save.
6. **Link delle stazioni.** Apri `config/stazioni.json` e i link ARPAV di Barzizza e Limena sono già inseriti; modificali solo se cambiano.
7. **Primo avvio.** Scheda *Actions* → *Idrometria Brenta* → *Run workflow*. Se va a buon fine compare il ramo `data` con `idro.json`.
8. **App.** Nell'app, scheda Idrometria → *Impostazioni della stima* → in «Indirizzo dati intermedio» scrivi:
   `https://raw.githubusercontent.com/<TUO-UTENTE>/<ARCHIVIO>/data/idro.json`

## Cose da sapere

- GitHub esegue i lavori programmati con qualche minuto di ritardo (a volte 10-20 minuti nei momenti di carico). Per questo l'app continua a leggere anche direttamente da ARPAV e, per gli avvisi urgenti, non è l'unica fonte da guardare.
- Se per 60 giorni non ci sono attività nell'archivio, GitHub sospende i lavori programmati: ogni tanto controlla la scheda *Actions* e, se serve, riattiva il flusso.
- Se ARPAV non risponde o non aggiorna i dati, nel registro del lavoro compare un avviso; non parte però alcun messaggio Telegram.
- Per cambiare soglie o stazioni di allerta: `config/stazioni.json` (`"allerta": true`).
- Prova senza inviare: `TELEGRAM_DRY_RUN=1 node scripts/idro.mjs`.
