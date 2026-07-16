# RFC Graph Visualizer — Aggiornamenti 2

**Stato:** rispetto al documento precedente, il frontend Angular è passato da "in fase di progettazione" a **implementato** (menu, grafo 3D, timeline draft/aborted), e la pipeline Python si è arricchita di un **secondo script di enrichment** dedicato ai draft. Questo documento riprende la falsariga del primo: cosa è stato effettivamente costruito nel codice, e chiude con una proposta aperta sull'automazione dei due script backend.

---

## Indice

1. [Backend: nuovo script `draft_metadata_enricher.py`](#1-backend-nuovo-script-draft_metadata_enricherpy)
2. [Frontend: struttura generale a due viste](#2-frontend-struttura-generale-a-due-viste)
3. [`GraphDataService` — vista "Grafo degli RFC"](#3-graphdataservice--vista-grafo-degli-rfc)
4. [`DraftTimelineDataService` — vista "Draft e abortiti"](#4-drafttimelinedataservice--vista-draft-e-abortiti)
5. [`GraphCanvasComponent` — il grafo 3D](#5-graphcanvascomponent--il-grafo-3d)
6. [`DraftTimelineComponent` — l'istogramma temporale](#6-drafttimelinecomponent--listogramma-temporale)
7. [`LandingMenuComponent` — il punto di ingresso](#7-landingmenucomponent--il-punto-di-ingresso)
8. [Proposta: avvio automatico dei due script Python allo scadere di un timer](#8-proposta-avvio-automatico-dei-due-script-python-allo-scadere-di-un-timer)

---

## 1. Backend: nuovo script `draft_metadata_enricher.py`

È stato aggiunto un secondo passaggio di arricchimento, **volutamente separato** da `rfc_pipeline.py` invece che incorporato in esso, per tenere distinte le due responsabilità: `rfc_pipeline.py` costruisce il grafo (parsing + layer/working group), questo nuovo script si occupa solo di completare i campi che oggi mancano sui nodi Internet-Draft/aborted.

Nel documento precedente, al punto 8, era stato segnalato come problema che i draft avessero sempre `year: null`. Questo script è la risposta concreta a quel problema:

- **`url`**: per un draft viene costruita come `https://datatracker.ietf.org/doc/html/{id in minuscolo}`, in modo completamente deterministico dal nome del documento — **nessuna chiamata di rete necessaria** per questo campo.
- **`year`**: richiede invece una chiamata a Datatracker (`/doc/document/{draft}/`), da cui si legge il campo `time`. È importante essere precisi su cosa rappresenta questo dato: è l'anno dell'**ultima revisione nota** del documento, non l'anno di prima sottomissione (che richiederebbe ricostruire la cronologia via `/doc/docevent/`, molto più costoso in numero di richieste). È un'approssimazione dichiarata esplicitamente nel codice, sufficiente per posizionare il nodo su una timeline annuale, ma segnalata come punto da rivedere se in futuro servisse la precisione della prima submission.
- **`abstract`**: passata di normalizzazione applicata a **tutti** i nodi del dataset (non solo ai draft appena arricchiti), idempotente — collassa whitespace/ritorni a capo multipli e tronca a 800 caratteri con ellissi se il testo supera quella soglia.

Il resto dello script ricalca deliberatamente la stessa filosofia di `rfc_pipeline.py`, per coerenza operativa tra i due:

- **Incrementalità**: uno stato persistito su disco (`.state/draft_metadata_state.json`) tiene traccia degli id già processati, così un run successivo salta ciò che è già stato arricchito (`needs_enrichment()` verifica che manchino `url` o `year`).
- **Cache HTTP su disco**, incluse le risposte 404 — così un documento risultato irreperibile non viene richiesto di nuovo ad ogni run.
- **Checkpoint periodici** ogni 200 nodi processati, con scrittura atomica del JSON di output (file temporaneo + `os.replace`), per essere resiliente a un'interruzione a metà run.
- **Retry con backoff esponenziale** su errori di rete, e gestione esplicita del rate limiting (`429` → attesa del tempo indicato in `Retry-After`).
- **`--force`** per ignorare lo stato e riprocessare tutto, **`--limit`** per test rapidi su un sottoinsieme.

Pensato per essere lanciato **dopo** ogni `rfc_pipeline.py enrich`, anche dallo stesso scheduler periodico — il che è esattamente il tema del punto 8 di questo documento.

---

## 2. Frontend: struttura generale a due viste

Il frontend, prima solo progettato, è ora un'applicazione Angular standalone con **due viste distinte** condivise da un menu iniziale:

```
LandingMenuComponent
        │
        ├── selectRfcGraph   ──▶  GraphCanvasComponent      (grafo 3D, RFC pubblicati)
        └── selectDraftTimeline ──▶ DraftTimelineComponent   (istogramma, draft/aborted)
```

Le due viste **non condividono un solo servizio dati**, ma due, ciascuno responsabile di un sottoinsieme complementare e disgiunto del dataset (pubblicati da una parte, draft/aborted dall'altra) — coerente con la scelta già discussa nel documento precedente di distinguere nettamente i due tipi di documento.

---

## 3. `GraphDataService` — vista "Grafo degli RFC"

Rispetto a quanto ipotizzato nel primo documento, il servizio filtra **solo RFC pubblicati**: draft e aborted vengono scartati già in fase di indicizzazione (`if (n.is_draft || n.is_aborted) continue;`), non entrano proprio in questa vista.

Alcune scelte implementative degne di nota:

- **Nodi e archi come `signal<...>`**, non semplici campi privati con `Map`/array: un `computed()` (come `graphData` o `totalNodeCount`) si aggiorna solo quando cambia un segnale letto al suo interno, non quando muta silenziosamente il contenuto di una struttura dati "opaca". La `Map` interna (`nodesById`) resta invece un campo privato normale, perché serve solo per lookup puntuali (`getNode`, `neighborsOf`) mai letti da un `computed`.
- **`providedIn: 'root'`**: la stessa istanza è condivisa tra le due viste. Per gestirlo correttamente, `load()` tiene traccia dell'URL effettivamente caricato (`_loadedUrl`, anch'esso un `signal`) e ricarica ogni volta che l'URL richiesto differisce da quello in memoria — così passare da una vista all'altra rifà sempre il fetch del dataset giusto, e un componente può verificare in modo reattivo, dentro un `effect()`, se i dati attualmente in memoria sono davvero i propri (invece di affidarsi solo a "i nodi non sono vuoti", vero anche quando sono residui dell'altra vista).
- **Navigazione sul grafo**: oltre al caricamento, il servizio espone `neighborsOf`, `reachableFrom` (BFS fino a una profondità massima, per l'espansione progressiva discussa al punto 11 del documento precedente), `linksAmong` e `incidentLinksOf` — le primitive su cui si appoggia l'interazione "clicca un nodo per espandere il suo vicinato" nel componente canvas.

---

## 4. `DraftTimelineDataService` — vista "Draft e abortiti"

È il complemento esatto del servizio precedente: prende **solo** i nodi con `is_draft` o `is_aborted`, scartando tutto il resto.

La differenza di design più rilevante rispetto a `GraphDataService` è che qui **non serve reattività fine-grained** (non c'è una force simulation da pilotare in tempo reale), quindi l'indicizzazione avviene **una volta sola al caricamento**, con gli id già raggruppati per anno e **ordinati alfabeticamente dentro ogni anno** (`byYear: Map<number | null, string[]>`). Il componente di rendering non deve mai ordinare o filtrare a runtime: legge solo lo slice visibile, il che è importante per un canvas 2D disegnato ad ogni frame di zoom/pan.

Altri dettagli:

- Un bucket dedicato con chiave `null` raccoglie i documenti senza anno risolto (`hasNoYearBucket()`), coerente con la proposta del documento precedente di **non inventare un anno falso**.
- `allWorkingGroups()` restituisce l'insieme dei working group presenti, con un valore sentinella `NO_WORKING_GROUP` per i documenti senza gruppo, ordinato in modo che il bucket "nessun gruppo" finisca sempre in fondo alla lista.

---

## 5. `GraphCanvasComponent` — il grafo 3D

Il componente implementa concretamente la visione descritta al punto 11 del documento precedente:

- **Overlay di caricamento a schermo intero** che resta visibile finché il grafo non è "davvero pronto" (dati caricati **e** layout di forza assestato), in modo che l'utente veda comparire il grafo già completo invece che animarsi da uno stato disordinato iniziale.
- **Pannello filtri** con due assi ortogonali: filtro per **decade** (checkbox multiple) e filtro per **working group** con campo di ricerca testuale che filtra la lista in tempo reale. I nodi/archi non corrispondenti ai filtri attivi vengono evidenziati in grigio invece di essere rimossi dal grafo — coerente con l'idea di non alterare il layout di forza sottostante mentre si esplora.
- **Navigazione tra risultati filtrati** (`‹ Prec.` / `Succ. ›`), abilitata solo quando è attivo un filtro con match.
- **Legenda a doppia sezione**: colore per layer (Application/Transport/Network/Unclassified) e per tipo di relazione (Obsoletes/Updates), con spessore della linea diverso oltre che colore diverso — non solo colore, per non affidarsi a un unico canale visivo.
- **Pannello di dettaglio** sul nodo selezionato: id, titolo, status, anno, layer (con distinzione esplicita tra `layer` autorevole e `layer_hint` non verificato, etichettato come tale — esattamente la raccomandazione del punto 3 del documento precedente), working group, impact score, conteggio Updates/Obsoletes, keywords come chip, abstract, e link al documento originale.
- **Overlay comandi mouse** richiamabile a parte (rotazione/pan/zoom), per non dover indovinare i controlli di una scena 3D.

---

## 6. `DraftTimelineComponent` — l'istogramma temporale

Realizza la "barra temporale" proposta al punto 9 del documento precedente, ma con una scelta implementativa diversa da quella lì ipotizzata: **non** una forza D3 dentro una simulazione fisica, bensì un **istogramma verticale disegnato direttamente su `<canvas>` 2D**, con zoom/pan gestiti da `d3.zoom` (drag orizzontale = scorrimento nel tempo, rotellina = zoom). È una scelta più semplice e più adatta a questa vista: qui non c'è una struttura a grafo da rispettare (i draft non hanno archi Updates/Obsoletes, come già notato nel documento precedente), quindi non serve la macchina della force simulation — basta posizionare ogni documento in una colonna-anno e impilare le pile in ordine alfabetico.

Alcuni dettagli implementativi:

- **Colori accessibili**: la palette usata per distinguere Internet-Draft attivi/scaduti da draft abortiti/sostituiti è quella **Okabe-Ito** (blu `#0072B2` / vermiglio `#D55E00`) invece del classico blu/rosso puro, perché resta distinguibile anche sotto le forme più comuni di daltonismo (deuteranopia/protanopia) — i due colori differiscono anche in luminosità, non solo in tonalità, quindi restano leggibili anche in scala di grigi.
- **Sfondo bianco**, in contrasto deliberato con lo sfondo scuro/spaziale della vista a grafo 3D — una scelta di tema che resta anche nel restyling di coerenza tra le due viste (tipografia, pulsanti, spaziature), perché riguarda solo lo stile, non il colore di sfondo.
- **Rendering solo della porzione visibile**: ad ogni frame vengono disegnate solo le colonne-anno e gli elementi di pila effettivamente dentro il viewport corrente (calcolato invertendo la trasformazione di zoom), invece di ridisegnare l'intero dataset ad ogni frame.
- **Filtro per working group**, con la stessa logica di ricerca testuale della vista a grafo, che attenua (invece di nascondere) i documenti non corrispondenti.
- **Pannello di dettaglio** analogo a quello della vista a grafo, con l'aggiunta di un'etichetta esplicita "Internet-Draft attivo/scaduto" vs "Draft ritirato/sostituito" e una nota che alcuni documenti datati potrebbero non essere più disponibili nel repository IETF.

---

## 7. `LandingMenuComponent` — il punto di ingresso

Componente minimo ma non banale nella sua funzione: presenta le due viste come due card scelte esplicitamente dall'utente (`selectRfcGraph` / `selectDraftTimeline`), invece di caricare entrambe le viste o sceglierne una di default. Questo rende esplicito all'utente **quale sottoinsieme del dataset sta per vedere** (pubblicati vs draft/abortiti) prima ancora di iniziare a caricare i dati — coerente con la separazione netta tra i due servizi dati descritta ai punti 3 e 4.

---

## 8. Proposta: avvio automatico dei due script Python allo scadere di un timer

Con `draft_metadata_enricher.py` ora funzionante e pensato esplicitamente per girare **dopo** `rfc_pipeline.py enrich` (come scritto nella sua stessa documentazione interna), la domanda naturale è se automatizzare l'esecuzione in sequenza dei due script ad ogni avvio del sistema, e poi periodicamente allo scadere di un timer — così `graph_data_enriched.json` resta allineato alle fonti IETF senza intervento manuale.

Prima di decidere, vale la pena mettere a confronto le due strade, perché non è ovvio quale sia la scelta giusta per questo progetto:

**Automatizzare (scheduler + timer):**
- *Vantaggi*: il dataset resta aggiornato senza doverci pensare; è coerente con l'incrementalità già progettata in entrambi gli script (checkpoint, stato persistito, cache), che esistono proprio per rendere economico un run ripetuto nel tempo; un timer ragionevole (es. una volta al giorno, o ogni poche ore) rispetta comunque il rate limiting di Datatracker perché ogni run processa solo i delta.
- *Rischi*: se uno dei due script fallisce silenziosamente (rete assente, Datatracker in errore prolungato), un'esecuzione automatica non presidiata potrebbe non essere notata per giorni; serve quindi come minimo un log persistente e, idealmente, una notifica in caso di errore — cosa che allo stato attuale gli script non fanno (si limitano a loggare a console/file). Va anche deciso **dove** far girare lo scheduler (cron di sistema, systemd timer, un loop nello script stesso), scelta non ancora presa.

**Farlo manualmente su richiesta:**
- *Vantaggi*: pieno controllo su quando avviene un run (utile ad esempio prima di una demo, per essere sicuri che il dataset sia in uno stato noto e non stia venendo riscritto proprio in quel momento); più semplice da debuggare, perché ogni run è un evento esplicito con un output visibile subito, invece di un processo in background di cui bisogna andare a cercare i log.
- *Svantaggi*: il dataset può restare disallineato dalle fonti IETF per lunghi periodi se ci si dimentica di rilanciare gli script, vanificando in parte il lavoro fatto per rendere l'aggiornamento incrementale ed economico.

**Una via di mezzo, se può interessare come terza opzione**: automatizzare l'esecuzione ma **non** l'atomicità della pubblicazione — cioè lo scheduler scrive sempre su un file di **staging** (es. `graph_data_enriched.next.json`), e solo un comando manuale esplicito (o una verifica automatica di base, tipo "il run è terminato senza eccezioni e il JSON risultante è valido") promuove quel file a `graph_data_enriched.json`, quello effettivamente servito dal frontend. Questo darebbe l'aggiornamento automatico senza il rischio che un run fallito a metà o con dati anomali arrivi a sostituire silenziosamente il dataset in produzione.

Nessuna delle tre opzioni è già stata implementata: è un punto da decidere insieme, anche in base a quanto è realistico presidiare l'esecuzione periodica nel contesto in cui gira il sistema.
