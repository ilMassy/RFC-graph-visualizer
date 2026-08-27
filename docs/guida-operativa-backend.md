# 🧪 Guida operativa del backend

Riferimento rapido per testare `backend/rfc_pipeline.py` e `backend/draft_metadata_enricher.py` singolarmente, e per gestire gli scenari di rigenerazione del dataset (`graph_data_enriched.json`).

> [!NOTE]
> Nell'uso normale **non serve lanciare nulla di questo a mano**: gli hook `prestart`/`prebuild` di `infovis/package.json` chiamano già `backend/update_dataset.sh` (§6). I comandi delle sezioni 1–5 scrivono invece in una cartella `output/` locale, comoda per test isolati senza toccare il dataset reale.

> [!IMPORTANT]
> **Ogni comando di questa guida — in particolare `rm -rf .state/ .cache/...`, che cancella stato e cache — va eseguito dentro `backend/`**, con il virtualenv attivo. Da un'altra cartella, gli stessi percorsi puntano altrove o non esistono.

```bash
cd percorso_cartella_backend
source venv/bin/activate
```

---

## 📑 Indice

1. [Fase `parse`](#1-fase-parse)
2. [Fase `enrich`](#2-fase-enrich)
3. [Comando `all` — pipeline completa](#3-comando-all--pipeline-completa)
4. [Verifiche sull'output](#4-verifiche-sulloutput)
5. [`draft_metadata_enricher.py`](#5-draft_metadata_enricherpy)
6. [`update_dataset.sh` — orchestratore automatico](#6-update_datasetsh--orchestratore-automatico)
7. [Avvio del frontend](#7-avvio-del-frontend)
8. [Pulizia tra un test e l'altro](#8-pulizia-tra-un-test-e-laltro)
9. [Rigenerare il dataset da zero](#9-rigenerare-il-dataset-da-zero)
10. [Stato disallineato](#10-stato-disallineato)
11. [Casi senza rischi](#11-casi-senza-rischi)

---

## 1. Fase `parse`

Test offline con l'indice ridotto, nessuna rete:

```bash
python rfc_pipeline.py parse sample_rfc_index.xml -o output/graph_data.json --offline
```

Con l'indice reale, rilancia due volte lo stesso comando per verificare il **download condizionale** (ETag/Last-Modified): la seconda volta deve loggare *"non modificato dal server"*:

```bash
python rfc_pipeline.py parse rfc-index.xml -o output/graph_data.json
```

Forza un nuovo parsing ignorando lo stato salvato:

```bash
python rfc_pipeline.py parse rfc-index.xml -o output/graph_data.json --force
```

---

## 2. Fase `enrich`

> [!WARNING]
> `enrich` salta ogni ID già presente in `--output`: se `--input` non è della stessa run di un `graph_data_enriched.json` preesistente, gli ID in comune restano ai vecchi valori — nessun errore. Tieni i due file allineati, oppure elimina l'output per un ri-arricchimento completo (§9).

> [!WARNING]
> Interroga l'API pubblica Datatracker, soggetta a rate limiting: per un primo test usa `--skip-drafts`, che salta il fetch dei draft e si limita agli RFC pubblicati.

```bash
python rfc_pipeline.py enrich --input output/graph_data.json --output output/graph_data_enriched.json --skip-drafts
```

Run completo (produce anche i draft). Utile anche per testare **interruzione/ripresa**: `Ctrl+C` dopo qualche secondo, poi rilancia — il log deve riportare *"già processati: N"* con N > 0:

```bash
python rfc_pipeline.py enrich --input output/graph_data.json --output output/graph_data_enriched.json
```

Svuota la cache HTTP locale (utile contro un 404 "fantasma" da errore temporaneo):

```bash
python rfc_pipeline.py enrich --input output/graph_data.json --output output/graph_data_enriched.json --clear-cache
```

Riparti da zero ignorando `enriched_ids`:

```bash
python rfc_pipeline.py enrich --input output/graph_data.json --output output/graph_data_enriched.json --force
```

---

## 3. Comando `all` — pipeline completa

Stesso sotto-comando lanciato da `update_dataset.sh` (§6), qui con output locale invece che nel frontend:

```bash
python rfc_pipeline.py all rfc-index.xml --enriched-output output/graph_data_enriched.json
```

---

## 4. Verifiche sull'output

Conteggio nodi/archi e schema:

```bash
python -c "
import json
data = json.load(open('output/graph_data_enriched.json'))
print('Schema version:', data['meta']['schema_version'])
print('Nodi totali:', len(data['nodes']))
print('Archi totali:', len(data['edges']))

draft = sum(1 for n in data['nodes'] if n.get('is_draft'))
aborted = sum(1 for n in data['nodes'] if n.get('is_aborted'))
print('Draft attivi/scaduti:', draft)
print('Draft morti/sostituiti:', aborted)
print('RFC pubblicati:', len(data['nodes']) - draft - aborted)
"
```

Nodi con layer non risolto (deve essere una minoranza sugli RFC, quasi tutti sui draft):

```bash
python -c "
import json
data = json.load(open('output/graph_data_enriched.json'))
no_layer_rfc = sum(1 for n in data['nodes'] if n.get('layer') is None and not n.get('is_draft') and not n.get('is_aborted'))
no_layer_draft = sum(1 for n in data['nodes'] if n.get('layer') is None and (n.get('is_draft') or n.get('is_aborted')))
print('RFC senza layer:', no_layer_rfc, '| Draft senza layer:', no_layer_draft)
"
```

Archi pendenti (source/target assenti tra i nodi):

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

## 5. `draft_metadata_enricher.py`

> [!WARNING]
> Va lanciato **dopo** un `enrich` che abbia già prodotto draft (senza `--skip-drafts`): non crea nodi, arricchisce solo quelli già presenti e incompleti (`url` mancante o `year` nullo).

Run in place, con test di interruzione/ripresa come per `enrich`:

```bash
python draft_metadata_enricher.py --input output/graph_data_enriched.json --output output/graph_data_enriched.json
```

Test rapido su pochi nodi:

```bash
python draft_metadata_enricher.py --input output/graph_data_enriched.json --output output/graph_data_enriched.json --limit 20
```

Cache HTTP separata da `rfc_pipeline.py` (`.cache/datatracker_docdetail`), da svuotare a mano — non esiste un flag dedicato:

```bash
rm -rf .cache/datatracker_docdetail
```

Riparti da zero ignorando lo stato salvato:

```bash
python draft_metadata_enricher.py --input output/graph_data_enriched.json --output output/graph_data_enriched.json --force
```

Controllo finale — `url` deve essere sempre risolto, `year` può legittimamente restare `null` per una minoranza di documenti:

```bash
python -c "
import json
data = json.load(open('output/graph_data_enriched.json'))
draft_nodes = [n for n in data['nodes'] if n.get('is_draft') or n.get('is_aborted')]
senza_url = sum(1 for n in draft_nodes if not n.get('url'))
senza_year = sum(1 for n in draft_nodes if n.get('year') is None)
print('Senza url:', senza_url, '(atteso: 0) | Senza year:', senza_year, '(atteso: minoranza)')
"
```

---

## 6. `update_dataset.sh` — orchestratore automatico

Lanciato dagli hook `prestart`/`prebuild`: non serve invocarlo a mano. Scrive direttamente in `infovis/public/data/graph_data_enriched.json` ed esegue in ordine quattro fasi:

| Fase | Script | Cosa fa |
|---|---|---|
| `(0/4)` | — | Controlla se il dataset esiste già; se manca, prosegue comunque come primo run. |
| `(1/4)` | `rfc_pipeline.py all` | Parsing + arricchimento layer/working group + recupero draft (§1–§3). |
| `(2/4)` | `draft_metadata_enricher.py` | `url`/`year` sui soli draft/aborted (§5). |
| `(3/4)` | `purge_phantom_draft_nodes.py` | Rimuove nodi "fantasma" residui — di norma non trova nulla. |

> [!NOTE]
> `(0/4)` controlla solo la **presenza del file** dataset, non lo stato/cache della pipeline (`backend/.state`, `backend/.cache`): i due aspetti sono indipendenti (§9 vs §10).

Percorsi sovrascrivibili con variabili d'ambiente:

```bash
FRONTEND_DATA_DIR=/percorso/tuo/frontend/public/data npm run build
VENV_PYTHON=/percorso/tuo/venv/bin/python npm run build
```

Lancio manuale, senza build Angular:

```bash
cd backend
bash update_dataset.sh
```

---

## 7. Avvio del frontend

Da `infovis/` (non `backend/`):

```bash
cd infovis
npm install
npm run build       # esegue anche l'hook prebuild (§6)
```

> [!TIP]
> Dataset già aggiornato e vuoi solo ricompilare, senza rilanciare la pipeline? `npx ng build` salta l'hook `prebuild`.

Serve i file statici (`dist/infovis/browser/`) in locale:

```bash
cd dist/infovis/browser
php -S 127.0.0.1:8888
```

→ `http://127.0.0.1:8888`. Stop: `Ctrl+C`. Server minimale, solo per verifica locale — non per produzione.

In alternativa, `npm start`/`npx ng serve` avvia un server di sviluppo con live reload (URL stampato in console, di norma `http://localhost:4200`).

---

## 8. Pulizia tra un test e l'altro

> [!WARNING]
> Riavviare la pipeline solo dopo un'esecuzione completata per intero. Lo stato, l'output e la cache di `rfc_pipeline.py` non vengono scritti in modo atomico: in caso di interruzione, ripulire la directory `backend/` eseguendo `rm -rf .state/ .cache/datatracker/`.

Reset completo di `rfc_pipeline.py` (la prossima `enrich` rifà tutte le chiamate a Datatracker):

```bash
rm -rf .state .cache
```

Solo lo stato di `draft_metadata_enricher.py`:

```bash
rm -f .state/draft_metadata_state.json
rm -rf .cache/datatracker_docdetail
```

Solo la cache HTTP di `enrich` (equivalente a `--clear-cache`, senza rifare il resto del run) — comando dato dalla root del repository, da cui il prefisso `backend/`:

```bash
rm -rf backend/.cache/datatracker
```

---

## 9. Rigenerare il dataset da zero

> [!WARNING]
> `npm install` seguito da `npm start`/`npm run build`, con dataset assente, lancia in automatico l'intera pipeline (§6).

Vero primo run — repository appena clonato, niente dataset né stato: ogni documento va risolto da zero via API Datatracker, soggetta a rate limiting → **diverse ore**, non minuti.

```bash
git clone https://github.com/ilMassy/RFC-graph-visualizer.git
cd RFC-graph-visualizer/infovis
npm install
npm run build     # oppure: npm start
```

> [!IMPORTANT]
> Dataset assente ma `backend/.state`/`.cache` già presenti da un run precedente? Non aspettarti un run più rapido né completo — vedi §10.

Verifica al termine:

```bash
python -c "
import json
data = json.load(open('../infovis/public/data/graph_data_enriched.json'))
print('Nodi totali:', len(data['nodes']))
print('Archi totali:', len(data['edges']))
"
```

Equivalente manuale di `update_dataset.sh` (§6), **da dentro `backend/`**:

```bash
cd backend
source venv/bin/activate

python rfc_pipeline.py all rfc-index.xml --enriched-output ../infovis/public/data/graph_data_enriched.json
python draft_metadata_enricher.py --input ../infovis/public/data/graph_data_enriched.json --output ../infovis/public/data/graph_data_enriched.json
python purge_phantom_draft_nodes.py --input ../infovis/public/data/graph_data_enriched.json --output ../infovis/public/data/graph_data_enriched.json
```

> [!TIP]
> Non vuoi aspettare ore? Scarica il dataset pronto dalle [Releases](https://github.com/ilMassy/RFC-graph-visualizer/releases/tag/dataset-v3) e builda con `npx ng build` — vedi [README §1](../README.md#1--dataset-pronto-via-veloce).

---

## 10. Stato disallineato

`backend/.state` non coerente col dataset — dataset cancellato con stato rimasto, o sostituito con uno più vecchio (backup, release precedente). In entrambi i casi, `last_draft_fetch_iso` fa sì che Datatracker restituisca solo i draft modificati da quella data in poi: un buco silenzioso, senza errori né avvisi, sul recupero storico dei draft.

**Perché cancellare solo `.state/` non basta**: azzera `last_draft_fetch_iso`, ma la query "tutti i draft" risultante è identica a una già eseguita in passato, e la risposta è ancora su disco in `backend/.cache/datatracker/`, che non scade mai. I draft finiscono letti dalla cache vecchia invece che richiesti di nuovo. Riguarda solo chi cancella `.state/` su una macchina con almeno una scansione completa già fatta — non un vero primo run (§9), dove non esiste ancora cache da leggere per errore.

> [!IMPORTANT]
> Gli RFC non ne risentono: `rfc-index.xml` è sempre riscaricato fresco. Resta un solo caso limite accettato per design: un RFC noto il cui working group/layer sia cambiato su Datatracker dopo la prima cache resta congelato al valore vecchio.

**Soluzione** — cancella sia `.state/` sia `.cache/datatracker/` (non `.cache/datatracker_docdetail/`, estranea al problema), **dentro `backend/`**:

```bash
cd backend
rm -rf .state/ .cache/datatracker/
```

Poi rilancia normalmente (`npm start`/`npm run build`/`update_dataset.sh`, §6). Tempo dopo il reset: da decine di minuti a ore se il dataset è presente; **ore** come un primo run se il dataset è assente.

> [!NOTE]
> `rm -rf .state/` cancella anche lo stato di `draft_metadata_enricher.py`: previsto, va comunque rilanciato dopo un `enrich` completo.

---

## 11. Casi senza rischi

Due situazioni frequenti, **senza** il rischio di correttezza del §10: non serve cancellare nulla.

### 11a. Aggiornamento normale — dataset e `.state` coerenti

Il caso quotidiano. `last_draft_fetch_iso` avanza a ogni run → query sempre diversa → cache miss garantito, mai una risposta stantia. Gli RFC già risolti vengono saltati.

```bash
cd infovis
npm run build     # oppure: npm start
```

> [!WARNING]
> Non è un aggiornamento a costo fisso: `recheck_active_drafts()` ririnterroga Datatracker a ogni run, un documento alla volta e senza cache, tutti i draft `active`/`expired` già tracciati — per accorgersi se sono diventati RFC o sono stati abbandonati. Il tempo scala con quanti draft attivi sono già tracciati, non solo con le novità.

Vale anche se il dataset è stato sostituito con uno **più recente**: è l'opposto del §10, nessun buco possibile.

### 11b. Dataset pronto, poi aggiornato via pipeline

Dataset presente (da release o altra macchina) ma `backend/.state`/`.cache` **assenti**, perché la pipeline non ha mai girato qui. Passare a `npm run build` in questa condizione:

- non riproduce il bug del §10 — la cache è vuota, non vecchia;
- ma resta una scansione completa dei draft, non incrementale (manca `last_draft_fetch_iso`): circa 35.000 Internet-Draft su Datatracker, paginazione a 50 elementi per pagina → circa 700 pagine da scorrere — dipendendo da latenza e throttling delle richieste, qualche minuto in più rispetto al caso normale (§11a), non certo il tempo di un vero primo run (§9), perché gli RFC restano veloci (già risolti nel dataset scaricato).

Dopo la prima esecuzione locale, `.state`/`.cache` vengono creati: i run successivi si comportano come l'11a.
