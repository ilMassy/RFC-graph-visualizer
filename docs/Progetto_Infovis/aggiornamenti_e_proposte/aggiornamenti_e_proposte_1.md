# RFC Graph Visualizer

**Stato:** pipeline Python funzionante e testata su dati reali; frontend Angular/D3.js **in fase di progettazione**, non ancora scritto.

---

## Indice

1. [Architettura usata](#1-architettura-usata)
2. [Struttura del JSON enriched — ogni campo nel dettaglio](#2-struttura-del-json-enriched--ogni-campo-nel-dettaglio)
3. [Perché esistono sia `layer_hint` che `layer`](#3-perché-esistono-sia-layer_hint-che-layer)
4. [Come vengono ricavati draft e aborted — e se i numeri tornano](#4-come-vengono-ricavati-draft-e-aborted--e-se-i-numeri-tornano)
5. [Quanti sono i documenti totali (RFC + draft + aborted)](#5-quanti-sono-i-documenti-totali-rfc--draft--aborted)
6. [Clusterizzazione nel grafo e soglia per il Core Backbone](#6-clusterizzazione-nel-grafo-e-soglia-per-il-core-backbone)
7. [Come viene calcolato l'impact score (PageRank pesato)](#7-come-viene-calcolato-limpact-score-pagerank-pesato)
8. [Proposta: includere TUTTI i nodi nel grafo](#8-proposta-includere-tutti-i-nodi-nel-grafo-anche-draft-e-aborted)
9. [Barra temporale e posizionamento per anno](#9-barra-temporale-e-posizionamento-per-anno)
10. [Abstract e keywords nel pannello di dettaglio](#10-abstract-e-keywords-nel-pannello-di-dettaglio)
11. [Come si intende strutturare il grafo, in sintesi](#11-come-si-intende-strutturare-il-grafo-in-sintesi)
12. [Aggiornamento automatico di `graph_data_enriched.json`](#12-aggiornamento-automatico-di-graph_data_enrichedjson)

---

## 1 Architettura usata

Il progetto è diviso in due componenti indipendenti, collegate da un solo contratto: un file JSON.

```
┌─────────────────────┐         ┌──────────────────────────┐
│   BACKEND (Python)  │         │    FRONTEND (Angular)    │
│                     │         │                          │
│  rfc_pipeline.py    │  JSON   │  GraphDataService        │
│   ├─ parse   ───────┼────────▶│   (carica, indicizza,    │
│   └─ enrich         │  file   │    gestisce il subset    │
│                     │ statico │    visibile)             │
│  Fonti esterne:     │         │                          │
│  - rfc-editor.org   │         │  GraphCanvasComponent    │
│    (rfc-index.xml)  │         │   (D3.js su <canvas>:    │
│  - datatracker.ietf │         │    force simulation,     │
│    .org (REST API)  │         │    zoom/pan, rendering)  │
└─────────────────────┘         └──────────────────────────┘
```

**Python** è usato solo lato backend, come pipeline batch/offline: non serve nulla in tempo reale, il suo unico compito è produrre `graph_data_enriched.json` combinando due fonti autorevoli (l'indice ufficiale RFC e l'API IETF Datatracker). Non espone un'API HTTP: il collegamento col frontend è il file JSON stesso.

**Angular** è il framework scelto per il frontend per la sua gestione nativa di stato reattivo (Signals) e componenti standalone, che si adatta bene alla separazione netta richiesta tra "chi decide cosa mostrare" (`GraphDataService`) e "chi disegna" (`GraphCanvasComponent`) — nessuno dei due deve conoscere i dettagli implementativi dell'altro.

**D3.js** non viene usato per il rendering DOM/SVG (che con migliaia di elementi degraderebbe le prestazioni), ma solo per due sotto-sistemi:
- il motore di **force simulation** (calcolo iterativo delle posizioni x/y di ogni nodo in base alle forze — repulsione, collisione, attrazione lungo gli archi);
- la gestione di **zoom e pan** sul canvas.

Il disegno effettivo avviene su `<canvas>` con l'API 2D nativa del browser, pilotata dai dati che D3 aggiorna ad ogni "tick" della simulazione.

---

## 2. Struttura del JSON enriched — ogni campo nel dettaglio

Il file prodotto (`graph_data_enriched.json`, `schema_version: "1.2"`) ha tre blocchi: `meta`, `nodes`, `edges`.

### 2.1 Blocco `meta`

| Campo | Significato | Come viene ricavato |
|---|---|---|
| `schema_version` | Versione dello schema dati (`"1.2"`), costante nel codice (`SCHEMA_VERSION`) | Hardcoded; usata per rilevare drift di schema quando un file più vecchio viene ricaricato (`load_graph()` logga un warning se non combacia) |
| `generated_at` | Timestamp ISO 8601 UTC di quando il file è stato scritto | `now_iso()`, calcolato al momento del salvataggio (`checkpoint()`/`save_graph()`) |
| `generated_by` | Stringa descrittiva di quale comando/fase ha prodotto il file | Es. `"rfc_pipeline.py enrich (run completo)"` — utile per capire se il file è frutto di un run completo o di un checkpoint intermedio interrotto |

### 2.2 Campi di ogni nodo

| Campo | Significato | Come viene ricavato | Sempre presente? |
|---|---|---|---|
| `id` | Identificativo univoco del documento (es. `"RFC791"`, `"DRAFT-LIOR-..."`) | Per gli RFC: tag `<doc-id>` dell'XML. Per i draft: campo `name` della risposta Datatracker, maiuscolizzato | Sì |
| `url` | Link alla pagina ufficiale del documento | Solo per RFC: costruito come `rfc-editor.org/rfc/{id}.html` in `parse_entry()` | **No** — assente sui draft (Datatracker non fornisce un URL comparabile in questa fase) |
| `title` | Titolo del documento | Tag `<title>` XML per gli RFC; campo `title` della risposta Datatracker per i draft | Sì |
| `abstract` | Riassunto testuale | RFC: concatenazione di **tutti** i paragrafi `<p>` dentro `<abstract>` (non solo il primo). Draft: campo `abstract` della risposta Datatracker, solo se di tipo stringa | Sì (può essere stringa vuota) |
| `status` | Stato editoriale | RFC: tag `<current-status>` (es. `"UNKNOWN"`, `"PROPOSED STANDARD"`). Draft: lo *slug* dello stato bozza (`active`/`expired`/`dead`/`repl`) risolto da `resolve_document_state_slug()` | Sì |
| `year` | Anno di pubblicazione | Solo per RFC: tag `<date><year>` XML | **No** — sempre `null` sui draft (Datatracker non viene interrogato per una data in questa versione dello script; vedi punto 8 per la proposta di correggerlo) |
| `keywords` | Elenco di parole chiave | RFC: tag `<keywords><kw>`. Draft: campo `keywords` di Datatracker, **solo se il tipo ricevuto è effettivamente una lista** (altrimenti omesso — mai forzato a un tipo sbagliato) | **No** sui draft se il dato non è una lista valida |
| `impact_score` | Punteggio di "autorevolezza storica" del documento, scala 0–1000 | Calcolato da `compute_impact_scores()`: PageRank pesato sul grafo Updates/Obsoletes (dettagli al punto 7). Sempre `0` per i draft, che non hanno archi | Sì |
| `layer_hint` | Suggerimento grezzo di layer di rete (Application/Transport/Network) | `classify_layer_hint()`: match per parola intera su titolo+keyword contro liste di parole chiave, **in fase di parsing, senza rete** | **No** sui draft; su RFC può essere `null` se nessuna parola chiave matcha |
| `layer` | Layer di rete **autorevole** | `resolve_layer()` in fase di enrichment: override manuale esplicito o area IETF via Datatracker (dettagli al punto 3) | Sì come chiave, ma valore `null` se non risolvibile |
| `working_group` | Gruppo di lavoro IETF responsabile | `resolve_working_group()`: tri-stato (vedi Parte 1, sezione enrichment) | Sì come chiave sugli RFC; `null` se non risolvibile o assente |
| `is_draft` | Vero se il documento è un Internet-Draft attivo/scaduto (non ancora RFC, non ritirato) | RFC: sempre `false`. Draft: vero se lo stato bozza è `active` o `expired` | Sì |
| `is_aborted` | Vero se il documento è un draft "morto" o sostituito | RFC: sempre `false`. Draft: vero se lo stato è `dead` o `repl` | Sì |
| `n_updates` | Numero di archi *Updates* uscenti da questo nodo | Ricontati sugli archi **realmente sopravvissuti** nel grafo finale (dopo rimozione di contraddizioni), non sulle liste XML grezze | Sì (sempre `0` sui draft) |
| `n_obsoletes` | Numero di archi *Obsoletes* uscenti da questo nodo | Come sopra, per il tipo `Obsoletes` | Sì (sempre `0` sui draft) |

### 2.3 Campi di ogni arco

| Campo | Significato | Come viene ricavato |
|---|---|---|
| `source` | Id del documento che dichiara la relazione (il più recente/attivo) | Tag `<updates>`/`<obsoletes>` dell'entry XML di partenza |
| `target` | Id del documento aggiornato/sostituito | Come sopra |
| `type` | `"Updates"` o `"Obsoletes"` | Determinato da quale contenitore XML (`<updates>` o `<obsoletes>`) conteneva il riferimento |

Un arco esiste solo se **sia source che target sono documenti effettivamente presenti** nel dataset finale (`valid_ids`, ricalcolato ad ogni checkpoint), e solo se non fa parte di una coppia contraddittoria (se A dichiara di obsoletare/aggiornare B e, indipendentemente, B dichiara lo stesso verso A (stesso tipo), l'IETF index si contraddice su quella coppia. Invece di scegliere arbitrariamente una direzione, ENTRAMBE vengono escluse e loggate.).

---

## 3. Perché esistono sia `layer_hint` che `layer`

Sono due valori con provenienza e affidabilità completamente diverse, prodotti in due fasi separate della pipeline:

- **`layer_hint`** nasce in fase di **parsing** (`classify_layer_hint()`), che lavora solo sull'XML locale, **senza fare alcuna chiamata di rete**. È un matching lessicale grezzo: se il titolo o le keyword contengono parole come "tcp", "http", "bgp" ecc. (per parola intera, non sottostringa), si assegna un layer *ipotetico*. Serve puramente come filtro economico e immediato, disponibile subito dopo il parsing, prima ancora di iniziare l'arricchimento (che è lento: rate-limited, con un delay di 0.5s per richiesta su decine di migliaia di documenti).
- **`layer`** nasce in fase di **enrichment** (`resolve_layer()`), che interroga fonti autorevoli: prima una tabella di override manuali curata a mano (per una manciata di RFC fondamentali su cui non vogliamo dipendere da un'API esterna), poi l'area IETF ufficiale ottenuta da Datatracker. Se nessuna delle due fonti risolve, `layer` resta esplicitamente `null` — **mai** viene "recuperato" usando `layer_hint` come ripiego, perché sarebbe un'euristica testuale spacciata per dato certo.

La conseguenza pratica per il frontend: **va sempre usato `layer`, mai `layer_hint`**, per qualunque decisione visiva (colore, filtro). `layer_hint` in questa architettura non arriva mai al frontend con uno scopo diretto — è un artefatto interno della pipeline. Se in futuro si volesse mostrare una stima "provvisoria" prima che l'enrichment completi su un nodo, `layer_hint` sarebbe il candidato naturale per quel caso d'uso, ma andrebbe etichettato chiaramente come "non verificato" nell'interfaccia per non confonderlo con `layer`.

---

## 4. Come vengono ricavati draft e aborted — e se i numeri tornano

`fetch_drafts_and_aborted()` interroga l'endpoint Datatracker `/doc/document/` filtrando per `states__type__slug=draft` e `states__slug__in=active,expired,dead,repl` (cioè: bozze attive, scadute, morte, o sostituite — copre l'intero ciclo di vita di un Internet-Draft che non sia infine diventato un RFC pubblicato, che è già coperto separatamente dal parsing dell'XML).

**Paginazione.** L'API Datatracker restituisce risultati a pagine (parametro `limit: 50`); ogni risposta include in `meta.next` l'URL della pagina successiva. Lo script segue questa catena (`while path: ...`) finché `next` non è più presente, accumulando tutti i documenti. Ogni documento già presente in `existing_ids` (RFC già arricchiti o draft già fetchati in un run precedente) viene saltato, per evitare duplicati e lavoro ripetuto.

**Filtro incrementale.** Il parametro opzionale `since_iso` (passato come `time__gte` nella query) permette, nei run successivi al primo, di chiedere a Datatracker solo i documenti modificati dopo l'ultimo fetch, invece di riscaricare l'intero catalogo ogni volta.

### I numeri sono coerenti con la realtà?

Ho verificato con una ricerca mirata:

- **RFC pubblicati**: fonti pubbliche (rfc-editor.org, arkko.com/tools/rfcstats) riportavano circa **9.164 RFC** ad agosto 2024, e IETF.org parla genericamente di "oltre 9.000" documenti nella serie. Il nostro dataset ne conta **9.794** a metà 2026 — coerente: significa circa 630 nuovi RFC pubblicati in ~2 anni, cioè ~300–350 l'anno, in linea con il ritmo storico di pubblicazione dell'IETF. ✅ **Numero plausibile e verificato.**
- **Internet-Draft (attivi/scaduti/morti/sostituiti)**: qui devo essere onesto sui limiti della verifica. Non ho trovato una statistica pubblica aggregata che dichiari "il totale storico di tutti i nomi di draft distinti mai sottomessi all'IETF" in modo diretto e affidabile — le pagine di statistiche di Datatracker mostrano viste parziali (draft attivi, ultimi 7 giorni, ecc.) ma non un totale storico onnicomprensivo facilmente citabile. **34.617** è un ordine di grandezza plausibile, dato che l'IETF raccoglie sottomissioni di draft dai primi anni '90 e il volume di nuove submission è nell'ordine delle migliaia l'anno da tempo, ma non posso confermarlo con la stessa certezza del dato sugli RFC pubblicati. ⚠️ **Plausibile ma non verificato in modo indipendente.**

---

## 5. Quanti sono i documenti totali (RFC + draft + aborted)

Nel gergo IETF, **"RFC" indica in senso stretto solo i documenti pubblicati** nella serie ufficiale. Un Internet-Draft, anche se poi diventerà un RFC, non è "un RFC" finché non viene pubblicato con un numero. Il dataset della pipeline però tratta entrambi come "nodi" dello stesso grafo, quindi comprendo la domanda come "quanti documenti totali gestisce il sistema":

| Categoria | Conteggio |
|---|---|
| RFC pubblicati | 9.794 |
| Internet-Draft attivi/scaduti (`is_draft: true`) | 27.982 |
| Draft morti/sostituiti (`is_aborted: true`) | 6.635 |
| **Totale documenti nel dataset** | **44.411** |

---

## 6. Clusterizzazione nel grafo e soglia per il Core Backbone

Va chiarita una cosa prima di tutto: **allo stato attuale non esiste una vera clusterizzazione algoritmica** (tipo community detection, che raggrupperebbe nodi in base alla densità di connessioni tra loro). Quello che il sistema fa oggi è più semplice: seleziona un sottoinsieme di nodi "in vista" (il **Core Backbone**) e lascia che la force simulation di D3 produca un raggruppamento *visivo emergente* — nodi collegati da un arco si attraggono, nodi scollegati si respingono, e il risultato tende naturalmente a formare "grappoli" attorno ai nodi più centrali, ma questo è un effetto del layout fisico, non di un algoritmo di clustering dichiarato.

**La soglia usata non è un valore fisso di impact score**, ma un **conteggio**: si prendono i primi *N* nodi per `impact_score` decrescente (attualmente `N = 60`, configurabile via l'input `coreSize` del componente), non "tutti i nodi con score superiore a X". L'approccio "top-N" è più robusto di un ipotetico `impact_score > X` scritto a mano: un conteggio fisso di nodi visibili all'avvio ha un impatto prevedibile sulle prestazioni indipendentemente da come evolve la distribuzione dei punteggi nel tempo, mentre una soglia assoluta rischierebbe di mostrare improvvisamente 20 o 200 nodi a seconda di piccole variazioni nel dataset.

---

## 7. Come viene calcolato l'impact score (PageRank pesato)

`compute_impact_scores()` implementa una variante pesata del classico algoritmo PageRank di Google, pensata per misurare quanto un RFC sia stato storicamente influente in base a chi lo cita (Updates/Obsoletes), non solo quanti lo citano:

1. **Inizializzazione**: ogni nodo parte con rank uniforme `1/n`.
2. **Pesi degli archi**: un arco `Obsoletes` (sostituzione strutturale di uno standard) pesa **2.0**; un arco `Updates` (aggiornamento incrementale) pesa **1.0**. Questo riflette l'idea che essere *sostituiti* da un nuovo standard è un evento più significativo, per il documento che riceve l'arco, di essere semplicemente *aggiornato*.
3. **Iterazione (20 cicli, damping factor 0,85)**: ad ogni ciclo, il rank di un nodo viene ricalcolato come combinazione di:
   - una quota base uniforme, `(1 − 0,85)/n` — garantisce che anche un nodo isolato mantenga un minimo di rank e che l'algoritmo converga;
   - l'85% del rank che riceve dai nodi che puntano verso di lui, **diviso proporzionalmente al peso** di ciascun arco in uscita del mittente (`rank_sum`) — è la parte "PageRank classico": il prestigio fluisce lungo i link, pesato;
   - un **authority boost aggiuntivo**, proporzionale al numero grezzo di archi entranti (non pesato) diviso per il totale dei nodi. Questo è uno scostamento deliberato dal PageRank puro: senza di esso, un RFC molto citato ma i cui "elettori" hanno a loro volta poco rank potrebbe restare sottovalutato nelle prime iterazioni; il boost dà un riconoscimento immediato al semplice fatto di essere un punto di riferimento molto citato (tipico dei "pilastri" come IP o TCP), oltre al fluire iterativo del rank.
4. **Normalizzazione finale**: il punteggio grezzo di ogni nodo viene diviso per il massimo dell'intero grafo e moltiplicato per 1000. Questo (invece di normalizzare, ad esempio, sulla somma totale) garantisce che il nodo più autorevole abbia **sempre** punteggio esattamente 1000, qualunque sia la dimensione del grafo in quel momento — utile per mantenere una scala visiva stabile (es. per il raggio dei nodi nel frontend) anche quando il dataset cresce nel tempo.

---

## 8. Proposta: includere TUTTI i nodi nel grafo (anche draft e aborted)

Accolgo la richiesta di includere davvero tutto nel grafo. Questo cambia alcune cose nel piano:

**Il problema centrale**: i draft non hanno archi Updates/Obsoletes (0 su 34.617, verificato sui dati reali) e non hanno un `year` valorizzato (sempre `null` in questa versione della pipeline). Includerli "così com'è" nella force simulation attuale significherebbe avere 34.617 nodi senza alcuna forza che li leghi a nient'altro: la simulazione li spargerebbe genericamente attorno al centro, senza un posizionamento significativo.

**Proposta di soluzione, in due parti:**

1. **Lato pipeline**: aggiungere l'estrazione di una data reale per i draft. La risposta Datatracker per un documento tipicamente include un campo temporale (es. `time`, la data dell'ultima revisione, o si può risalire alla prima submission tramite la cronologia delle revisioni del draft)., è un prerequisito perché la timeline del punto 9 abbia senso anche per i draft.
2. **Lato frontend**: una volta che anche i draft hanno un anno, il posizionamento lungo l'asse temporale (vedi punto 9) diventa la loro forza di posizionamento principale, **anche senza archi**. Visivamente, propongo di distinguerli dagli RFC pubblicati (es. marker quadrato invece che circolare, colore desaturato/più tenue) così l'utente capisce a colpo d'occhio che sta guardando una bozza e non uno standard consolidato, senza doverci cliccare sopra.

**Costo da gestire**: includere tutti i nodi significa tornare a spedire l'intero payload (~41 MB, di cui ~28 MB sono abstract di draft mai mostrati per intero nella vista a grafo). Per non pagare questo costo ad ogni caricamento, propongo di **separare i dati "leggeri" (per il layout) dai dati "pesanti" (per il pannello di dettaglio)**: il caricamento iniziale porta solo i campi necessari a disegnare il grafo (id, year, layer, impact_score, is_draft/is_aborted, e gli archi), mentre `abstract` e `keywords` completi vengono richiesti on-demand (una piccola fetch per singolo id) solo quando l'utente clicca un nodo per aprirne il dettaglio. 

---

## 9. Barra temporale e posizionamento per anno

Proposta di design concreto:

- **Asse orizzontale del tempo**: una scala D3 (`d3.scaleLinear` o `d3.scaleTime`) che mappa l'anno di un documento a una coordinata X, disegnata come barra/asse fisso nella parte inferiore del canvas, con tacche per decade o per anno a seconda del livello di zoom.
- **Come si integra con la force simulation senza rompere il clustering**: invece di calcolare le posizioni una volta sola (layout statico), si aggiunge una **forza D3 aggiuntiva e permanente**, insieme a quelle già esistenti (repulsione, collisione, link). L'effetto è che ogni nodo viene "tirato" dolcemente verso la sua posizione X corretta in base all'anno, mentre le altre forze (repulsione tra nodi, attrazione lungo gli archi Updates/Obsoletes) continuano a determinare liberamente la posizione verticale (Y) e le micro-posizioni orizzontali all'interno della propria fascia temporale. Il risultato è un layout "a fasce temporali" dove, dentro ogni fascia, i nodi collegati tra loro restano comunque vicini — è lo stesso principio dei diagrammi timeline force-directed, ed è compatibile nativamente con l'espansione: un nodo nuovo che entra in scena viene automaticamente attratto verso il suo anno corretto dalla stessa forza, senza bisogno di ricalcolare nulla a mano.
- **Nodi senza anno risolvibile**: vanno in una fascia dedicata "Anno non disponibile", visivamente separata (es. a destra dell'asse principale, con uno stacco), invece di rompere la scala o venire posizionati arbitrariamente a un anno falso.

---

## 10. Abstract e keywords nel pannello di dettaglio

Aggiunta pianificata, semplice: il pannello che si apre al click su un nodo mostrerà, oltre ai campi già previsti (status, anno, layer, working group, impact score, conteggio Updates/Obsoletes, link esterno):

- **Abstract**, se il campo non è una stringa vuota — con eventuale troncamento/espansione se molto lungo, per non far esplodere l'altezza del pannello;
- **Keywords**, se il campo è presente (ricordiamo: assente sui draft se Datatracker non lo fornisce come lista valida) e non vuoto, mostrate come piccoli tag/chip piuttosto che come testo semplice, per leggibilità.

Entrambi i campi vanno gestiti in modo condizionale nel template (analogamente a come si gestiranno `layer`/`working_group` con `??`), dato che — come documentato al punto 2 — non sono garantiti su ogni nodo.

---

## 11. Come si intende strutturare il grafo, in sintesi

Mettendo insieme le proposte precedenti, la visione complessiva del frontend è:

- **Tutti i 44.411 documenti sono candidati alla visualizzazione** (punto 8), non solo i 9.794 RFC pubblicati — ma con un caricamento a due velocità: dati leggeri per il layout subito, dettagli pesanti (abstract/keywords) on-demand al click.
- **Asse orizzontale = tempo** (punto 9): ogni nodo è tirato dolcemente verso la posizione X corrispondente al suo anno, con un limite superiore calcolato dinamicamente sull'anno corrente.
- **Asse verticale/posizione fine = struttura** (raggruppamento emergente dalla force simulation): nodi collegati da Updates/Obsoletes restano vicini all'interno della propria fascia temporale; i draft, privi di archi, si distribuiscono nella loro fascia per semplice repulsione/collisione con gli altri nodi.
- **Dimensione = impact score** (scala radice quadrata), **colore = layer** (con bucket neutro per `layer: null`), **forma = tipo di documento** (es. cerchio per RFC pubblicati, quadrato/marker distinto per draft/aborted).
- **Archi differenziati per colore e spessore**, con direzione indicata da una freccia.
- **Interazione**: la Progressive Disclosure (Core Backbone iniziale + espansione al click) è il modello di navigazione principale e "Core Backbone" può includere, oltre al top-N per impact score, un criterio temporale (es. mostrare sempre i documenti dell'anno corrente e di quello precedente, anche se a basso impact score, per dare visibilità all'attività IETF più recente) — questa è un'estensione che vale la pena valutare, non ancora decisa.
- **Pannello di dettaglio arricchito** con abstract e keywords (punto 10), oltre ai campi già previsti.
- **Scelta cromatica**: la palette sarà definita secondo criteri di accessibilità universale, garantendo una chiara leggibilità per gli utenti affetti da daltonismo.

---

## 12. Aggiornamento automatico di `graph_data_enriched.json`

Il sistema è progettato per garantire l'allineamento continuo del grafo con le fonti ufficiali (IETF Datatracker e indici RFC), adottando un paradigma di **aggiornamento incrementale**. Il codice della pipeline è strutturato per elaborare esclusivamente i delta informativi — ovvero solo i documenti nuovi o modificati dall'ultimo avvio — ottimizzando così le chiamate alle API esterne e riducendo drasticamente il carico computazionale.

L'orchestrazione di tale ciclo di aggiornamento è delegata a un meccanismo di scheduling periodico (gestito nativamente a livello di sistema operativo o tramite un loop di attesa calcolato all'interno dello script), che assicura l'esecuzione automatizzata del parsing e dell'arricchimento dei dati. Tale approccio garantisce che il file di output (`graph_data_enriched.json`) sia costantemente aggiornato e pronto per essere servito dall'applicazione frontend al momento del caricamento, mantenendo il sistema resiliente, efficiente e conforme alle politiche di _rate limiting_ dei servizi terzi.
