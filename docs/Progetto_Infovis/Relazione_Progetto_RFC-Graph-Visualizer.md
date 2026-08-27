# RFC Graph Visualizer
## Un sistema di visualizzazione interattiva per l'esplorazione storica degli standard IETF

**Relazione di progetto — Corso di Visualizzazione delle Informazioni**
**Università degli Studi Roma Tre — Docente: Prof. Maurizio Patrignani**

**Autore:** Massimiliano Giangreco
**Repository:** https://github.com/ilMassy/RFC-graph-visualizer

---

## Abstract

Questo progetto affronta la visualizzazione delle relazioni storiche tra i documenti **RFC** (Request for Comments) dell'**IETF**, un corpus di alcune migliaia di documenti pubblicati in oltre quarant'anni, collegati da legami direzionati *Updates* e *Obsoletes*. Il problema è duplice: da un lato serve un **grafo di relazioni** navigabile, capace di comunicare struttura, rilevanza storica e cronologia; dall'altro serve una vista puramente **temporale** per le decine di migliaia di Internet-Draft — le proposte che non sono (ancora, o mai) diventate RFC — per le quali un grafo non avrebbe senso, non avendo relazioni esplicite tra loro.

Il sistema propone due viste distinte, scelte dall'utente in un menu iniziale: un **grafo 3D force-directed** dei soli RFC pubblicati, con dimensione dei nodi guidata da un punteggio di autorevolezza calcolato con una variante pesata di PageRank, colore per layer di rete secondo la palette colorblind-safe di Okabe-Ito, e un livello aggiuntivo di struttura ottenuto raggruppando spazialmente i nodi per *community* rilevate via Label Propagation; e un **istogramma temporale 2D su canvas** per i draft/aborted, organizzato per colonne-anno e navigabile con zoom e pan.

Il progetto applica in modo verificabile alcuni principi cardine della disciplina — il *Visual Information Seeking Mantra* di Shneiderman, la distinzione tra codifica *categorica* e *quantitativa*, l'attenuazione invece della rimozione come strategia di filtro che preserva il contesto — e ne discute i limiti, in particolare l'**hairball** attorno ai nodi ad alto grado, un problema strutturale noto nel graph drawing force-directed, non risolvibile con le sole tecniche di clustering spaziale adottate. La relazione descrive la pipeline dati, le scelte di codifica visiva e di interazione, i bug di rendering risolti durante lo sviluppo, e propone direzioni di miglioramento — in primis l'edge bundling.

---

## Sommario

1. [Introduzione e contesto applicativo](#1-introduzione-e-contesto-applicativo)
2. [I dati: acquisizione, modello, qualità](#2-i-dati-acquisizione-modello-qualità)
3. [Principi di visualizzazione delle informazioni applicati](#3-principi-di-visualizzazione-delle-informazioni-applicati)
4. [Architettura del sistema](#4-architettura-del-sistema)
5. [La vista a grafo 3D degli RFC pubblicati](#5-la-vista-a-grafo-3d-degli-rfc-pubblicati)
6. [La vista timeline dei draft e degli abortiti](#6-la-vista-timeline-dei-draft-e-degli-abortiti)
7. [Criticità di rendering incontrate e risolte](#7-criticità-di-rendering-incontrate-e-risolte)
8. [Automazione e riproducibilità](#8-automazione-e-riproducibilità)
9. [Risultati](#9-risultati)
10. [Analisi critica e problemi aperti](#10-analisi-critica-e-problemi-aperti)
11. [Sviluppi futuri](#11-sviluppi-futuri)
12. [Conclusioni](#12-conclusioni)
13. [Bibliografia](#13-bibliografia)

---

## 1. Introduzione e contesto applicativo

### 1.1 Il dominio: gli RFC e gli Internet-Draft dell'IETF

Gli **RFC** sono i documenti con cui l'IETF standardizza i protocolli che compongono Internet: dal DNS al TCP/IP, dal routing BGP a HTTP. Ogni RFC può *aggiornare* (**Updates**) o *rendere obsoleto* (**Obsoletes**) uno o più RFC precedenti, generando una rete di dipendenze storiche densa e non banale. Prima di diventare RFC, uno standard proposto circola per mesi o anni come **Internet-Draft**: un documento provvisorio che può evolvere, essere sostituito, scadere senza mai essere pubblicato, oppure — nella minoranza dei casi — approdare a RFC. Il dataset copre entrambe le popolazioni: alcune migliaia di RFC pubblicati e decine di migliaia di Internet-Draft in uno dei quattro stati *attivo*, *scaduto*, *morto* o *sostituito* (dettagli al §9.1).

### 1.2 Il problema di visualizzazione

Un grafo di migliaia di nodi e archi Updates/Obsoletes è, per definizione, un caso difficile per un node-link diagram: la letteratura sul graph drawing lo classifica come dominio ad alta densità, dove il semplice disegno "a forze" produce occlusione visiva se non si interviene con strategie aggiuntive di leggibilità (§3.2). Il problema centrale è duplice:

- **come disporre e codificare visivamente un grafo di questa scala** in modo che resti leggibile e comunichi non solo la topologia ma anche l'*importanza storica* dei nodi, senza nascondere nulla all'apertura;
- **come trattare separatamente i draft**, una popolazione priva di struttura relazionale (nessun arco Updates/Obsoletes) per cui l'unica dimensione rilevante è temporale, evitando di forzarla nello stesso grafo per pura uniformità.

### 1.3 Profili utente e task di visualizzazione

Il sistema serve due profili distinti, a cui rispondono le due viste in modo complementare, ricalcando la tassonomia dei task di visualizzazione (overview, esplorazione, ricerca puntuale) piuttosto che imporre un'unica interfaccia generica:

- **Chi lavora nell'IETF e vuole studiare lo stato dell'arte**: quanti documenti esistono, come si sono succeduti, quali sono i più rilevanti, come si relazionano. Task di **overview ed esplorazione topologica**, servito dal grafo 3D con tutti gli RFC visibili fin dall'apertura, il filtro per decade e il pannello di dettaglio con l'elenco cliccabile dei documenti aggiornati/resi obsoleti.
- **Chi consulta gli RFC per un interesse specifico**, ad esempio un ricercatore che parte da un argomento noto. Task di **ricerca puntuale (lookup)**, servito dalla ricerca testuale per id/titolo/parola chiave, dal filtro per working group con conteggi, e dalla timeline separata sui draft/aborted.

### 1.4 Obiettivi del progetto

- Costruire una pipeline dati riproducibile che unisca due fonti autorevoli (indice ufficiale RFC e API IETF Datatracker) in un unico dataset coerente, versionabile come contratto tra backend e frontend.
- Progettare una codifica visiva che comunichi **struttura** (relazioni Updates/Obsoletes), **importanza storica** (dimensione) e **categoria** (colore per layer) senza sovraccaricare un solo canale percettivo.
- Applicare layout automatico (force-directed) e raggruppamento strutturale (community detection) per aumentare la leggibilità di un grafo di questa scala, documentandone onestamente i limiti residui.
- Separare la visualizzazione dei draft, privi di struttura relazionale, in una vista temporale dedicata invece di forzarli in un grafo che non li rappresenterebbe correttamente.

---

## 2. I dati: acquisizione, modello, qualità

### 2.1 Fonti e pipeline di backend

Il dataset è generato da una pipeline Python in quattro fasi, sempre nello stesso ordine — la prima produce un file intermedio, le successive tre leggono e riscrivono in place lo stesso output finale (`graph_data_enriched.json`):

1. **`rfc_pipeline.py parse`** — scarica (condizionalmente, via ETag/Last-Modified) `rfc-index.xml` da rfc-editor.org, estrae ogni entry RFC, costruisce nodi e archi Updates/Obsoletes escludendo le coppie contraddittorie, calcola l'`impact_score` (§3.4, §5.1).
2. **`rfc_pipeline.py enrich`** — arricchisce ogni nodo con `layer` di rete e `working_group`, risolti in modo autorevole tramite l'API IETF Datatracker (mai con euristiche testuali di ripiego), e recupera gli Internet-Draft nei quattro stati del loro ciclo di vita.
3. **`draft_metadata_enricher.py`** — secondo passaggio, deliberatamente separato per tenere distinte le responsabilità: completa `url` (deterministico) e `year` (via Datatracker, campo `time` — anno dell'ultima revisione, non della prima sottomissione) sui soli nodi draft/aborted, e normalizza `abstract` su tutti i nodi.
4. **`purge_phantom_draft_nodes.py`** — passaggio di chiusura che rimuove eventuali nodi "fantasma" residui, con `is_draft`/`is_aborted` entrambi nulli.

Le due fonti — indice XML ufficiale e API REST di Datatracker — sono autorevoli ma eterogenee per formato e garanzie di disponibilità: da qui la scelta di una pipeline batch/offline invece di interrogarle in tempo reale, così la visualizzazione lavora sempre su un file statico coerente, senza dipendere dalla raggiungibilità delle API esterne al momento della consultazione.

### 2.2 Modello del dato: il grafo come JSON

Il file servito al frontend è strutturato in tre blocchi — `meta`, `nodes`, `edges` — che riflettono il modello concettuale *node-link* adottato. Ogni nodo porta, oltre a identificativo e titolo, i campi che guidano la codifica visiva: `impact_score` (dimensione, §5.1), `layer` (colore, §5.2), `is_draft`/`is_aborted` (instradamento verso la vista corretta), `working_group` e `keywords` (filtro e ricerca). Ogni arco porta `source`, `target` e `type` (`Updates` o `Obsoletes`), ed esiste solo se entrambi gli estremi sono presenti nel dataset finale e la coppia non è contraddittoria (se A e B si dichiarano reciprocamente lo stesso tipo di relazione, entrambi gli archi vengono scartati). Coerentemente, **i draft non hanno mai archi**: è questo il fatto strutturale — non solo di interfaccia — che giustifica la separazione in due viste indipendenti (§4).

### 2.3 Disciplina definitivo/transitorio: perché conta per la visualizzazione

Un aspetto della pipeline con impatto diretto sulla correttezza della visualizzazione è la distinzione, applicata sistematicamente in ogni fase di arricchimento, tra un esito **definitivo** (200 risolto, 404, o un 200 privo del campo cercato — fatti certi) e uno **transitorio** (timeout, errore di rete, rate limit non risolto dopo i retry). Solo un esito definitivo viene scritto come dato "vero"; un esito transitorio lascia il nodo "da processare" per il run successivo. Questa distinzione garantisce che un valore mancante nel grafo — ad esempio un draft senza `year`, che finisce nel bucket "n.d." dell'istogramma temporale (§6.1) — rappresenti sempre un'assenza *reale* del dato, e non un artefatto della raccolta che l'utente rischierebbe di leggere come informazione mancante nel dominio. Un bug proprio in questa distinzione — un fallimento transitorio scambiato per definitivo — aveva inizialmente gonfiato il bucket "n.d." oltre il dovuto; la correzione, descritta al §7, ripristina la corrispondenza tra ciò che il grafico mostra e ciò che è realmente vero nel dominio.

---

## 3. Principi di visualizzazione delle informazioni applicati

### 3.1 Node-link diagram e force-directed graph drawing

La scelta di rappresentare gli RFC come **node-link diagram** invece che, ad esempio, come matrice di adiacenza, è motivata dal task prevalente nel profilo "overview" (§1.3): la matrice è superiore per la lettura precisa di singole relazioni su grafi densi, ma il node-link resta più efficace quando serve percepire **struttura topologica globale** — cluster, hub, catene di dipendenza — proprio ciò che serve a chi vuole "studiare lo stato dell'arte" invece di verificare una singola relazione. Il layout è calcolato da una **force-directed simulation**: ogni nodo è una particella soggetta a repulsione reciproca (*charge*), attrazione lungo gli archi (*link*), anti-sovrapposizione (*collide*) — lo schema classico introdotto da Eades e reso efficiente algoritmicamente da Fruchterman e Reingold, qui esteso a tre dimensioni. A queste tre forze "di base" il progetto aggiunge una quarta, custom, per il clustering strutturale (§3.5, §5.4).

### 3.2 Criteri estetici del disegno di grafi

La qualità percepita di un node-link diagram dipende da criteri estetici misurabili — incroci tra archi, uniformità della lunghezza, risoluzione angolare, distribuzione uniforme dei nodi — la cui importanza relativa per la comprensione umana è stata oggetto di studio in letteratura. Il progetto affronta esplicitamente due criteri:

- **Lunghezza uniforme degli archi**, minacciata da un bug concreto: un raggio di collisione tarato in eccesso rispetto al raggio visivo reale imponeva tra i centri una distanza minima superiore a quella voluta dal link, producendo archi sistematicamente più lunghi del necessario (§7.1);
- **Distribuzione dei nodi e leggibilità locale**, affrontata con una forza di clustering per community (§3.5, §5.4), che aggiunge organizzazione spaziale al solo equilibrio charge/link/collide.

Resta aperto, e onestamente documentato come tale (§10.1), il problema della **minimizzazione degli incroci**: attorno ai nodi a grado molto alto, il numero di archi convergenti rende statisticamente inevitabile l'affollamento visivo — il classico *hairball* — che le tecniche adottate attenuano ma non eliminano, essendo un limite strutturale del force-directed layout a questa scala, non un difetto specifico dell'implementazione.

### 3.3 Il Visual Information Seeking Mantra

Il progetto segue in modo pervasivo *"Overview first, zoom and filter, then details-on-demand"* di Shneiderman, in entrambe le viste:

- **Overview**: grafo 3D e istogramma timeline mostrano **sempre l'intero dataset** fin dall'apertura — nessun sottoinsieme iniziale nascosto, nessun "Core Backbone" con espansione progressiva (possibilità valutata e scartata, §4).
- **Zoom and filter**: nel grafo, filtri per decade e working group (§5.5) e camera che si avvicina al nodo selezionato; nella timeline, `d3.zoom` per navigare tra le colonne-anno (§6.2) e un filtro per working group con semantica diversa e motivata (§6.3).
- **Details-on-demand**: il click su un nodo, in entrambe le viste, apre un pannello di dettaglio con i campi anagrafici, senza sovraccaricare la vista d'insieme con testo non sempre necessario.

### 3.4 Codifica visiva: canali categorici e quantitativi

Il progetto distingue due famiglie di dati, assegnando a ciascuna il canale percettivo più adatto:

- **Dati quantitativi ordinati** (l'`impact_score`, misura continua di autorevolezza storica) codificati con la **dimensione** del nodo (§5.1) — il canale percettivamente più efficace per grandezze ordinabili, secondo la gerarchia di efficacia dei canali visivi in letteratura.
- **Dati categorici** (layer di rete, tipo di arco) codificati con il **colore**, da una palette pensata per l'accessibilità (§5.2), rinforzato da un secondo canale ridondante (spessore della linea per il tipo di arco) — coerente col principio per cui affidarsi a un solo canale per un'informazione importante espone l'utente a errori di lettura, in particolare in presenza di deficit della vista dei colori.

### 3.5 Community detection come struttura visiva aggiuntiva

Un force-directed layout puro (charge/link/collide) produce una disposizione guidata solo da vicinanza topologica locale, senza enfatizzare i **gruppi** di documenti storicamente collegati. Il progetto introduce una quarta forza custom (§5.4) basata sul **Label Propagation Algorithm**, quasi-lineare nel numero di archi, che assegna a ogni nodo un'etichetta di gruppo derivata dalla sola topologia Updates/Obsoletes. Il risultato — cluster spazialmente separati — si affianca a colore (layer) e dimensione (impact score) senza sovrapporsi: il raggruppamento aggiunge solo una terza dimensione percettiva, la posizione relativa, per comunicare "questi documenti appartengono alla stessa famiglia storica".

---

## 4. Architettura del sistema

Il progetto è diviso in due componenti indipendenti, collegate da un solo contratto: il file `graph_data_enriched.json` prodotto dal backend e consumato staticamente dal frontend.

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
│   (2° passaggio,     │         │   (D3.js: force sim.,    │
│   solo draft/aborted)│         │    WebGL, zoom/pan)      │
│                      │         │                          │
│  Fonti esterne:      │         │  DraftTimelineDataService│
│  - rfc-editor.org    │         │  + DraftTimelineComponent│
│    (rfc-index.xml)   │         │   (istogramma temporale, │
│  - datatracker.ietf  │         │    canvas 2D + d3-zoom)  │
│    .org (REST API)   │         │                          │
└─────────────────────┘         └──────────────────────────┘
```

**Python** solo lato backend come pipeline batch/offline: produce il file statico da due fonti autorevoli, senza dover essere interrogato in tempo reale. **Angular** è il framework scelto per il frontend per la sua gestione nativa di stato reattivo (Signals) e componenti standalone, coerenti con la separazione netta tra "chi decide cosa mostrare" (i due data service, uno per gli RFC pubblicati e uno per draft/aborted) e "chi disegna" (i due componenti di visualizzazione). Un `LandingMenuComponent` funge da punto di ingresso, presentando le due viste come due card scelte esplicitamente dall'utente — chiarendo fin da subito quale sottoinsieme del dataset si sta esplorando, coerentemente con la separazione discussa al §2.2.

**D3.js** non è usato per il rendering DOM/SVG, che con decine di migliaia di elementi degraderebbe rapidamente le prestazioni, ma solo per due sotto-sistemi: la **force simulation** (calcolo iterativo delle posizioni in base alle forze, §5.3–5.4) nel grafo, e **zoom/pan** su `<canvas>` in entrambe le viste. Il disegno effettivo avviene su `<canvas>`/WebGL, pilotato dai dati che D3 aggiorna a ogni tick della simulazione o interazione.

![Vista d'insieme del grafo completo](img/grafo-overview-completo.png)
*Fig. 1 — Vista dall'alto del grafo 3D: tutti i nodi RFC sono sempre caricati e visibili fin dall'apertura (nessun "Core Backbone", §3.3), con la palette Okabe-Ito a codificare layer e relazioni.*

---

## 5. La vista a grafo 3D degli RFC pubblicati

### 5.1 Dimensione del nodo: dall'impact score al raggio visivo

Il servizio dati filtra solo gli RFC pubblicati (`is_draft`/`is_aborted` entrambi falsi): draft e aborted non entrano in questa vista, coerentemente con l'assenza di archi discussa al §2.2. Ogni nodo residuo porta un `impact_score` calcolato lato backend con una variante pesata del PageRank: rank iniziale uniforme, archi *Obsoletes* pesati il doppio degli *Updates* (essere sostituiti da un nuovo standard è un evento più significativo del semplice aggiornamento), diverse iterazioni con damping factor standard più un "authority boost" proporzionale al grado entrante grezzo, normalizzazione finale sul massimo del grafo — una scala stabile su cui ancorare una dimensione visiva, invariante rispetto a quanti nodi ha il grafo in quel momento.

Il raggio visivo è funzione lineare dell'impact score. Poiché la libreria di rendering 3D interpreta il valore passato come **volume** della sfera e non come raggio, il codice eleva al cubo il raggio desiderato prima di passarlo — un dettaglio geometrico non banale: senza questa correzione, un raddoppio dell'impact score avrebbe prodotto un raggio percepito diverso da quello inteso, perché il volume di una sfera scala col cubo del raggio, non linearmente.

### 5.2 Colore: palette Okabe-Ito per layer e relazioni

Il colore codifica due variabili categoriche, entrambe con la palette **Okabe-Ito**, pensata per restare distinguibile anche in presenza delle forme più comuni di daltonismo: il layer di rete (Application/Transport/Network/Unclassified) e il tipo di arco (Updates/Obsoletes), quest'ultimo rinforzato da uno spessore di linea diverso, per non affidare un'informazione rilevante a un solo canale. Il layer non è mai ricavato da un'euristica testuale di ripiego (il campo `layer_hint`, calcolato per fallback informativo ma mai usato per decisioni visive), ma solo da una fonte autorevole (override manuale o area IETF via Datatracker) — una scelta che privilegia la correttezza della codifica rispetto alla completezza: un nodo di layer sconosciuto finisce nel bucket esplicito `Unclassified` invece di ricevere un colore inventato.

### 5.3 La force simulation e la pulizia deterministica delle collisioni

Il layout è guidato da tre forze di base più il clustering (§5.4): repulsione (`charge`) scalata sul numero di nodi per compensare la densità senza allungare i tempi di assestamento; collisione (`collide`) con raggio proporzionale al raggio visivo reale; attrazione lungo gli archi (`link`). Poiché la simulazione converge in un tempo fisso senza garantire che ogni coppia vicina abbia risolto l'overlap in quel budget — specialmente nelle zone dense —, un passaggio finale deterministico (`resolveAllCollisions`) allontana iterativamente ogni coppia ancora sovrapposta usando una griglia spaziale per evitare un confronto quadratico su tutti i nodi, finché non ne resta nessuna. Solo dopo questo passaggio il grafo viene rivelato all'utente: il risultato ha overlap zero garantito, indipendentemente da quanto la fisica sia riuscita a convergere da sola. Le posizioni assestate vengono messe in cache per la sessione corrente, così le aperture successive non ripetono l'intero assestamento.

### 5.4 Clustering per community: una quarta forza D3 custom

Oltre alle tre forze standard, il layout include una quarta forza custom che raggruppa spazialmente i nodi in base a community rilevate dalla sola topologia (Label Propagation, §3.5) — non da attributi come layer o working group, riservati a colore e filtri, per non sovrapporre due codifiche visive sullo stesso significato. La forza svolge due compiti a ogni tick: **coesione**, tirando ogni nodo verso il centroide della propria community, e **separazione netta tra cluster**, spingendo i centroidi di community diverse lontani tra loro finché la distanza non supera una soglia minima — un vincolo attivamente imposto, non un effetto collaterale della sola repulsione generica, così due cluster hanno sempre un vuoto visibile tra loro. Effetto pratico: invece di una nuvola indifferenziata, il grafo mostra addensamenti visivamente separati che corrispondono a famiglie di RFC storicamente collegati — utile in particolare al profilo "chi lavora nell'IETF" (§1.3), per individuare a colpo d'occhio famiglie di documenti correlati.

### 5.5 Filtri per attenuazione: overview sempre preservata

![Pannello filtri aperto](img/grafo-filtri-decade-wg.png)
*Fig. 2 — Pannello filtri aperto con ricerca sul working group "idr" e un nodo selezionato: si nota il tag `(layer_hint, non verificato)` per un layer non risolto in modo autorevole (§5.2), e il contatore che passa da "N RFC pubblicati" a "M evidenziati su N".*

I filtri per decade e working group non tolgono mai nodi o archi dalla simulazione: calcolano un insieme di corrispondenze e si limitano ad **attenuare** — rimpicciolire e scurire — i nodi non corrispondenti, con pulsanti "precedente/successivo" per scorrere solo tra i risultati. Scelta coerente col principio "zoom and filter" del mantra di Shneiderman (§3.3): il filtro restringe l'**attenzione**, non i **dati disponibili** — l'utente torna sempre a vedere l'intero grafo senza dover ricaricare nulla. Il raggio di collisione fisico resta sempre quello calcolato dall'impact score, non scalato dal filtro: il layout non "salta" ogni volta che un filtro si attiva o disattiva — cambia solo l'aspetto, non la fisica sottostante.

### 5.6 Interazione: focus, camera e cronologia di navigazione

Il click su un nodo non espande il grafo aggiungendo elementi prima nascosti — l'intero dataset è già caricato, coerentemente con l'overview sempre completa (§3.3) — ma applica un **focus**: si evidenziano il nodo selezionato e i soli nodi raggiunti dai suoi archi uscenti, il resto si attenua più marcatamente dei filtri (per isolare l'attenzione), e la camera vola verso il nodo con un'animazione fluida. Il pannello di dettaglio elenca in modo cliccabile gli RFC effettivamente aggiornati o resi obsoleti dal nodo selezionato, diventando un punto di navigazione tra documenti collegati — click dopo click, senza dover individuare a occhio i nodi nel grafo 3D. Una cronologia di navigazione, con pulsante "Indietro", tiene traccia della sequenza di selezioni — una funzione di *history* spesso trascurata ma rilevante quando il task prevede di seguire una catena di relazioni e poi tornare al punto di partenza.

![Pannello di dettaglio del grafo 3D](img/grafo-dettaglio-rfc1035.png)
*Fig. 3 — Nodo `RFC1035` in focus: i vicini raggiunti dagli archi uscenti in evidenza rispetto al resto del grafo attenuato, il tooltip monospazio al passaggio del mouse, il pannello di dettaglio con keyword, abstract ed elenco cliccabile degli RFC aggiornati/resi obsoleti (§5.6).*

### 5.7 Ricerca testuale come collegamento diretto

Una barra di ricerca in toolbar permette di saltare direttamente a un RFC noto per numero (tollerante a prefissi e zeri iniziali) o titolo, con risultati ordinati per rilevanza del match e, a parità di punteggio, per impact score. A differenza dei filtri (§5.5), la ricerca non attenua né evidenzia nient'altro nel grafo: è solo un collegamento diretto, coerente col task di *lookup* del profilo "ricercatore" (§1.3), distinto dal task di esplorazione strutturale servito dai filtri.

---

## 6. La vista timeline dei draft e degli abortiti

### 6.1 Layout a colonne-anno e pile alfabetiche

Gli Internet-Draft non hanno archi Updates/Obsoletes (§2.2): rappresentarli in un grafo di relazioni non avrebbe senso semantico, quindi ricevono una vista dedicata, puramente temporale. Ogni anno presente nel dataset diventa una colonna a coordinata X fissa; un bucket "n.d." raccoglie i documenti il cui anno non è risolvibile (§2.3), posizionato dopo l'ultimo anno con uno stacco visivo aggiuntivo per segnalare che non fa parte della sequenza temporale continua — un design deliberato: non si inventa un anno falso per un documento la cui data non è nota, preferendo un'assenza esplicita a un dato fittizio che ingannerebbe la lettura. Dentro ogni colonna, i documenti sono impilati verticalmente in ordine alfabetico di identificativo.

### 6.2 Zoom, pan e rendering del solo visibile

L'interazione è affidata a `d3.zoom` applicato al canvas: drag per lo scorrimento, rotellina per lo zoom. Ad ogni evento, il ridisegno avviene **solo per la porzione effettivamente visibile** — solo le colonne-anno nell'intervallo inquadrato, e solo gli elementi di pila il cui indice ricade nell'intervallo verticale visibile — evitando di dover ridisegnare l'intero dataset a ogni frame, che con decine di migliaia di elementi sarebbe altrimenti il collo di bottiglia principale delle prestazioni.

![Vista timeline draft, colonne per anno, documento selezionato](img/timeline-dettaglio-draft.png)
*Fig. 4 — Istogramma completo, senza filtro attivo: colonne per anno più il bucket "n.d." (§6.1), con un draft selezionato — si vede l'etichetta "DRAFT ATTIVO/SCADUTO" e la nota sulla possibile indisponibilità del documento originale nel repository IETF.*

### 6.3 Filtro per rimozione: una scelta deliberatamente diversa dal grafo

Il filtro per working group in questa vista ha un comportamento visivo **opposto** a quello del grafo (§5.5): qui i documenti non corrispondenti vengono **rimossi dal disegno**, non attenuati — non sono più disegnati né cliccabili, e la pila restante si ricompatta senza spazi vuoti. Non è un'incoerenza, ma riflette una differenza reale tra i due contesti: nel grafo l'attenuazione preserva la percezione della topologia complessiva anche mentre si filtra; nella timeline, un documento attenuato dentro una pila verticale occuperebbe comunque spazio prezioso senza aggiungere informazione utile al task di scorrere rapidamente un working group specifico — qui la densità della pila è l'informazione che conta, e mantenere spazi vuoti la degraderebbe invece di preservarla.

![Vista timeline filtrata sul working group "idr"](img/timeline-filtro-wg-conteggi.png)
*Fig. 5 — Filtro working group con ricerca testuale "idr": accanto a ogni voce compare il conteggio dei documenti di quel gruppo, e il contatore in toolbar mostra i documenti corrispondenti sul totale — coerente con la rimozione (non attenuazione) descritta sopra.*

---

## 7. Criticità di rendering incontrate e risolte

### 7.1 Raggio di collisione e archi anomalmente lunghi

Il raggio usato dalla forza di collisione era tarato con un moltiplicatore molto più grande del raggio visivo realmente renderizzato dalla libreria (quello usato per il volume della sfera, §5.1): la collisione imponeva così, tra i centri di due nodi collegati, una distanza minima superiore a quella voluta dal link, e vinceva sempre sul link stesso — il risultato erano archi anomalmente lunghi anche a bassa distanza target, un difetto diretto contro il criterio estetico di uniformità della lunghezza degli archi (§3.2). La correzione ha riallineato il moltiplicatore alla sfera effettivamente disegnata, e ha compensato l'overlap residuo aumentando le iterazioni di collisione per tick, per assorbire la compressione aggiuntiva introdotta nel frattempo dal clustering per community (§5.4).

### 7.2 Race condition nel render loop del grafo 3D

Un crash intermittente era causato da una race condition tra l'avvio del render loop della libreria di rendering 3D — che parte non appena l'istanza viene creata — e la valorizzazione asincrona del suo stato interno di layout: una chiamata di configurazione immediatamente successiva alla creazione poteva far scattare un tick prima che lo stato fosse pronto. La correzione elimina la race alla radice, non la mitiga: il grafo viene costruito con l'animazione messa esplicitamente in pausa come prima chiamata, e riattivata solo dopo un margine di sicurezza temporizzato — il render loop non parte mai prima che lo stato interno sia effettivamente pronto.

---

## 8. Automazione e riproducibilità

Il dataset non è versionato nel repository: viene rigenerato da uno script di orchestrazione (`update_dataset.sh`) agganciato al ciclo di vita di `npm` tramite gli hook `prestart`/`prebuild`, così chi lancia il comando per avviare o buildare il frontend ottiene sempre il dataset aggiornato, senza doversene ricordare esplicitamente. Ogni fase della pipeline persiste il proprio stato su disco, con cache HTTP e checkpoint periodici a scrittura atomica, rendendo l'intero processo **resumibile** a qualunque interruzione senza mai produrre un dato mancante scritto per errore come se fosse un fatto accertato (§2.3) — una garanzia di correttezza che si riflette direttamente sull'affidabilità di ciò che la visualizzazione mostra.

---

## 9. Risultati

### 9.1 I numeri del dataset

Alla generazione più recente il dataset conta, in ordine di grandezza, alcune migliaia di RFC pubblicati e alcune decine di migliaia di Internet-Draft, distribuiti tra i quattro stati del ciclo di vita descritti al §1.1. Il conteggio degli RFC è verificabile con buona precisione contro fonti enciclopediche di riferimento; il conteggio storico complessivo dei draft, privo di un riscontro pubblico aggregato altrettanto diretto, resta un ordine di grandezza plausibile piuttosto che un valore verificato con la stessa certezza — una distinzione onesta tra ciò che è verificabile e ciò che non lo è, che vale la pena mantenere anche nella lettura dei risultati.

### 9.2 Effetto visivo del clustering per community

Prima dell'introduzione della quarta forza di clustering (§5.4), il grafo si disponeva come una nuvola indifferenziata, guidata solo dall'equilibrio locale tra repulsione, attrazione lungo i link e anti-sovrapposizione: la struttura macroscopica — quali famiglie di RFC sono storicamente più interconnesse — non era percepibile a colpo d'occhio, solo ricostruibile cliccando nodo per nodo. Dopo l'introduzione della forza di clustering, il grafo mostra addensamenti spazialmente separati che corrispondono direttamente alle community rilevate dalla topologia Updates/Obsoletes, con un margine minimo garantito tra un gruppo e l'altro: un miglioramento diretto e misurabile della leggibilità strutturale per il profilo di utente che cerca una visione d'insieme (§1.3), ottenuto senza introdurre nuova informazione nel dataset — la struttura era già presente nel grafo, solo non ancora resa visivamente esplicita dal solo layout di base.

---

## 10. Analisi critica e problemi aperti

### 10.1 L'effetto hairball sugli hub ad alto grado

Il problema più rilevante ancora aperto, dal punto di vista del graph drawing, riguarda le zone attorno ai nodi con più connessioni — i pilastri storici del protocollo come DNS, che avendo anche l'impact score più alto hanno pure il raggio visivo maggiore (§5.1): qui il grafo 3D produce zone molto affollate, con numerosi archi lunghi che si accavallano e attraversano l'intera scena, il classico fenomeno noto in letteratura come **hairball**.

![Hairball attorno a un hub ad alto grado nel grafo 3D](img/grafo-hairball-hub.png)

*Fig. 6 — Caso peggiore osservato: più hub ad alto grado ravvicinati nello spazio, con gli archi Updates/Obsoletes (azzurri/arancioni) che si sovrappongono fittamente tra loro — il limite di leggibilità discusso in questa sezione, mostrato senza attenuarlo nella presentazione dei risultati.*

La causa è strutturale, non specifica di questa implementazione: in un force-directed layout, un nodo con grado molto alto ha per definizione molti archi che convergono su di esso da punti diversi del grafo, e più aumenta il grado più è statisticamente inevitabile che alcuni di quegli archi percorrano lunghe distanze nello spazio, incrociandone altri lungo il tragitto. Le mitigazioni già presenti — la forza di clustering per topologia (§5.4) e il raggio di collisione corretto (§7.1) — riducono la densità visiva **media** del grafo, ma non possono eliminare il fenomeno attorno a un hub molto connesso: agiscono sulla distanza *tra i nodi*, non sul numero di archi che convergono su uno di essi. È un limite che, per essere affrontato in modo più diretto, richiederebbe tecniche pensate specificamente per questo — discusse al §11.

### 10.2 Altri limiti noti

Restano inoltre, dichiarati esplicitamente come punti da monitorare piuttosto che come difetti risolti:

- **Persistenza dei metadati sugli RFC pubblicati**: una volta arricchiti, non vengono mai più riconsiderati, quindi correzioni successive sulle fonti esterne non si propagano automaticamente ai nodi già elaborati — una scelta di performance con un costo di aggiornabilità esplicitamente accettato;
- **Euristica di calcolo dell'impact score**: la variante di PageRank adottata (§2.1, §5.1) include un "authority boost" che rompe l'invarianza di somma costante tipica di un PageRank puro — una scelta euristica dichiarata, da tenere presente qualora si volessero confrontare i punteggi con un'implementazione standard;
- **Differenza nel numero di nuovi draft tra ambienti diversi** e **nodi residui nel bucket "n.d."** anche dopo la correzione del §2.3: due sintomi osservati ma non ancora diagnosticati con certezza, segnalati come punti da investigare piuttosto che accompagnati da un'ipotesi di causa presentata come verificata.

---

## 11. Sviluppi futuri

- **Edge bundling**: raggruppare visivamente gli archi con percorso simile attorno agli hub, per ridurre il "rumore" di linee parallele che si accavallano senza aggregazione — la direzione più diretta per attenuare ulteriormente l'hairball del §10.1, distinta dal clustering spaziale perché agisce sulla rappresentazione degli archi, non sulla posizione dei nodi.
- **Codifica visiva della lunghezza dell'arco**: opacità o spessore proporzionali alla distanza percorsa nello spazio 3D, per attenuare percettivamente gli archi più lunghi rispetto a quelli locali, rendendo la scena densa meno dominante anche senza modificare il layout sottostante.
- **Filtro on-demand per hub**: alla selezione di un nodo molto connesso, nascondere temporaneamente gli archi verso nodi non immediatamente rilevanti, per esplorarne i vicini in gruppi più piccoli — un'estensione naturale del focus visivo già esistente al click (§5.6), senza sostituirlo.
- **Espansione multi-hop del vicinato**: il servizio dati espone già una primitiva di ricerca in ampiezza fino a una profondità configurabile, pensata per un'espansione progressiva del vicinato di un nodo su più livelli, non ancora richiamata dal componente di visualizzazione, che oggi calcola un solo livello di vicini all'atto del focus (§5.6) — un'estensione che recupererebbe l'idea di *progressive disclosure* valutata nelle prime fasi di progettazione.
- **Aggiornamento indipendente del dataset**: l'attuale automazione (§8) rigenera il dataset solo quando viene lanciato un comando di sviluppo del frontend; per un deployment a lunga vita, uno scheduler indipendente resterebbe l'opzione da valutare per garantire l'aggiornamento anche senza un intervento umano che ribuildi periodicamente l'applicazione.

---

## 12. Conclusioni

Il progetto ha affrontato un problema di visualizzazione reale e non banale — comunicare struttura, importanza storica e cronologia su un grafo di alcune migliaia di nodi, mantenendo al contempo separata e leggibile una popolazione di documenti privi di struttura relazionale — applicando in modo concreto e verificabile alcuni dei principi cardine della disciplina: la distinzione tra codifica categorica e quantitativa dei dati, il mantra "overview first, zoom and filter, details-on-demand", l'uso dell'attenuazione invece della rimozione per preservare il contesto durante il filtro, e l'impiego di tecniche di layout automatico e community detection per aumentare la leggibilità strutturale senza introdurre nuova informazione nel dataset.

Il lavoro non si è fermato alla sola implementazione: ha richiesto diagnosticare e correggere due difetti di rendering con impatto diretto sui criteri estetici del graph drawing — un raggio di collisione mal tarato che violava l'uniformità della lunghezza degli archi, e una race condition che comprometteva l'affidabilità stessa della visualizzazione — e ha mantenuto per l'intero sviluppo una disciplina rigorosa nella distinzione tra dato mancante *per fatto del dominio* e dato mancante *per fallimento transitorio della raccolta*, una garanzia di correttezza che si riflette direttamente su quanto ci si può fidare di ciò che il grafico mostra.

Il progetto documenta infine, con la stessa onestà con cui presenta i risultati ottenuti, il limite più rilevante ancora aperto — l'effetto hairball attorno agli hub ad alto grado — riconoscendolo esplicitamente come un limite strutturale del force-directed layout su questa scala di dati, non nascosto dietro le mitigazioni parziali già introdotte, e ne propone direzioni di miglioramento concrete e circostanziate per il lavoro futuro.

---

## 13. Bibliografia

- **Shneiderman, B. (1996)** — [The Eyes Have It: A Task by Data Type Taxonomy for Information Visualizations](https://doi.org/10.1109/VL.1996.545307), Proceedings of the IEEE Symposium on Visual Languages, 336–343.
- **Munzner, T. (2014)** — [Visualization Analysis and Design](https://doi.org/10.1201/b17511), CRC Press, A K Peters Visualization Series.
- **Ware, C. (2019)** — [Information Visualization: Perception for Design](https://www.sciencedirect.com/book/9780128128756/information-visualization) (4th ed.), Morgan Kaufmann.
- **Purchase, H. C. (1997)** — [Which Aesthetic Has the Greatest Effect on Human Understanding?](https://doi.org/10.1007/3-540-63938-1_67), In: Graph Drawing (GD 1997), LNCS vol. 1353, Springer.
- **Eades, P. (1984)** — [A Heuristic for Graph Drawing](https://scholar.google.com/scholar?q=Eades+1984+A+heuristic+for+graph+drawing+Congressus+Numerantium), Congressus Numerantium, 42, 149–160.
- **Fruchterman, T. M. J., & Reingold, E. M. (1991)** — [Graph Drawing by Force-Directed Placement](https://doi.org/10.1002/spe.4380211102), Software: Practice and Experience, 21(11), 1129–1164.
- **Holten, D. (2006)** — [Hierarchical Edge Bundles: Visualization of Adjacency Relations in Hierarchical Data](https://doi.org/10.1109/TVCG.2006.147), IEEE TVCG, 12(5), 741–748.
- **Okabe, M., & Ito, K. (2008)** — [Color Universal Design (CUD)](https://jfly.uni-koeln.de/color/), Jfly.org.
- **RFC Editor** — [rfc-editor.org](https://www.rfc-editor.org/), fonte dell'indice ufficiale `rfc-index.xml`.
- **IETF Datatracker** — [datatracker.ietf.org](https://datatracker.ietf.org/), fonte autorevole per layer, working group, Internet-Draft ([API](https://datatracker.ietf.org/api/v1/)).
- **IETF** — [ietf.org](https://www.ietf.org/), organizzazione responsabile dello sviluppo degli standard Internet documentati come RFC.
- **Brin, S., Page, L. (1998)** — [The Anatomy of a Large-Scale Hypertextual Web Search Engine (Archived)](https://web.archive.org/web/20230606095552/http://infolab.stanford.edu/~backrub/google.html), base dell'`impact_score`.
- **Raghavan, U.N., Albert, R., Kumara, S. (2007)** — [Near linear time algorithm to detect community structures in large-scale networks](https://journals.aps.org/pre/abstract/10.1103/PhysRevE.76.036106), Phys. Rev. E 76, 036106 — LPA per il clustering spaziale.
- **D3.js** — [d3js.org](https://d3js.org/), libreria per la force simulation 3D e zoom/pan.
- **Angular** — [angular.dev](https://angular.dev/), framework usato per il frontend.

---

*Repository GitHub del progetto*: https://github.com/ilMassy/RFC-graph-visualizer
