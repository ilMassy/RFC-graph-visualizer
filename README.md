<div align="center">
 
# 🕸️ RFC Graph Visualizer
 
**Esplora visivamente più di 40 anni di storia degli standard Internet dell'IETF**
 
![Angular](https://img.shields.io/badge/Angular-standalone-DD0031?logo=angular&logoColor=white)
![D3.js](https://img.shields.io/badge/D3.js-force--directed-F9A03C?logo=d3dotjs&logoColor=white)
![Python](https://img.shields.io/badge/Python-3-3776AB?logo=python&logoColor=white)
![Status](https://img.shields.io/badge/stato-in%20sviluppo-yellow)
![License](https://img.shields.io/badge/dati-IETF%20Datatracker%20%2B%20RFC--Editor-lightgrey)
 
</div>

Piattaforma per esplorare visivamente le relazioni storiche tra i documenti **RFC** dell'IETF (Internet Engineering Task Force) — in particolare i legami *Updates* e *Obsoletes* — tramite un **grafo 3D interattivo**, affiancato da una **timeline** dedicata ai documenti ancora in fase di bozza (Internet-Draft).
 
Progetto svolto in collaborazione con il gruppo di ricerca di Reti di Calcolatori dell'Università Roma Tre.
 
---
 
## 📑 Indice
 
- [A chi è rivolto](#-a-chi-è-rivolto)
- [Anteprima](#-anteprima)
- [Come iniziare](#-come-iniziare)
  - [Opzione consigliata — dataset già pronto](#-opzione-consigliata--dataset-già-pronto-pochi-minuti)
  - [Opzione completa — pipeline dati da zero](#-opzione-completa--pipeline-dati-da-zero-anche-diverse-ore)
- [Architettura](#-architettura)
- [Struttura del repository](#-struttura-del-repository)
- [Componenti principali del backend](#-componenti-principali-del-backend)
- [Relazione di progetto](#-relazione-di-progetto)
- [Riferimenti](#-riferimenti)
- [Autore](#-autore)
---
 
## 🎯 A chi è rivolto
 
Il sistema è pensato per due profili distinti, a cui rispondono le due viste del frontend:
 
| Profilo | Esigenza | Vista dedicata |
|---|---|---|
| 🏛️ **Chi lavora dentro l'IETF** e vuole studiare lo stato dell'arte degli RFC | Visione d'insieme: quanti documenti esistono, come si sono succeduti nel tempo, quali sono stati storicamente i più rilevanti (`impact_score`), come si relazionano tra loro | **Grafo 3D** — tutti gli RFC pubblicati sempre visibili, filtro per decade e working group |
| 🔎 **Chi consulta gli RFC per un interesse specifico** (es. un ricercatore universitario) | Ricerca puntuale: partire da un argomento o da un documento noto | **Ricerca testuale** per id/titolo/parola chiave + **Timeline** separata per draft/aborted |
 
---
 
## 🖼️ Anteprima
 
![Grafo 3D con filtri per decade e working group](docs/Progetto_Infovis/img/grafo-filtri-decade-wg.png)
 
*Vista a grafo 3D: nodi RFC filtrabili per decade e working group, con il pannello di dettaglio del documento selezionato.*
 
![Timeline con filtro per working group e conteggi](docs/Progetto_Infovis/img/timeline-dettaglio-draft.png)
 
*Vista timeline draft/aborted: istogramma temporale filtrabile per working group, dettaglio del draft selezionato.*
 
---
 
## 🚀 Come iniziare
 
> [!IMPORTANT]
> Il repository **non versiona** i dati generati dalla pipeline (sono nel `.gitignore`): vanno prodotti in locale. Esistono **due strade**, con un compromesso in tempo molto diverso — leggi bene prima di lanciare qualcosa.
 
### ✅ Opzione consigliata — dataset già pronto (pochi minuti)
 
Scarica il dataset già generato dalla sezione [Releases](https://github.com/ilMassy/RFC-graph-visualizer/releases/tag/dataset-v2) del repository ed evita del tutto la pipeline Python:
 
```bash
git clone https://github.com/ilMassy/RFC-graph-visualizer.git
cd RFC-graph-visualizer
 
wget https://github.com/ilMassy/RFC-graph-visualizer/releases/download/dataset-v2/graph_data_enriched.zip
unzip graph_data_enriched.zip -d infovis/public/data/
 
cd infovis
npm install
npx ng build
```
 
> [!TIP]
> Il comando chiave è **`npx ng build`** (o `npx ng serve` per lo sviluppo con reload automatico), **non** `npm run build` / `npm start`. La differenza non è stilistica: `npx ng ...` chiama direttamente Angular CLI **senza** passare dagli hook `prestart`/`prebuild` di npm, che altrimenti rilanciano comunque l'intera pipeline dati Python sopra il dataset appena scaricato per aggiornarlo con i dati più recenti dell'indice IETF, includendo gli ultimi RFC pubblicati e gli Internet-Draft aggiornati. Con `npx` il dataset scaricato viene usato così com'è, e la build richiede solo pochi istanti.
 
Avvia poi un server HTTP locale nella cartella di build (`dist/infovis/browser/`), ad esempio con il server integrato di PHP:
 
```bash
php -S 127.0.0.1:8888
```
 
e apri `http://127.0.0.1:8888` nel browser (`Ctrl+C` per fermare il server).
 
### 🐢 Opzione completa — pipeline dati da zero (anche diverse ore)
 
> [!WARNING]
> **`npm install` seguito da `npm start` o `npm run build`, senza il dataset già pronto, lancia in automatico l'intera pipeline Python** (`update_dataset.sh`, agganciata agli hook `prestart`/`prebuild`): parsing dell'indice RFC ufficiale **più** arricchimento di ~44.000 documenti tramite l'API IETF Datatracker. Il primo run è soggetto al **rate limiting** di Datatracker e può richiedere **diverse ore**, non minuti. Se non hai intenzione di aspettare, usa l'[opzione consigliata](#-opzione-consigliata--dataset-già-pronto-pochi-minuti) qui sopra con `npx`.
 
Questa strada ha senso solo se vuoi rigenerare il dataset da zero (ad esempio per verificarne l'aggiornamento rispetto alle fonti IETF più recenti):
 
```bash
git clone https://github.com/ilMassy/RFC-graph-visualizer.git
cd RFC-graph-visualizer
 
# opzionale: virtualenv dedicato in backend/venv — se assente, si ripiega sul python3 di sistema
 
cd infovis
npm install
npm run build     # oppure: npm start
```
 
I run **successivi** al primo sono incrementali (stato e cache HTTP persistiti su disco) e molto più rapidi — ma solo il primo run, quello che parte da un repository appena clonato, sconta per intero il rate limiting iniziale.
 
📄 Per i comandi di test dei singoli script backend, le variabili d'ambiente di override (`FRONTEND_DATA_DIR`, `VENV_PYTHON`) e altri dettagli, vedi [`docs/comandi_per_testare.md`](docs/comandi_per_testare.md).
 
---
 
## 🏗️ Architettura
 
Il progetto è diviso in due componenti indipendenti, collegate da un solo contratto: il file statico `graph_data_enriched.json`.
 
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
 
- **Python** è usato solo lato backend, come pipeline batch/offline: produce `graph_data_enriched.json` combinando due fonti autorevoli (l'indice ufficiale RFC e l'API IETF Datatracker), poi completato da un secondo script che risolve i campi ancora mancanti sui soli documenti draft/aborted.
- **Angular** è il framework scelto per il frontend per la sua gestione nativa di stato reattivo (Signals) e componenti standalone, che si adatta bene alla separazione netta tra "chi decide cosa mostrare" (i due data service) e "chi disegna" (i due componenti di visualizzazione). Il frontend è diviso in due viste indipendenti, scelte da un menu iniziale: il grafo 3D dei soli RFC pubblicati, e una timeline separata per gli Internet-Draft attivi/scaduti/abortiti.
- **D3.js** non viene usato per il rendering DOM/SVG (che con migliaia di elementi degraderebbe le prestazioni), ma solo per due sotto-sistemi: il motore di **force simulation** nella vista a grafo 3D, e la gestione di **zoom/pan** su `<canvas>` in entrambe le viste. Il disegno effettivo avviene su `<canvas>`/WebGL, pilotato dai dati che D3 aggiorna ad ogni tick della simulazione o ad ogni interazione.
---
 
## 📂 Struttura del repository
 
```
RFC-graph-visualizer/
├── backend/
│   ├── draft_metadata_enricher.py    # 2° passaggio, solo su nodi draft/aborted: url deterministico, year via Datatracker, normalizzazione abstract
│   ├── purge_phantom_draft_nodes.py  # Rimuove &quot;nodi fantasma&quot; con is_draft e is_aborted entrambi nulli
│   ├── repair_draft_state.py         # Pulizia dello stato che sblocca i draft falliti per errori di rete, per ritentarli
│   ├── rfc_pipeline.py               # Pipeline dati principale: parsing rfc-index.xml + arricchimento via IETF Datatracker (sotto-comandi: parse, enrich, all)
│   ├── sample_rfc_index.xml          # Indice RFC ridotto, per test rapidi della fase `parse` (--offline, nessuna rete)
│   └── update_dataset.sh             # Orchestratore: lancia &quot;rfc_pipeline.py all&quot; + draft_metadata_enricher.py; richiamato dagli hook npm prestart/prebuild
│
├── docs/
│   ├── Progetto_Infovis/
│   │   ├── img/                                         # Screenshot referenziati dalla relazione e da questo README
│   │   └── Relazione_Progetto_RFC-Graph-Visualizer.md   # Relazione di progetto completa (problema, dati, design, risultati, sviluppi futuri)
│   └── comandi_per_testare.md        # Comandi per clonare il repo, testare i singoli script backend, avviare il frontend
│
├── infovis/                          # Frontend Angular standalone
│   ├── public/
│   │   └── favicon.ico
│   ├── src/
│   │   ├── app/
│   │   │   ├── components/
│   │   │   │   ├── draft-timeline/   # Istogramma temporale per draft/aborted (canvas 2D + d3-zoom)
│   │   │   │   ├── graph-canvas/     # Grafo 3D degli RFC pubblicati (D3 + force simulation)
│   │   │   │   └── landing-menu/     # Menu iniziale: scelta tra le due viste
│   │   │   ├── models/
│   │   │   │   └── graph.model.ts    # Interfacce dati condivise (nodi, archi, tipi RFC)
│   │   │   ├── services/
│   │   │   │   ├── draft-timeline-data.service.ts   # Dati per la vista timeline (solo draft/aborted)
│   │   │   │   └── graph-data.service.ts            # Dati per la vista a grafo (solo RFC pubblicati)
│   │   │   └── app.config.ts / app.html / app.scss / app.ts
│   │   ├── index.html
│   │   ├── main.ts
│   │   └── styles.scss
│   ├── angular.json
│   ├── package-lock.json
│   ├── package.json
│   └── tsconfig.app.json / tsconfig.json / tsconfig.spec.json
│
├── .gitignore                        # Esclude cache/stato pipeline, output JSON generati, ambiente Python, Angular
├── README.md                         # Questo file
└── requirements.txt                  # Dipendenze Python (nessuna esterna: solo libreria standard)
```
 
---
 
## 🧩 Componenti principali del backend
 
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
 
---
 
## 📘 Relazione di progetto
 
Lo sviluppo del sistema — problema affrontato, modello dei dati, principi di visualizzazione applicati, scelte di design (force simulation, clustering per community, filtri, codifica visiva), criticità risolte durante lo sviluppo, risultati e sviluppi futuri — è documentato per intero nella relazione di progetto:
 
- 📄 [`docs/Progetto_Infovis/Relazione_Progetto_RFC-Graph-Visualizer.md`](docs/Progetto_Infovis/Relazione_Progetto_RFC-Graph-Visualizer.md)
---
 
## 📚 Riferimenti
 
- **RFC Editor** — [rfc-editor.org](https://www.rfc-editor.org/), fonte dell'indice ufficiale `rfc-index.xml` usato in fase di parsing.
- **IETF Datatracker** — [datatracker.ietf.org](https://datatracker.ietf.org/), fonte autorevole per layer di rete, working group, Internet-Draft e per la data di ultima revisione dei draft; API pubblica documentata su [datatracker.ietf.org/api/v1](https://datatracker.ietf.org/api/v1/).
- **IETF** — [ietf.org](https://www.ietf.org/), organizzazione responsabile dello sviluppo degli standard Internet documentati come RFC.
- **Brin, S., Page, L. (1998)** — [The Anatomy of a Large-Scale Hypertextual Web Search Engine (Archived)](https://web.archive.org/web/20230606095552/http://infolab.stanford.edu/~backrub/google.html), paper di riferimento per l'algoritmo PageRank originale, adattato come variante pesata per il calcolo dell'`impact_score` dei nodi RFC.
- **Raghavan, U.N., Albert, R., Kumara, S. (2007)** — [Near linear time algorithm to detect community structures in large-scale networks](https://journals.aps.org/pre/abstract/10.1103/PhysRevE.76.036106), Phys. Rev. E 76, 036106, paper di riferimento per il Label Propagation Algorithm (LPA) usato per il clustering spaziale dei nodi.
- **D3.js** — [d3js.org](https://d3js.org/), libreria usata nel frontend per la force simulation 3D e la gestione di zoom/pan.
- **Angular** — [angular.dev](https://angular.dev/), framework usato per il frontend.
---
 
## 👤 Autore
 
**Massimiliano Giangreco**
 
