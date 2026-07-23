# RFC Graph Visualizer

Piattaforma per esplorare visivamente le relazioni storiche tra i documenti RFC dell'IETF (Internet Engineering Task Force) — in particolare i legami *Updates* e *Obsoletes* — tramite un grafo interattivo.

Progetto svolto in collaborazione con il gruppo di ricerca di Reti di Calcolatori dell'università Roma Tre.

## A chi è rivolto

Il sistema è pensato per due profili distinti, a cui rispondono le due viste del frontend:

- **Chi lavora dentro l'IETF e vuole studiare lo stato dell'arte degli RFC** — quanti documenti esistono, come si sono succeduti nel tempo, quali sono stati storicamente i più rilevanti (`impact_score`) e come si relazionano tra loro (Updates/Obsoletes). La vista a **grafo 3D**, con tutti i ~9.794 RFC pubblicati sempre visibili fin dall'apertura e il filtro per decade, è pensata per dare una visione d'insieme e una cronistoria navigabile.
- **Chi consulta gli RFC per un interesse specifico**, ad esempio un ricercatore universitario che parte da un argomento o da un documento noto. Per questo profilo contano soprattutto la ricerca testuale per id/titolo/parola chiave, il filtro per working group con conteggi, e la **timeline separata sui draft/aborted**, per seguire anche le proposte non ancora diventate RFC su un certo argomento.

## Stato del progetto

🚧 **In sviluppo.** Il repository contiene sia la pipeline dati (backend Python, due script: parsing/enrichment principale e un secondo passaggio dedicato ai draft) sia il frontend Angular — menu iniziale, grafo 3D degli RFC pubblicati, timeline a istogramma per draft/aborted — oltre ai comandi di test e alla documentazione tecnica. I dati generati dalla pipeline (`graph_data_enriched.json` e simili) **non** sono versionati: vanno rigenerati localmente (vedi [Come iniziare](#come-iniziare)).

## Architettura usata

Il progetto è diviso in due componenti indipendenti, collegate da un solo contratto: il file `graph_data_enriched.json`.

```
┌─────────────────────┐         ┌──────────────────────────┐
│   BACKEND (Python)   │         │    FRONTEND (Angular)    │
│                      │         │                          │
│  rfc_pipeline.py     │  JSON   │  GraphDataService        │
│   ├─ parse   ────────┼────────▶│   (carica, indicizza,    │
│   └─ enrich          │  file   │    gestisce il subset    │
│                      │ statico │    visibile)             │
│  draft_metadata_     │         │                          │
│   enricher.py        │         │  GraphCanvasComponent    │
│   (2° passaggio,     │         │   (D3.js su <canvas>:    │
│   solo draft/aborted)│         │    force simulation,     │
│                      │         │    zoom/pan, rendering)  │
│  Fonti esterne:      │         │                          │
│  - rfc-editor.org    │         │  DraftTimelineDataService│
│    (rfc-index.xml)   │         │  + DraftTimelineComponent│
│  - datatracker.ietf  │         │   (istogramma temporale, │
│    .org (REST API)   │         │    solo draft/aborted)   │
└─────────────────────┘         └──────────────────────────┘
```

**Python** è usato solo lato backend, come pipeline batch/offline: non serve nulla in tempo reale, il suo compito è produrre `graph_data_enriched.json` combinando due fonti autorevoli (l'indice ufficiale RFC e l'API IETF Datatracker), poi completato da un secondo script che risolve i campi ancora mancanti sui soli documenti draft/aborted.

**Angular** è il framework scelto per il frontend per la sua gestione nativa di stato reattivo (Signals) e componenti standalone, che si adatta bene alla separazione netta tra "chi decide cosa mostrare" (i due data service) e "chi disegna" (i due componenti di visualizzazione) — nessuno dei due deve conoscere i dettagli implementativi dell'altro. Il frontend è oggi diviso in due viste indipendenti, scelte da un menu iniziale: il grafo 3D dei soli RFC pubblicati, e una timeline separata per gli Internet-Draft attivi/scaduti/abortiti.

**D3.js** non viene usato per il rendering DOM/SVG (che con migliaia di elementi degraderebbe le prestazioni), ma solo per due sotto-sistemi:
- il motore di **force simulation** (calcolo iterativo delle posizioni x/y/z di ogni nodo in base alle forze — repulsione, collisione, attrazione lungo gli archi) nella vista a grafo 3D;
- la gestione di **zoom e pan** su `<canvas>` in entrambe le viste (grafo 3D e timeline).

Il disegno effettivo avviene su `<canvas>`/WebGL, pilotato dai dati che D3 aggiorna ad ogni "tick" della simulazione o ad ogni interazione di zoom/pan.

## Anteprima
 
![Grafo 3D con filtri per decade e working group](docs/Progetto_Infovis/img/grafo-filtri-decade-wg.png)
 
*Vista a grafo 3D: nodi RFC filtrabili per decade e working group, con il pannello di dettaglio del documento selezionato.*
 
![Timeline con filtro per working group e conteggi](docs/Progetto_Infovis/img/timeline-dettaglio-draft.png)
 
*Vista timeline draft/aborted: istogramma temporale filtrabile per working group, dettaglio del draft selezionato.*


## Struttura del repository

```
RFC-graph-visualizer/
├── backend/
│   ├── draft_metadata_enricher.py                                       # Secondo passaggio dopo rfc_pipeline.py, solo su nodi draft/aborted: url deterministico, year via Datatracker, normalizzazione abstract
│   ├── repair_draft_state.py                                            # Script di pulizia dello stato che sblocca i draft falliti per errori di rete, permettendo di ritentarli
│   ├── rfc_pipeline.py                                                  # Pipeline dati principale: parsing rfc-index.xml + arricchimento via IETF Datatracker (sotto-comandi: parse, enrich, all)
│   ├── sample_rfc_index.xml                                             # Indice RFC di esempio, ridotto, per test rapidi della fase `parse` senza scaricare il dataset reale
│   └── update_dataset.sh                                                # Orchestratore: lancia "rfc_pipeline.py all" + draft_metadata_enricher.py scrivendo direttamente in infovis/public/data/; richiamato in automatico dagli hook npm prestart/prebuild
├── docs/
│   ├── Progetto_Infovis/
│   │   ├── aggiornamenti_e_proposte/
│   │   │   ├── aggiornamenti_e_proposte_1.md                            # Aggiornamenti sullo stato del progetto e proposte sul design del grafo (versione 1)
│   │   │   └── aggiornamenti_e_proposte_2.md                            # Aggiornamenti: frontend Angular implementato, nuovo script di enrichment draft, proposta sull'automazione della pipeline (versione 2)
│   │   └── img/                                                         
│   │       ├── grafo-dettaglio-rfc1035.png                              # Pannello di dettaglio e focus sul nodo RFC1035 con evidenziazione dei vicini uscenti
│   │       ├── grafo-filtri-decade-wg.png                               # Pannello dei filtri avanzati per decade e ricerca testuale del Working Group ("idr")
│   │       ├── grafo-overview-completo.png                              # Vista d'insieme del grafo 3D completo (~9.794 RFC pubblicati renderizzati con WebGL)
│   │       ├── timeline-dettaglio-draft.png                             # Vista dell'istogramma temporale 2D per i draft, con selezione del documento e box esplicativo
│   │       └── timeline-filtro-wg-conteggi.png                          # Vista timeline filtrata sul Working Group "idr" con conteggi dinamici per gruppo
│   └── comandi_per_testare.md                                           # Comandi per clonare il repo, testare entrambi gli script della pipeline e avviare il frontend
├── infovis/                                                             # Frontend Angular standalone
│   ├── public/
│   │   └── favicon.ico
│   ├── src/
│   │   ├── app/
│   │   │   ├── components/
│   │   │   │   ├── draft-timeline/                                      # Istogramma temporale per draft/aborted (canvas 2D + d3-zoom)
│   │   │   │   ├── graph-canvas/                                        # Grafo 3D degli RFC pubblicati (D3 + force simulation)
│   │   │   │   └── landing-menu/                                        # Menu iniziale: scelta tra le due viste
│   │   │   ├── models/
│   │   │   │   └── graph.model.ts                                       # Interfacce dati condivise (nodi, archi, tipi RFC)
│   │   │   ├── services/
│   │   │   │   ├── draft-timeline-data.service.ts                       # Dati per la vista timeline (solo draft/aborted)
│   │   │   │   └── graph-data.service.ts                                # Dati per la vista a grafo (solo RFC pubblicati)
│   │   │   └──  app.config.ts / app.html / app.scss / app.ts
│   │   ├── index.html
│   │   ├── main.ts
│   │   └── styles.scss
│   ├── angular.json
│   ├── package-lock.json
│   ├── package.json
│   └── tsconfig.app.json / tsconfig.json / tsconfig.spec.json
├── .gitignore                                                           # Regole di esclusione: cache/stato pipeline, output JSON generati, ambiente Python, Angular
├── README.md                                                            # Questo file
└── requirements.txt                                                     # Dipendenze Python (nessuna esterna: solo libreria standard)
```

### `backend/rfc_pipeline.py`

Script Python unico con due fasi, eseguibili separatamente o in sequenza:

1. **`parse`** — scarica `rfc-index.xml` da rfc-editor.org (fetch condizionale via ETag/Last-Modified), fa il parsing di tutte le entry RFC, costruisce il grafo delle relazioni Updates/Obsoletes (con rilevamento e rimozione di eventuali contraddizioni), calcola un punteggio di autorevolezza (`impact_score`) tramite un PageRank pesato.
2. **`enrich`** — arricchisce ogni nodo con layer di rete e working group autorevoli, risolti tramite l'API pubblica di IETF Datatracker; recupera anche gli Internet-Draft (attivi, scaduti, morti, sostituiti).

### `backend/draft_metadata_enricher.py`

Secondo passaggio di arricchimento, separato dal primo per tenere distinte le responsabilità: lavora **solo** sui nodi draft/aborted già presenti in `graph_data_enriched.json` e completa i campi che il primo script lascia mancanti su di essi:

- **`url`** — costruito in modo deterministico dal nome del documento, senza chiamate di rete.
- **`year`** — risolto interrogando Datatracker (campo `time`, anno dell'ultima revisione nota — non la prima submission).
- **`abstract`** — normalizzato (whitespace collassato, troncamento con ellissi) su tutti i nodi del dataset.

Va lanciato dopo un `enrich` completo (senza `--skip-drafts`). Stesso paradigma incrementale del primo script: stato persistito su disco, cache HTTP (incluse le risposte 404), checkpoint periodici, retry con backoff.

## Come iniziare

Il repository non contiene i dati generati dalla pipeline (sono nel `.gitignore`), ma da quando esiste `backend/update_dataset.sh` la rigenerazione è **automatica**: gli hook `prestart`/`prebuild` di `infovis/package.json` lo lanciano da soli prima di `ng serve`/`ng build`, eseguendo in sequenza `rfc_pipeline.py all` e `draft_metadata_enricher.py` e scrivendo direttamente in `infovis/public/data/graph_data_enriched.json` — non serve più nessuna copia manuale. In sintesi:

1. Clonare il repository.
2. (opzionale) Creare un virtualenv in `backend/venv`: se assente, lo script ripiega sul `python3` di sistema.
3. Da `infovis/`, lanciare `npm install` e poi `npm run build` (o `npm start`).

⚠️ Il primo run può richiedere tempo per il rate limiting di Datatracker; i run successivi sono incrementali e molto più veloci. Per i comandi di test dei singoli script backend, le variabili d'ambiente di override (`FRONTEND_DATA_DIR`, `VENV_PYTHON`) e l'alternativa del dataset già pronto, vedi [`docs/comandi_per_testare.md`](docs/comandi_per_testare.md).

### Dataset già pronto (alternativa rapida)

Se non vuoi rilanciare l'intera pipeline (parsing + enrichment, che richiede tempo per il rate limiting di Datatracker), è disponibile un dataset già generato nella sezione [Releases](https://github.com/ilMassy/RFC-graph-visualizer/releases/tag/dataset-v1) del repository:

```bash
wget https://github.com/ilMassy/RFC-graph-visualizer/releases/download/dataset-v1/graph_data_enriched.zip
unzip graph_data_enriched.zip -d infovis/public/data/
```

⚠️ Il dataset scaricato riflette lo stato delle fonti IETF al momento della generazione (vedi il campo `meta.generated_at` dentro il JSON). Il prossimo `npm run build`/`npm start` rilancerà comunque `update_dataset.sh` sopra questo file: essendo incrementale non lo ricostruisce da zero, ma se `rfc-index.xml` non è già presente in `backend/` il primo di questi run lo scarica comunque.

## Aggiornamenti e proposte

Lo stato di avanzamento del progetto, dettagliato, e le proposte è tracciato nel documento:

- [`docs/Progetto_Infovis/aggiornamenti_e_proposte/aggiornamenti_e_proposte_2.md`](docs/Progetto_Infovis/aggiornamenti_e_proposte/aggiornamenti_e_proposte_2.md) — versione 2: frontend Angular implementato, script di enrichment per i draft, proposta sull'automazione della pipeline ecc...

## Riferimenti

- **RFC Editor** — [rfc-editor.org](https://www.rfc-editor.org/), fonte dell'indice ufficiale `rfc-index.xml` usato in fase di parsing.
- **IETF Datatracker** — [datatracker.ietf.org](https://datatracker.ietf.org/), fonte autorevole per layer di rete, working group, Internet-Draft e per la data di ultima revisione dei draft; API pubblica documentata su [datatracker.ietf.org/api/v1](https://datatracker.ietf.org/api/v1/).
- **IETF** — [ietf.org](https://www.ietf.org/), organizzazione responsabile dello sviluppo degli standard Internet documentati come RFC.
- **Brin, S., Page, L. (1998)** — [The Anatomy of a Large-Scale Hypertextual Web Search Engine (Archived)](https://web.archive.org/web/20230606095552/http://infolab.stanford.edu/~backrub/google.html), paper di riferimento per l'algoritmo PageRank originale, adattato come variante pesata per il calcolo dell'`impact_score` dei nodi RFC.
- **D3.js** — [d3js.org](https://d3js.org/), libreria usata nel frontend per la force simulation 3D e la gestione di zoom/pan.
- **Angular** — [angular.dev](https://angular.dev/), framework usato per il frontend.

## Autore
Massimiliano Giangreco.
