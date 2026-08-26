# 🧪 Guida operativa del backend

Riferimento rapido per testare `backend/rfc_pipeline.py` e `backend/draft_metadata_enricher.py` singolarmente, e per gestire gli scenari di rigenerazione completa del dataset (`graph_data_enriched.json`), senza dover ricordare a memoria le opzioni.

> [!NOTE]
> Nell'uso normale **non serve lanciare nulla di questo a mano**: gli hook `prestart`/`prebuild` di `infovis/package.json` chiamano già `backend/update_dataset.sh` (§6) che esegue tutta la pipeline e scrive direttamente in `infovis/public/data/graph_data_enriched.json`. I comandi delle sezioni 1–5 scrivono invece in una cartella `output/` locale a `backend/`, comoda per test isolati senza toccare il dataset reale del frontend. Le sezioni 9–10 riguardano invece scenari reali di rigenerazione del dataset vero e proprio, già introdotti nel [README](../README.md#-come-iniziare) principale del progetto.

Da eseguire dentro `backend/`, con il virtualenv attivo:

```bash
cd percorso_cartella_backend
source venv/bin/activate
```

---

## 📑 Indice

1. [Fase `parse` — indice reale completo](#1-fase-parse--indice-reale-completo)
2. [Fase `enrich` — arricchimento via Datatracker](#2-fase-enrich--arricchimento-via-datatracker)
3. [Comando `all` — pipeline completa in un solo passaggio](#3-comando-all--pipeline-completa-in-un-solo-passaggio)
4. [Verifiche sull'output finale](#4-verifiche-sulloutput-finale)
5. [Fase `draft_metadata_enricher.py` — secondo passaggio, solo draft/aborted](#5-fase-draft_metadata_enricherpy--secondo-passaggio-solo-draftaborted)
6. [`update_dataset.sh` — l'orchestratore automatico](#6-update_datasetsh--lorchestratore-automatico)
7. [Avvio del sistema — build del frontend Angular e serving statico](#7-avvio-del-sistema--build-del-frontend-angular-e-serving-statico)
8. [Pulizia tra un test e l'altro](#8-pulizia-tra-un-test-e-laltro)
9. [Rigenerare il dataset da zero — dataset assente](#9-rigenerare-il-dataset-da-zero--dataset-assente)
10. [Stato disallineato — dataset assente o sostituito con uno più vecchio](#10-stato-disallineato--dataset-assente-o-sostituito-con-uno-più-vecchio)
    - [10c. Perché cancellare solo `.state/` non basta, e come risolvere davvero](#10c-perché-cancellare-solo-state-non-basta-e-come-risolvere-davvero)
11. [Casi senza rischi — aggiornamento normale e dataset scaricato poi aggiornato](#11-casi-senza-rischi--aggiornamento-normale-e-dataset-scaricato-poi-aggiornato)

---

## 1. Fase `parse` — indice reale completo

Per testare con `sample_rfc_index.xml` invece che con l'indice reale, usa `--offline`: salta del tutto `download_if_changed()`, quindi nessuna richiesta di rete e nessun rischio di sovrascrivere il file di esempio:

```bash
python rfc_pipeline.py parse sample_rfc_index.xml -o output/graph_data.json --offline
```

Con l'indice reale, il comando scarica (se necessario) `rfc-index.xml` e produce `graph_data.json`. Rilancialo una seconda volta, invariato, per verificare che il **download condizionale** funzioni: la seconda volta deve loggare *"non modificato dal server, nessun download"* invece di riscaricare tutto:

```bash
# 1ª esecuzione: scarica l'indice e genera graph_data.json
python rfc_pipeline.py parse rfc-index.xml -o output/graph_data.json

# 2ª esecuzione, identica: verifica il download condizionale (ETag/Last-Modified)
python rfc_pipeline.py parse rfc-index.xml -o output/graph_data.json
```

Forza un nuovo parsing completo ignorando lo stato salvato (utile dopo aver modificato `rfc_pipeline.py`):

```bash
python rfc_pipeline.py parse rfc-index.xml -o output/graph_data.json --force
```

---

## 2. Fase `enrich` — arricchimento via Datatracker

> [!WARNING]
> Interroga l'API pubblica di Datatracker: con il dataset reale (~10.000 RFC) ci vuole tempo per via del rate limiting (0.5s per richiesta). Per un primo test, usa `--skip-drafts` per saltare il fetch dei 34.000+ Internet-Draft e limitarti solo agli RFC pubblicati.

```bash
python rfc_pipeline.py enrich --input output/graph_data.json --output output/graph_data_enriched.json --skip-drafts
```

Run completo (produce anche i draft — è quello che genera il dataset finale). Usalo anche per testare l'**interruzione/ripresa**: lancialo, interrompi con `Ctrl+C` dopo qualche secondo, poi rilancia lo stesso comando: deve riprendere da dove si era fermato invece di ripartire da zero — verificalo controllando che il log iniziale riporti *"già processati: N"* con N > 0:

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

---

## 3. Comando `all` — pipeline completa in un solo passaggio

È lo stesso sotto-comando lanciato da `update_dataset.sh` (§6), lì con `--enriched-output` puntato direttamente a `infovis/public/data/graph_data_enriched.json` invece che a `output/`:

```bash
python rfc_pipeline.py all rfc-index.xml --enriched-output output/graph_data_enriched.json
```

---

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

> [!WARNING]
> Va lanciato **dopo** un `enrich` (§2) che abbia già prodotto `graph_data_enriched.json` con i draft dentro (cioè senza `--skip-drafts`): questo script non crea nodi, arricchisce solo quelli già presenti che risultano incompleti (`url` mancante o `year` nullo).

Run di base, in place sullo stesso file (input e output coincidono). Usalo anche per testare l'**interruzione/ripresa**: lancialo, interrompi con `Ctrl+C` dopo qualche secondo, poi rilancialo: deve riprendere da dove si era fermato invece di ripartire da zero — verificalo controllando che il log iniziale riporti *"già processati: N"* con N > 0:

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

Lanciato in automatico dagli hook `prestart`/`prebuild` definiti in `infovis/package.json`, quindi da `npm start`/`npm run build` non serve invocarlo a mano. Scrive direttamente in `infovis/public/data/graph_data_enriched.json` (nessuna cartella `output/` né copia manuale, a differenza dei comandi di test isolato delle sezioni 1–5) ed esegue, in ordine, quattro fasi loggate come `(0/4)`–`(3/4)`:

| Fase | Script | Cosa fa |
|---|---|---|
| `(0/4)` | — | Controlla se `graph_data_enriched.json` esiste già in `infovis/public/data/`: se manca, logga *"nessun dataset preesistente ... prima run da zero"* e prosegue comunque, senza bloccarsi. |
| `(1/4)` | `rfc_pipeline.py all` | Parsing dell'indice RFC + arricchimento layer/working group + recupero Internet-Draft (§1–§3). |
| `(2/4)` | `draft_metadata_enricher.py` | Secondo passaggio, solo su draft/aborted: `url` e `year` (§5). |
| `(3/4)` | `purge_phantom_draft_nodes.py` | Rimuove eventuali "nodi fantasma" (`is_draft` e `is_aborted` entrambi nulli) rimasti nel dataset. Nell'uso normale non trova nulla da fare — è una rete di sicurezza silenziosa. |

Solo dopo il completamento di tutte e quattro le fasi lo script cede il controllo alla build Angular (`ng build`).

> [!NOTE]
> La fase `(0/4)` controlla **solo la presenza del file** `graph_data_enriched.json`, non lo stato/cache della pipeline (`backend/.state`, `backend/.cache`). I due aspetti sono indipendenti: si può benissimo avere un dataset assente ma uno stato pregresso ancora presente sul disco (§9 lo tratta nel dettaglio), o viceversa un dataset presente ma frutto di uno stato ormai disallineato (§10).

Percorsi di default, sovrascrivibili con variabili d'ambiente prima di `npm`:

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

---

## 7. Avvio del sistema — build del frontend Angular e serving statico

Da dentro `infovis/` (la root del progetto Angular, non `backend/`), `npm run build` lancia da solo l'hook `prebuild` (§6) e poi la build, dopo aver scaricato tutte le dipendenze necessarie:

```bash
cd infovis
npm install
npm run build
```

> [!TIP]
> Se il dataset è già aggiornato e vuoi solo ricompilare Angular **senza** rilanciare l'intera pipeline dati, usa `npx ng build` per saltare l'hook `prebuild`:
> ```bash
> cd infovis
> npm install
> npx ng build
> ```

Per rigenerare il frontend dopo una modifica al codice Angular o dopo un aggiornamento del dataset, basta ripetere una delle due build sopra e poi ri-servire la cartella `dist/infovis/browser` aggiornata (fermando prima il server precedente se ancora attivo sulla stessa porta).

Servire i file statici generati (build in `dist/infovis/browser/`) con il server integrato di PHP, in ascolto solo su localhost:

```bash
cd dist/infovis/browser
php -S 127.0.0.1:8888
```

A questo punto il frontend è raggiungibile su `http://127.0.0.1:8888`. Per fermare il server: `Ctrl+C`.

> [!NOTE]
> Questo è un server di sviluppo/test minimale (serve solo file statici, nessuna configurazione di caching/compressione/HTTPS) — va bene per verificare il risultato di una build locale, non è pensato per un deploy in produzione.

---

## 8. Pulizia tra un test e l'altro

Rimuove stato e cache di `rfc_pipeline.py` per ripartire completamente da zero (usare con cautela: la prossima `enrich` rifà tutte le chiamate a Datatracker):

```bash
rm -rf .state .cache
```

`draft_metadata_enricher.py` usa un file di stato e una cache **separati** (`.state/draft_metadata_state.json` e `.cache/datatracker_docdetail/`), quindi il comando sopra li rimuove già entrambi se lanciato dalla stessa cartella `backend/`. Se invece vuoi azzerare **solo** lo stato del secondo script, lasciando intatti quelli di `rfc_pipeline.py`:

```bash
rm -f .state/draft_metadata_state.json
rm -rf .cache/datatracker_docdetail
```

Allo stesso modo, la cache HTTP della fase `enrich` di `rfc_pipeline.py` (§2) è **anch'essa separata** da quella di `draft_metadata_enricher.py`: vive in `.cache/datatracker`, non in `.cache/datatracker_docdetail`. Equivale a lanciare `enrich --clear-cache`, ma senza dover rifare anche il resto del run — comodo se vuoi solo forzare un refresh della cache prima del prossimo `enrich`. Da eseguire dalla root del repository (da qui il prefisso `backend/`):

```bash
rm -rf backend/.cache/datatracker
```

---

## 9. Rigenerare il dataset da zero — dataset assente

> [!WARNING]
> **`npm install` seguito da `npm start` o `npm run build`, con `graph_data_enriched.json` assente, lancia in automatico l'intera pipeline** (`update_dataset.sh`, §6): la fase `(0/4)` rileva l'assenza del file e logga *"nessun dataset preesistente ... prima run da zero"*, poi procede comunque con `(1/4)`–`(3/4)`.

Vero primo run — repository appena clonato, **niente dataset e niente stato** (`backend/.state`, `backend/.cache` assenti anch'essi): è lo scenario della [sezione 4 del README](../README.md#4--pipeline-dati-repository-nuovo-o-dataset-assente). Ogni singolo nodo (RFC + Internet-Draft, ~44.000 documenti) va risolto da zero tramite l'API IETF Datatracker, soggetta a **rate limiting** (0.5s per richiesta): il run richiede **diverse ore**, non minuti.

```bash
git clone https://github.com/ilMassy/RFC-graph-visualizer.git
cd RFC-graph-visualizer/infovis
npm install
npm run build     # oppure: npm start
```

> [!IMPORTANT]
> Se invece il dataset è assente ma trovi già `backend/.state`/`.cache` sul disco (da un run precedente sulla stessa macchina), **non aspettarti un run più rapido né un dataset completo**: passa direttamente alla [sezione 10](#10-stato-disallineato--dataset-assente-o-sostituito-con-uno-più-vecchio), che tratta esattamente questo caso.

Verifica dell'output al termine:

```bash
python -c "
import json
data = json.load(open('../infovis/public/data/graph_data_enriched.json'))
print('Nodi totali:', len(data['nodes']))
print('Archi totali:', len(data['edges']))
"
```

Equivalente manuale di quanto fa `update_dataset.sh` (§6):

```bash
cd backend
source venv/bin/activate

python rfc_pipeline.py all rfc-index.xml --enriched-output ../infovis/public/data/graph_data_enriched.json
python draft_metadata_enricher.py --input ../infovis/public/data/graph_data_enriched.json --output ../infovis/public/data/graph_data_enriched.json
python purge_phantom_draft_nodes.py --input ../infovis/public/data/graph_data_enriched.json --output ../infovis/public/data/graph_data_enriched.json
```

> [!TIP]
> Se non hai intenzione di aspettare ore, l'alternativa è **non** lanciare la pipeline: scarica il dataset già pronto dalla sezione [Releases](https://github.com/ilMassy/RFC-graph-visualizer/releases/tag/dataset-v2) del repository e builda con `npx ng build` (salta gli hook npm) — vedi la [sezione 1 del README](../README.md#1--dataset-pronto-via-veloce).

---

## 10. Stato disallineato — dataset assente o sostituito con uno più vecchio

Due situazioni concrete, diverse per come ci si arriva ma con **la stessa soluzione**: `backend/.state` non è coerente col dataset che si vuole ottenere.

### 10a. Dataset cancellato, ma `backend/.state` è rimasto

Hai cancellato o perso solo `infovis/public/data/graph_data_enriched.json` (es. ripulendo `infovis/public/data/`, cambiando cartella di progetto, testando a mano le sezioni 1–5), ma `backend/.state` è rimasto intatto da un run precedente. Log reale di questo scenario:

```
[update_dataset] (0/4) nessun dataset preesistente ... : prima run da zero.
INFO: Nodi totali: 9830 | già processati: 44993 | da processare: 9830
[...]
INFO: Query draft/aborted: 1 pagine, 40 documenti trovati, [...]
```

Due problemi, non uno:

1. **Non è più veloce** — *"da processare: 9830"* è il totale dei nodi di questo run: gli RFC vanno rielaborati **tutti**, perché `enrich` decide cosa è già risolto guardando il dataset di output, che qui manca. Il numero *"già processati: 44993"* è solo un contatore storico di `enriched_ids` accumulato nel tempo, e non evita il rate limiting su questo run → **ore**, come in un vero primo run (§9).
2. **Il dataset risulta incompleto** — il recupero dei draft si basa su una data, `last_draft_fetch_iso`, salvata in `backend/.state/enricher_state.json`: Datatracker restituisce solo i draft modificati **da quella data in poi**. Nel log sopra: *"40 documenti trovati"*, non le decine di migliaia attese (~34.000+ Internet-Draft).

### 10b. Dataset sostituito con uno più vecchio

Il file `graph_data_enriched.json` c'è, ma è stato **sostituito** con uno diverso e meno aggiornato (una release precedente, un backup, un dataset preso da un altro punto della cronologia del progetto), lasciando intatto `backend/.state/` prodotto da un run più recente. Qui l'arricchimento rete/working group degli RFC pubblicati resta veloce (guarda il contenuto del dataset presente, già risolto), ma i draft hanno lo stesso identico problema del punto 10a: `last_draft_fetch_iso` è più recente della data del dataset "vecchio", quindi i draft nella finestra intermedia non vengono mai ripescati — un buco silenzioso, senza errori né avvisi.

### 10c. Perché cancellare solo `.state/` non basta, e come risolvere davvero

Cancellare `backend/.state/` azzera `last_draft_fetch_iso`, quindi la query dei draft torna a essere una scansione completa — "tutti i draft", senza filtro temporale — identica a quella di un vero primo run (§9). Il problema: **quella identica query è già stata eseguita in passato**, e la sua risposta è ancora su disco in `backend/.cache/datatracker/`, cache che per design (§2, §8) non scade mai. Lo script *crede* di fare una scansione fresca, ma la serve dalla cache — la fotografia di Datatracker del primo fetch, non quella di oggi. Ogni draft creato, scaduto o diventato RFC dopo quel primo fetch resta invisibile, senza errori né avvisi.

> [!IMPORTANT]
> Il rischio è **specifico a 10a e 10b**, non generico a tutta la cache: nell'aggiornamento incrementale normale `last_draft_fetch_iso` cambia a ogni run → query diversa → cache miss garantito; nel vero primo run (§9) non esiste ancora nessuna cache vecchia da leggere per errore. Riguarda solo, in pratica, chi cancella `.state/` su una macchina che ha già fatto almeno una scansione completa in passato — cioè 10a/10b.
>
> Gli RFC non ne risentono: `rfc-index.xml` è sempre riscaricato fresco, e un RFC mai visto prima interroga una URL nuova → cache miss garantito. Resta un solo caso limite, accettato per design: un RFC noto il cui working group/layer sia cambiato su Datatracker dopo la prima cache resterebbe congelato al valore vecchio.

**Soluzione**: cancellare **sia** `.state/` **sia** la cache HTTP di `enrich`, `.cache/datatracker/` (non `.cache/datatracker_docdetail/`, quella di `draft_metadata_enricher.py`, estranea al problema):

```bash
cd backend
rm -rf .state/ .cache/datatracker/
```

Poi rilancia normalmente — direttamente o tramite `npm start`/`npm run build`/`update_dataset.sh` (§6):

```bash
python rfc_pipeline.py enrich --input output/graph_data.json --output output/graph_data_enriched.json
```

Tempo dopo il reset: nel caso 10b (dataset presente), decine di minuti o ore, limitato al ripescaggio fresco e all'aggiornamento dei draft. Nel caso 10a (dataset assente), comunque **ore** come in un vero primo run (§9) — qui la cache cancellata include anche quella, legittima, degli RFC già noti: nessun problema di correttezza (quell'arricchimento va comunque rifatto per intero), solo un piccolo overhead di rete in più.

> [!NOTE]
> `rm -rf .state/` cancella anche lo stato di `draft_metadata_enricher.py` (§5, §8): previsto, dato che lavora sui draft appena ripescati e va comunque rilanciato dopo un `enrich` completo.

---

## 11. Casi senza rischi — aggiornamento normale e dataset scaricato poi aggiornato

Due situazioni frequenti nell'uso reale, entrambe **senza il rischio di correttezza del §10**: non serve cancellare né `.state/` né `.cache/`.

### 11a. Aggiornamento normale — dataset e `.state` locali coerenti

Il caso quotidiano: dataset e `backend/.state` sono già presenti su questa macchina e coerenti tra loro. `last_draft_fetch_iso` avanza a ogni run, quindi la query dei *nuovi* draft cambia sempre → cache miss garantito, mai una risposta stantia (è il caso "sicuro" citato per contrasto al §10c). Gli RFC già risolti vengono saltati guardando il dataset di output. Rilancia normalmente:

```bash
cd infovis
npm run build     # oppure: npm start
```

> [!WARNING]
> Non è un aggiornamento a costo fisso di pochi minuti. Oltre alle novità, `recheck_active_drafts()` ririnterroga Datatracker **a ogni run**, un documento alla volta e sempre con `bypass_cache=True` (mai dalla cache locale), tutti i draft con stato `active`/`expired` già presenti nel dataset — serve per accorgersi se uno di loro è nel frattempo diventato RFC o è stato abbandonato. Il tempo scala quindi con **quanti draft attivi sono già tracciati**, non solo con quanto è cambiato dall'ultima volta: con molti draft attivi accumulati, anche un run "normale" può richiedere decine di minuti o ore.

### 11b. Dataset scaricato dalla release, poi aggiornato via pipeline

Situazione diversa dal §10, anche se solo all'apparenza simile: il dataset è presente (scaricato dalla [release](https://github.com/ilMassy/RFC-graph-visualizer/releases/tag/dataset-v2), non generato localmente), ma `backend/.state` e `backend/.cache` sono **entrambi assenti**, perché la pipeline non ha mai girato su questa macchina. Passare da `npx ng build` a `npm run build` in questa condizione:

- **non riproduce il bug del §10c** — la cache è vuota, non vecchia: non c'è nulla di stantio da servire, la scansione è reale e fresca;
- **ma resta comunque una scansione completa dei draft**, non incrementale (manca `last_draft_fetch_iso`): considerando la presenza di circa 35.000 Internet-Draft all'interno del Datatracker e una paginazione impostata a 50 elementi per pagina, la pipeline processerà complessivamente circa 700 pagine; dipendendo principalmente dalla latenza e dal throttling delle richieste di rete, il tempo di esecuzione aggiuntivo stimato si attesta nell'ordine di qualche minuto in più rispetto al caso normale (§11a) — che a sua volta, per il ricontrollo dei draft attivi appena descritto, non è già di per sé un caso rapido — non certo il tempo di un vero primo run (§9), perché gli RFC restano veloci (già risolti nel dataset scaricato, `enrich` li salta).

Dopo questa prima esecuzione locale, `.state`/`.cache` vengono creati: i run successivi si comportano come il caso normale (§11a).
