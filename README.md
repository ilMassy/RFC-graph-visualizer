# RFC Graph Visualizer

Piattaforma per esplorare visivamente le relazioni storiche tra i documenti RFC dell'IETF (Internet Engineering Task Force) — in particolare i legami *Updates* e *Obsoletes* — tramite un grafo interattivo.

Progetto svolto in collaborazione con il gruppo di ricerca di Reti di Calcolatori dell'università RomaTre.

## Stato del progetto

🚧 **In sviluppo.** Al momento questo repository contiene solo la pipeline dati (backend Python), i comandi di test e la documentazione tecnica. Il frontend (Angular + D3.js) esiste in locale ma non è ancora stato aggiunto al repository.

## Architettura usata

Il progetto è diviso in due componenti indipendenti, collegate da un solo contratto: un file JSON.

```
┌─────────────────────┐         ┌──────────────────────────┐
│   BACKEND (Python)   │         │    FRONTEND (Angular)    │
│                      │         │                          │
│  rfc_pipeline.py     │  JSON   │  GraphDataService        │
│   ├─ parse   ────────┼────────▶│   (carica, indicizza,    │
│   └─ enrich          │  file   │    gestisce il subset    │
│                      │ statico │    visibile)             │
│  Fonti esterne:      │         │                          │
│  - rfc-editor.org    │         │  GraphCanvasComponent    │
│    (rfc-index.xml)   │         │   (D3.js su <canvas>:    │
│  - datatracker.ietf  │         │    force simulation,     │
│    .org (REST API)   │         │    zoom/pan, rendering)  │
└─────────────────────┘         └──────────────────────────┘
```

**Python** è usato solo lato backend, come pipeline batch/offline: non serve nulla in tempo reale, il suo unico compito è produrre `graph_data_enriched.json` combinando due fonti auto>

**Angular** è il framework scelto per il frontend per la sua gestione nativa di stato reattivo (Signals) e componenti standalone, che si adatta bene alla separazione netta richiesta t>

**D3.js** non viene usato per il rendering DOM/SVG (che con migliaia di elementi degraderebbe le prestazioni), ma solo per due sotto-sistemi:
- il motore di **force simulation** (calcolo iterativo delle posizioni x/y di ogni nodo in base alle forze — repulsione, collisione, attrazione lungo gli archi);
- la gestione di **zoom e pan** sul canvas.

Il disegno effettivo avviene su `<canvas>` con l'API 2D nativa del browser, pilotata dai dati che D3 aggiorna ad ogni "tick" della simulazione.

## Struttura del repository

```
INFOVIS/
├── backend/
│   └── rfc_pipeline.py                          # Pipeline dati: parsing rfc-index.xml + arricchimento via IETF Datatracker (unico script, due sotto-comandi: parse, enrich)
├── docs/
│   ├── comandi_per_testare.md                   # Comandi di test per gli script della pipeline (fase di parsing)
│   └── Progetto_Infovis/
│       └── aggiornamenti_e_proposte/
│           └── aggiornamenti_e_proposte_1.md    # Aggiornamenti sullo stato del progetto e proposte sul design del grafo (versione 1)
├── .gitignore                                   # Regole di esclusione: cache/stato pipeline, output JSON generati, ambiente Python, Angular (in previsione)
├── README.md                                    # Questo file
└── requirements.txt                             # Dipendenze Python (nessuna esterna: solo libreria standard)
```

### `backend/rfc_pipeline.py`

Script Python unico con due fasi, eseguibili separatamente o in sequenza:

1. **`parse`** — scarica `rfc-index.xml` da rfc-editor.org (fetch condizionale via ETag/Last-Modified), fa il parsing di tutte le entry RFC, costruisce il grafo delle relazioni Updates/Obsoletes (con rilevamento e rimozione di eventuali contraddizioni), calcola un punteggio di autorevolezza (`impact_score`) tramite un PageRank pesato.
2. **`enrich`** — arricchisce ogni nodo con layer di rete e working group autorevoli, risolti tramite l'API pubblica di IETF Datatracker; recupera anche gli Internet-Draft (attivi, scaduti, morti, sostituiti).

I comandi di test dettagliati sono in [`docs/comandi_per_testare.md`](docs/comandi_per_testare.md).

## Riferimenti

- **RFC Editor** — [rfc-editor.org](https://www.rfc-editor.org/), fonte dell'indice ufficiale `rfc-index.xml` usato in fase di parsing.
- **IETF Datatracker** — [datatracker.ietf.org](https://datatracker.ietf.org/), fonte autorevole per layer di rete, working group e Internet-Draft; API pubblica documentata su [datatracker.ietf.org/api/v1](https://datatracker.ietf.org/api/v1/).
- **IETF** — [ietf.org](https://www.ietf.org/), organizzazione responsabile dello sviluppo degli standard Internet documentati come RFC.
- Brin, S., Page, L. — *The Anatomy of a Large-Scale Hypertextual Web Search Engine* (1998) — algoritmo PageRank originale, alla base della variante pesata usata per calcolare `impact_score`.
- **D3.js** — [d3js.org](https://d3js.org/), libreria usata (prevista) per il layout a forze e il rendering del grafo nel frontend.
- **Angular** — [angular.dev](https://angular.dev/), framework usato (previsto) per il frontend.

## Autore
Massimiliano Giangreco.
