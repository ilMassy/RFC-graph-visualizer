<div align="center">

# 🕸️ RFC Graph Visualizer

**Esplora visivamente più di 40 anni di storia degli standard Internet dell'IETF**

![Angular](https://img.shields.io/badge/Angular-standalone-DD0031?logo=angular&logoColor=white)
![D3.js](https://img.shields.io/badge/D3.js-force--directed-F9A03C?logo=d3dotjs&logoColor=white)
![Python](https://img.shields.io/badge/Python-3-3776AB?logo=python&logoColor=white)
![Status](https://img.shields.io/badge/stato-in%20sviluppo-yellow)
![License](https://img.shields.io/badge/dati-IETF%20Datatracker%20%2B%20RFC--Editor-lightgrey)
![OS](https://img.shields.io/badge/OS-Unix--like-FCC624?logo=linux&logoColor=black)

</div>

Piattaforma per esplorare visivamente le relazioni storiche tra i documenti **RFC** dell'IETF (Internet Engineering Task Force) — in particolare i legami *Updates* e *Obsoletes* — tramite un **grafo 3D interattivo**, affiancato da una **timeline** dedicata ai documenti ancora in fase di bozza (Internet-Draft).

Progetto svolto in collaborazione con il gruppo di ricerca di Reti di Calcolatori dell'Università Roma Tre.

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
> Il dataset (`graph_data_enriched.json`) **non è versionato** (è nel `.gitignore`): va scaricato o generato. `npm run build` / `npm start` rigenerano sempre il dataset in automatico (hook `prebuild`/`prestart`, script `backend/update_dataset.sh`); `npx ng build` / `npx ng serve` lo saltano e usano il dataset così com'è.

| Situazione | Comando | Tempo |
|---|---|---|
| Voglio partire subito, non mi serve il dataset più recente | [§1](#1--dataset-pronto-via-veloce) — scarica la release + `npx ng build` | pochi minuti |
| Repository appena clonato, nessun dataset e nessuno stato pregresso | [§2](#2--pipeline-dati-repository-nuovo-o-dataset-assente) — `npm install && npm run build` | ore (rate limiting Datatracker) |
| Dataset assente ma `backend/.state` esiste ancora, **oppure** dataset sostituito con uno più vecchio | [§3](#3--stato-disallineato-dataset-assente-o-sostituito) — `rm -rf backend/.state/ backend/.cache/datatracker/` poi `npm run build` | ore (comunque da rifare gli RFC e i draft) |

### 1. 🏁 Dataset pronto, via veloce

```bash
git clone https://github.com/ilMassy/RFC-graph-visualizer.git
cd RFC-graph-visualizer

wget https://github.com/ilMassy/RFC-graph-visualizer/releases/download/dataset-v2/graph_data_enriched.zip
unzip graph_data_enriched.zip -d infovis/public/data/

cd infovis
npm install
npx ng build
```

Poi, dentro `dist/infovis/browser/`: `php -S 127.0.0.1:8888` → apri `http://127.0.0.1:8888`.

### 2. 🐢 Pipeline dati (repository nuovo o dataset assente)

```bash
git clone https://github.com/ilMassy/RFC-graph-visualizer.git
cd RFC-graph-visualizer/infovis
npm install
npm run build     # oppure: npm start
```

`update_dataset.sh` rileva da solo l'assenza del dataset e lo rigenera prima della build: risolve ~44.000 documenti via API Datatracker, soggetta a rate limiting → **ore**, sia a repository appena clonato sia se `backend/.state` esiste già da run precedenti (l'assenza del solo file dataset non velocizza nulla, anzi: vedi [§3](#3--stato-disallineato-dataset-assente-o-sostituito)).

📄 Dettagli e comandi manuali dei singoli script → [`docs/guida-operativa-backend.md`](docs/guida-operativa-backend.md#9-rigenerare-il-dataset-da-zero--dataset-assente).

### 3. 🔄 Stato disallineato (dataset assente o sostituito)

Stessa soluzione per due situazioni distinte, entrambe con `backend/.state` non coerente col dataset che si vuole ottenere:

- **dataset cancellato ma stato rimasto** (es. hai ripulito solo `infovis/public/data/`): il dataset ricostruito ha comunque bisogno di **ore** per gli RFC (l'output mancante costringe a rielaborarli tutti, indipendentemente dallo stato) e in più risulta **incompleto sui draft**, perché lo stato ricorda solo la data dell'ultimo fetch e Datatracker restituisce quindi pochissimi draft, non l'intero storico (~34.000+);
- **dataset sostituito con uno più vecchio** (backup, release precedente): stesso problema sui draft, per lo stesso motivo.

> [!WARNING]
> Cancellare solo `backend/.state/` **non basta**. Azzera la data dell'ultimo fetch, ma la query "tutti i draft" che ne risulta è identica, parola per parola, a una già eseguita in passato — e la sua risposta è ancora su disco in `backend/.cache/datatracker/`, che per design non scade mai. Risultato: i draft vengono letti dalla cache vecchia invece che richiesti di nuovo a Datatracker, senza errori né avvisi. Va cancellata **anche** quella cache, non solo lo stato — vale solo per questi due scenari, non per un aggiornamento incrementale normale né per un vero primo run ([§9](docs/guida-operativa-backend.md#9-rigenerare-il-dataset-da-zero--dataset-assente)).

```bash
cd backend
rm -rf .state/ .cache/datatracker/
cd ../infovis
npm run build     # oppure: npm start
```

📄 Perché succede, con log ed evidenze reali → [`docs/guida-operativa-backend.md`](docs/guida-operativa-backend.md#10-stato-disallineato--dataset-assente-o-sostituito-con-uno-più-vecchio).

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
│   ├── purge_phantom_draft_nodes.py  # Rimuove "nodi fantasma" con is_draft e is_aborted entrambi nulli
│   ├── repair_draft_state.py         # Pulizia dello stato che sblocca i draft falliti per errori di rete, per ritentarli
│   ├── rfc_pipeline.py               # Pipeline dati principale: parsing rfc-index.xml + arricchimento via IETF Datatracker (sotto-comandi: parse, enrich, all)
│   ├── sample_rfc_index.xml          # Indice RFC ridotto, per test rapidi della fase `parse` (--offline, nessuna rete)
│   └── update_dataset.sh             # Orchestratore: lancia "rfc_pipeline.py all" + draft_metadata_enricher.py; richiamato dagli hook npm prestart/prebuild
│
├── docs/
│   ├── Progetto_Infovis/
│   │   ├── img/                                         # Screenshot referenziati dalla relazione e da questo README
│   │   └── Relazione_Progetto_RFC-Graph-Visualizer.md   # Relazione di progetto completa (problema, dati, design, risultati, sviluppi futuri)
│   └── guida-operativa-backend.md    # Comandi per clonare il repo, testare i singoli script backend, rigenerare il dataset, avviare il frontend
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

### `backend/purge_phantom_draft_nodes.py`

Terzo e ultimo passaggio automatico, eseguito da `update_dataset.sh` dopo `draft_metadata_enricher.py`: rimuove eventuali "nodi fantasma" rimasti nel dataset, cioè nodi con `is_draft` e `is_aborted` entrambi nulli (né RFC pubblicato né draft riconosciuto). Nell'uso normale non trova nulla da rimuovere: è una rete di sicurezza silenziosa più che un passaggio che modifica il dataset a ogni run.

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
