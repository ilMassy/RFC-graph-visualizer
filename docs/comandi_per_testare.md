# Comandi per testare la pipeline di backend

Riferimento rapido per testare `backend/rfc_pipeline.py` e `backend/draft_metadata_enricher.py` singolarmente, senza dover ricordare a memoria le opzioni. Nell'uso normale non serve lanciare nulla di questo a mano: gli hook `prestart`/`prebuild` di `infovis/package.json` chiamano già `backend/update_dataset.sh` (sezione 6) che esegue tutta la pipeline e scrive direttamente in `infovis/public/data/graph_data_enriched.json`. I comandi qui sotto scrivono invece in una cartella `output/` locale a `backend/`, comoda per test isolati senza toccare il dataset reale del frontend. Da eseguire dentro `backend/`, con il virtualenv attivo:

```bash
cd percorso_cartella_backend
source venv/bin/activate
```

---

## 1. Fase `parse` — indice reale completo

⚠️ **Attenzione se si vuole testare con `sample_rfc_index.xml` invece che con l'indice reale**: l'argomento posizionale `input` di `parse` non è un semplice "file da leggere" — `download_if_changed()` lo tratta *anche* come percorso di destinazione dell'eventuale download da `--source-url` (default `rfc-editor.org`). Questo significa che lanciare

```bash
python rfc_pipeline.py parse sample_rfc_index.xml -o output/graph_data.json
```

**può sovrascrivere `sample_rfc_index.xml` con l'indice reale scaricato da rfc-editor.org** (succede se il controllo condizionale ottiene una risposta 200, oppure sempre con `--force`), vanificando lo scopo del file di esempio ("test rapido, senza scaricare il dataset reale"). Non esiste oggi un flag per dire "usa solo questo file locale, non toccare la rete".

**Workaround finché non c'è un fix**: copiare il file di esempio altrove prima di passarlo allo script, così è la copia (non l'originale versionato) a essere eventualmente sovrascritta:

```bash
cp sample_rfc_index.xml output/sample_rfc_index_copy.xml
python rfc_pipeline.py parse output/sample_rfc_index_copy.xml -o output/graph_data.json
```

---

Scarica (se necessario) `rfc-index.xml` e produce `graph_data.json`:

```bash
python rfc_pipeline.py parse rfc-index.xml -o output/graph_data.json
```

Verifica che il download condizionale funzioni — rilancia lo stesso comando una seconda volta: deve loggare "non modificato dal server, nessun download" invece di riscaricare tutto:

```bash
python rfc_pipeline.py parse rfc-index.xml -o output/graph_data.json
```

Forza un nuovo parsing completo ignorando lo stato salvato (utile dopo aver modificato `rfc_pipeline.py`):

```bash
python rfc_pipeline.py parse rfc-index.xml -o output/graph_data.json --force
```

## 2. Fase `enrich` — arricchimento via Datatracker

⚠️ Interroga l'API pubblica di Datatracker: con il dataset reale (~10.000 RFC) ci vuole tempo per via del rate limiting (0.5s per richiesta). Per un primo test, usa `--skip-drafts` per saltare il fetch dei 34.000+ Internet-Draft e limitarti solo agli RFC pubblicati:

```bash
python rfc_pipeline.py enrich --input output/graph_data.json --output output/graph_data_enriched.json --skip-drafts
```

Test dell'interruzione/ripresa — lancia il comando e interrompi con `Ctrl+C` dopo qualche secondo, poi rilancia lo stesso comando: deve riprendere da dove si era fermato invece di ripartire da zero (verificalo controllando che il log iniziale riporti "già processati: N" con N > 0):

```bash
python rfc_pipeline.py enrich --input output/graph_data.json --output output/graph_data_enriched.json
```

Test con anche i draft (run completo, quello che produce il dataset finale):

```bash
python rfc_pipeline.py enrich --input output/graph_data.json --output output/graph_data_enriched.json
```

Svuota la cache HTTP locale (utile se si sospetta una risposta 404 "fantasma" rimasta in cache da un errore temporaneo):

```bash
python rfc_pipeline.py enrich --input output/graph_data.json --output output/graph_data_enriched.json --clear-cache
```

Riparti da zero ignorando `enriched_ids` (ri-arricchisce tutto, anche ciò che era già stato processato):

```bash
python rfc_pipeline.py enrich --input output/graph_data.json --output output/graph_data_enriched.json --force
```

## 3. Comando `all` — pipeline completa in un solo passaggio

È lo stesso sotto-comando lanciato da `update_dataset.sh` (sezione 6), lì con `--enriched-output` puntato direttamente a `infovis/public/data/graph_data_enriched.json` invece che a `output/`:

```bash
python rfc_pipeline.py all rfc-index.xml --enriched-output output/graph_data_enriched.json
```

## 4. Verifiche sull'output finale

Conteggio nodi/archi e controllo che lo schema sia quello atteso:

```bash
python -c "
import json
data = json.load(open('output/graph_data_enriched.json'))
print('Schema version:', data['meta']['schema_version'])
print('Generato il:', data['meta']['generated_at'])
print('Nodi totali:', len(data['nodes']))
print('Archi totali:', len(data['edges']))

draft = sum(1 for n in data['nodes'] if n.get('is_draft'))
aborted = sum(1 for n in data['nodes'] if n.get('is_aborted'))
print('Draft attivi/scaduti:', draft)
print('Draft morti/sostituiti:', aborted)
print('RFC pubblicati:', len(data['nodes']) - draft - aborted)
"
```

Controllo dei nodi con layer non risolto (deve essere una minoranza sugli RFC pubblicati, quasi tutti sui draft):

```bash
python -c "
import json
data = json.load(open('output/graph_data_enriched.json'))
no_layer_rfc = sum(1 for n in data['nodes'] if n.get('layer') is None and not n.get('is_draft') and not n.get('is_aborted'))
no_layer_draft = sum(1 for n in data['nodes'] if n.get('layer') is None and (n.get('is_draft') or n.get('is_aborted')))
print('RFC senza layer risolto:', no_layer_rfc)
print('Draft senza layer risolto:', no_layer_draft)
"
```

Controllo che non ci siano archi pendenti (source/target non presenti nei nodi):

```bash
python -c "
import json
data = json.load(open('output/graph_data_enriched.json'))
ids = {n['id'] for n in data['nodes']}
pendenti = [e for e in data['edges'] if e['source'] not in ids or e['target'] not in ids]
print('Archi pendenti trovati:', len(pendenti))
"
```

---

## 5. Fase `draft_metadata_enricher.py` — secondo passaggio, solo draft/aborted

⚠️ Va lanciato **dopo** un `enrich` (punto 2) che abbia già prodotto `graph_data_enriched.json` con i draft dentro (cioè senza `--skip-drafts`): questo script non crea nodi, arricchisce solo quelli già presenti che risultano incompleti (`url` mancante o `year` nullo).

Run di base, in place sullo stesso file (input e output coincidono):

```bash
python draft_metadata_enricher.py --input output/graph_data_enriched.json --output output/graph_data_enriched.json
```

Test rapido su un piccolo numero di nodi, senza aspettare l'intero dataset (utile per verificare che lo script funzioni prima di lanciarlo su tutti i draft):

```bash
python draft_metadata_enricher.py --input output/graph_data_enriched.json --output output/graph_data_enriched.json --limit 20
```

Verifica che `url` e `year` siano stati effettivamente valorizzati sui primi nodi arricchiti:

```bash
python -c "
import json
data = json.load(open('output/graph_data_enriched.json'))
draft_nodes = [n for n in data['nodes'] if n.get('is_draft') or n.get('is_aborted')]
con_url = sum(1 for n in draft_nodes if n.get('url'))
con_year = sum(1 for n in draft_nodes if n.get('year') is not None)
print('Draft/aborted totali:', len(draft_nodes))
print('Con url risolto:', con_url)
print('Con year risolto:', con_year)
print(json.dumps(draft_nodes[0], indent=2))
"
```

Test dell'interruzione/ripresa — lancia il comando e interrompi con `Ctrl+C` dopo qualche secondo, poi rilancia lo stesso comando: deve riprendere da dove si era fermato (verificalo controllando che il log iniziale riporti "già processati: N" con N > 0, invece di ripartire da zero):

```bash
python draft_metadata_enricher.py --input output/graph_data_enriched.json --output output/graph_data_enriched.json
```

Svuota la cache HTTP locale dello script (separata da quella di `rfc_pipeline.py`: directory `.cache/datatracker_docdetail`), utile se si sospetta una risposta 404 "fantasma" rimasta in cache da un errore temporaneo — qui non esiste un flag dedicato come `--clear-cache`, va cancellata a mano:

```bash
rm -rf .cache/datatracker_docdetail
```

Riparti da zero ignorando lo stato salvato (ri-arricchisce anche i nodi già completati in run precedenti):

```bash
python draft_metadata_enricher.py --input output/graph_data_enriched.json --output output/graph_data_enriched.json --force
```

Controllo finale: dopo un run completo, non dovrebbero restare draft/aborted senza `url` (deterministico, sempre risolvibile) — `year` invece può legittimamente restare `null` per i documenti che Datatracker non risolve, non è un errore:

```bash
python -c "
import json
data = json.load(open('output/graph_data_enriched.json'))
draft_nodes = [n for n in data['nodes'] if n.get('is_draft') or n.get('is_aborted')]
senza_url = sum(1 for n in draft_nodes if not n.get('url'))
senza_year = sum(1 for n in draft_nodes if n.get('year') is None)
print('Draft/aborted senza url:', senza_url, '(atteso: 0)')
print('Draft/aborted senza year:', senza_year, '(atteso: >0 ma minoranza)')
"
```

---

## 6. `update_dataset.sh` — l'orchestratore automatico

Lanciato in automatico dagli hook `prestart`/`prebuild` definiti in `infovis/package.json`, quindi da `npm start`/`npm run build` non serve invocarlo a mano. Esegue in sequenza `rfc_pipeline.py all` e `draft_metadata_enricher.py`, scrivendo direttamente in `infovis/public/data/graph_data_enriched.json` (nessuna cartella `output/` né copia manuale, a differenza dei comandi di test isolato delle sezioni 1-5).

Percorsi di default (sovrascrivibili con variabili d'ambiente prima di `npm`):

```bash
# cartella dati del frontend, di default ../infovis/public/data rispetto a backend/
FRONTEND_DATA_DIR=/percorso/tuo/frontend/public/data npm run build

# interprete Python, di default backend/venv/bin/python se esiste, altrimenti python3 di sistema
VENV_PYTHON=/percorso/tuo/venv/bin/python npm run build
```

Per lanciarlo manualmente (ad es. per rigenerare il dataset senza fare anche la build Angular):

```bash
cd backend
bash update_dataset.sh
```

## 7. Avvio del sistema — build del frontend Angular e serving statico

Da dentro `infovis/` (la root del progetto Angular, non `backend/`), `npm run build` lancia da solo l'hook `prebuild` (sezione 6) e poi la build:

```bash
cd ~/Scrivania/INFOVIS/infovis
npm run build
```

⚠️ Il warning `Module 'ngraph.forcelayout' used by 'three-forcegraph' is not ESM` è atteso e non bloccante: è una dipendenza CommonJS del motore di force-layout 3D usato dal grafo, la build completa comunque correttamente.

Servire i file statici generati (build in `dist/infovis/browser/`) con il server integrato di PHP, in ascolto solo su localhost:

```bash
cd dist/infovis/browser
php -S 127.0.0.1:8888
```

A questo punto il frontend è raggiungibile su `http://127.0.0.1:8888`. Per fermare il server: `Ctrl+C`.

**Nota**: questo è un server di sviluppo/test minimale (serve solo file statici, nessuna configurazione di caching/compressione/HTTPS) — va bene per verificare il risultato di una build locale, non è pensato per un deploy in produzione.

Per rigenerare il frontend dopo una modifica al codice Angular o dopo un aggiornamento del dataset, basta ripetere `npm run build` e poi ri-servire la cartella `dist/infovis/browser` aggiornata (fermando prima il server precedente se ancora attivo sulla stessa porta). Se invece si vuole solo ricompilare Angular senza rilanciare la pipeline dati (dataset già aggiornato), si può usare `npx ng build` per saltare l'hook `prebuild`.

---

## 8. Pulizia tra un test e l'altro

Rimuove stato e cache di `rfc_pipeline.py` per ripartire completamente da zero (usare con cautela: la prossima `enrich` rifà tutte le chiamate a Datatracker):

```bash
rm -rf .state .cache
```

Nota: `draft_metadata_enricher.py` usa un file di stato e una cache **separati** (`.state/draft_metadata_state.json` e `.cache/datatracker_docdetail/`), quindi il comando sopra li rimuove già entrambi se lanciato dalla stessa cartella `backend/` — se invece si vuole azzerare **solo** lo stato del secondo script, lasciando intatti quelli di `rfc_pipeline.py`:

```bash
rm -f .state/draft_metadata_state.json
rm -rf .cache/datatracker_docdetail
```

Rimuove solo gli output di test generati al punto 1, senza toccare lo stato del dataset reale:

```bash
rm -f output/graph_data_test.json .state/parser_state_test.json
```
