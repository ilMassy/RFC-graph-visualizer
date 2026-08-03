import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  Output,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import ForceGraph3D from '3d-force-graph';
import SpriteText from 'three-spritetext';
import * as THREE from 'three';
import { forceCollide } from 'd3';
import { GraphDataService } from '../../services/graph-data.service';
import { DisplayLayer, Force3DGraphData, GraphLink, GraphNode, resolveDocUrl, toDisplayLayer } from '../../models/graph.model';

const ALL_LAYERS: DisplayLayer[] = ['Application', 'Transport', 'Network', 'Unclassified'];
const NO_WORKING_GROUP = '— nessun gruppo —';

// Colore del nodo "in focus" (click): quasi invisibile sullo sfondo, per
// portare l'attenzione solo sul nodo/vicini selezionati.
const FOCUS_DIMMED_NODE_COLOR = '#1a1d23';
// Colori per nodi/link esclusi dai filtri: più chiari del dim da focus,
// perché qui l'obiettivo è far risaltare i match senza nascondere il
// resto del grafo, che resta visibile e cliccabile.
const FILTER_DIMMED_NODE_COLOR = '#3a3f4c';
const FILTER_DIMMED_LINK_COLOR = '#22262f';
// Fattori di scala: i nodi che soddisfano i filtri vengono leggermente
// ingranditi, gli altri rimpiccioliti. Il raggio di collisione (vedi
// radiusFor) resta invariato in entrambi i casi, così il layout non
// "salta" quando si attiva/disattiva un filtro.
const FILTER_MATCH_SCALE = 1.2;
const FILTER_UNMATCHED_SCALE = 0.75;

/** Rileva le "community" del grafo usando SOLO la topologia degli archi
 *  (Obsoletes/Updates) — nessun attributo come layer o working group.
 *  Algoritmo: Label Propagation (LPA). Ogni nodo parte con un'etichetta
 *  propria; ad ogni iterazione adotta l'etichetta più frequente tra i
 *  suoi vicini (a parità, quella lessicograficamente minore, per
 *  determinismo). Dopo poche iterazioni le etichette convergono in
 *  gruppi di nodi densamente interconnessi: esattamente i "cluster" che
 *  vogliamo separare spazialmente. I nodi isolati (senza archi) restano
 *  ciascuno nella propria etichetta — non finiscono ammassati in un
 *  unico gruppo residuo.
 *  Costo: O(iterazioni × archi), gira UNA volta al caricamento dei dati
 *  (non ad ogni tick della simulazione), quindi trascurabile anche con
 *  ~9.800 nodi. */
function detectCommunities(nodes: GraphNode[], links: GraphLink[]): Map<string, string> {
  const neighbors = new Map<string, string[]>();
  for (const n of nodes) neighbors.set(n.id, []);
  for (const l of links) {
    const s = typeof l.source === 'string' ? l.source : l.source.id;
    const t = typeof l.target === 'string' ? l.target : l.target.id;
    neighbors.get(s)?.push(t);
    neighbors.get(t)?.push(s);
  }

  const label = new Map<string, string>();
  for (const n of nodes) label.set(n.id, n.id);

  const order = nodes.map(n => n.id);
  const MAX_ITERATIONS = 8;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    // Ordine casuale ad ogni iterazione: LPA converge meglio ed evita che
    // due etichette oscillino a vicenda se i nodi si processano sempre
    // nello stesso ordine.
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    let changed = false;
    for (const id of order) {
      const neigh = neighbors.get(id)!;
      if (neigh.length === 0) continue;

      const counts = new Map<string, number>();
      for (const nb of neigh) {
        const l = label.get(nb)!;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }

      let bestLabel = label.get(id)!;
      let bestCount = -1;
      for (const [l, count] of counts) {
        if (count > bestCount || (count === bestCount && l < bestLabel)) {
          bestLabel = l;
          bestCount = count;
        }
      }

      if (bestLabel !== label.get(id)) {
        label.set(id, bestLabel);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return label;
}

/** Forza custom per d3-force(-3d): ad ogni tick fa DUE cose, non solo
 *  l'attrazione verso il centroide.
 *
 *  1) COESIONE: tira ogni nodo verso il centroide della propria community
 *     (rilevata da `detectCommunities`, quindi basata solo su nodi+archi).
 *  2) SEPARAZIONE NETTA: spinge i centroidi di community DIVERSE lontani
 *     l'uno dall'altro finché la distanza tra loro non supera una soglia
 *     minima (`minSeparation` + un raggio stimato in base a quanti membri
 *     ha ciascuna community). Questa è la parte che prima mancava: senza
 *     di essa la separazione tra cluster era solo un effetto emergente
 *     del charge generico, che non sa nulla dei cluster e quindi non
 *     garantiva nessun margine minimo — due community potevano finire
 *     vicine o parzialmente sovrapposte. Ora è un vincolo imposto: se due
 *     centroidi sono troppo vicini vengono attivamente allontanati, quindi
 *     il risultato finale ha SEMPRE un vuoto visibile tra un cluster e
 *     l'altro, non solo "in media".
 *
 *  Le due forze si compongono nello stesso passaggio: il bersaglio verso
 *  cui ogni nodo viene attratto non è il centroide grezzo, ma il
 *  centroide + l'eventuale spostamento imposto dalla repulsione tra
 *  cluster (`offset`, sotto).
 *
 *  Costo per tick: O(n) per accumulare/normalizzare i centroidi e per
 *  applicare la forza ai nodi, più O(k²) per la repulsione a coppie tra
 *  centroidi, dove k = numero di community con almeno `MIN_CLUSTER_SIZE`
 *  membri (i cluster minuscoli/i nodi isolati sono esclusi da questo
 *  confronto a coppie, altrimenti k coinciderebbe quasi con n). Con
 *  ~9.800 nodi k resta tipicamente un ordine di grandezza più piccolo,
 *  quindi il costo aggiuntivo è trascurabile rispetto a charge/collide. */
function forceCluster(groupKeyFor: (n: GraphNode) => string, strength: number, minSeparation: number) {
  type SimNode = GraphNode & { x: number; y: number; z: number; vx: number; vy: number; vz: number };
  let nodes: SimNode[] = [];

  // Sotto questa soglia di membri una community non entra nel confronto
  // O(k²) "a coppie di sfere" (vedi sotto), ma non per questo è esclusa
  // dalla repulsione: partecipa comunque come bersaglio nei confronti
  // con i cluster grandi, così anche i cluster minuscoli/i nodi isolati
  // vengono spinti fuori da un cluster grande in cui fossero rimasti
  // intrappolati, invece di essere ignorati come nella versione precedente.
  const MIN_CLUSTER_SIZE = 4;
  // Repulsione tra cluster più aggressiva della coesione (2.4× invece
  // di 1.6×): deve "vincere" nettamente contro l'attrazione verso il
  // proprio centroide quando le due forze sono in conflitto, altrimenti
  // il margine minimo tra cluster resta risicato invece che netto.
  const INTER_CLUSTER_STRENGTH = strength * 2.4;
  // Limita lo spostamento imposto a un singolo cluster in un singolo
  // tick: con molti cluster che si respingono a vicenda nello stesso
  // istante, l'offset accumulato su una community molto "conflittuale"
  // potrebbe altrimenti superare di gran lunga quello delle altre e
  // produrre uno scatto visivo invece di un riassestamento fluido.
  // Espresso come multiplo di minSeparation, così scala in automatico
  // con la scena invece di essere una costante arbitraria.
  const MAX_OFFSET_PER_TICK = minSeparation * 0.5;

  function force(alpha: number): void {
    // Accumula centroide e dispersione (somma degli scarti quadratici
    // dal centroide) in due passaggi sui nodi: la dispersione richiede
    // il centroide già finale, quindi non si può fare in un solo giro.
    const stats = new Map<
      string,
      { x: number; y: number; z: number; count: number; sqSum: number }
    >();
    for (const n of nodes) {
      const key = groupKeyFor(n);
      let c = stats.get(key);
      if (!c) stats.set(key, (c = { x: 0, y: 0, z: 0, count: 0, sqSum: 0 }));
      c.x += n.x;
      c.y += n.y;
      c.z += n.z;
      c.count++;
    }
    for (const c of stats.values()) {
      c.x /= c.count;
      c.y /= c.count;
      c.z /= c.count;
    }
    for (const n of nodes) {
      const c = stats.get(groupKeyFor(n))!;
      const dx = n.x - c.x;
      const dy = n.y - c.y;
      const dz = n.z - c.z;
      c.sqSum += dx * dx + dy * dy + dz * dz;
    }

    // Raggio "d'ingombro" di una community: combina una stima basata sul
    // conteggio (radice cubica, perché i nodi si dispongono in volume,
    // non in linea) con la dispersione REALE misurata (RMS delle
    // distanze dal centroide). Il max delle due evita che una community
    // compatta ma numerosa risulti sovrastimata, e che una community
    // sparpagliata (per coesione debole o pochi tick trascorsi) risulti
    // invece sottostimata rispetto al suo reale ingombro visivo.
    const clusterRadius = (c: { count: number; sqSum: number }): number => {
      const byCount = 35 * Math.cbrt(c.count);
      const bySpread = c.count > 0 ? Math.sqrt(c.sqSum / c.count) : 0;
      return Math.max(byCount, bySpread);
    };

    const allClusters = [...stats.entries()];
    const offset = new Map<string, { x: number; y: number; z: number }>();
    for (const [key] of allClusters) offset.set(key, { x: 0, y: 0, z: 0 });

    for (let i = 0; i < allClusters.length; i++) {
      const [keyA, a] = allClusters[i];
      // I cluster piccoli partecipano solo come bersaglio (ricevono
      // spinta se troppo vicini a un cluster grande), non generano a
      // loro volta un confronto contro tutti gli altri cluster piccoli:
      // altrimenti MIN_CLUSTER_SIZE non filtrerebbe nulla e il costo
      // tornerebbe O(k²) su k ≈ numero di community totali.
      const aIsBig = a.count >= MIN_CLUSTER_SIZE;

      for (let j = i + 1; j < allClusters.length; j++) {
        const [keyB, b] = allClusters[j];
        const bIsBig = b.count >= MIN_CLUSTER_SIZE;
        if (!aIsBig && !bIsBig) continue;

        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
        const target = minSeparation + clusterRadius(a) + clusterRadius(b);
        if (dist >= target) continue;

        const push = ((target - dist) / dist) * INTER_CLUSTER_STRENGTH * alpha;
        const ox = dx * push;
        const oy = dy * push;
        const oz = dz * push;
        const oa = offset.get(keyA)!;
        oa.x += ox;
        oa.y += oy;
        oa.z += oz;
        const ob = offset.get(keyB)!;
        ob.x -= ox;
        ob.y -= oy;
        ob.z -= oz;
      }
    }

    // Clamp finale: se l'offset accumulato su un cluster (per via di più
    // conflitti simultanei con vicini diversi) supera il tetto per-tick,
    // lo si rinormalizza mantenendo solo la direzione, per uno
    // spostamento sempre fluido indipendentemente da quanti vicini lo
    // respingono nello stesso istante.
    for (const off of offset.values()) {
      const mag = Math.sqrt(off.x * off.x + off.y * off.y + off.z * off.z);
      if (mag > MAX_OFFSET_PER_TICK) {
        const scale = MAX_OFFSET_PER_TICK / mag;
        off.x *= scale;
        off.y *= scale;
        off.z *= scale;
      }
    }

    const k = strength * alpha;
    for (const n of nodes) {
      const key = groupKeyFor(n);
      const c = stats.get(key)!;
      const off = offset.get(key);
      const tx = c.x + (off?.x ?? 0);
      const ty = c.y + (off?.y ?? 0);
      const tz = c.z + (off?.z ?? 0);
      n.vx -= (n.x - tx) * k;
      n.vy -= (n.y - ty) * k;
      n.vz -= (n.z - tz) * k;
    }
  }

  force.initialize = (_nodes: GraphNode[]): void => {
    nodes = _nodes as SimNode[];
  };

  return force;
}

/**
 * GraphCanvasComponent — Opzione 1 del menu: "Visualizza grafo degli RFC"
 * =========================================================================
 * Solo RFC pubblicati, tutti sempre visibili (nessun Core Backbone).
 *
 * Performance: `nodeThreeObject` costruisce solo l'etichetta di testo
 * per i nodi ad alto impact score. La sfera di ogni nodo è quella di
 * default di 3d-force-graph (guidata da `nodeVal`/`nodeColor`/
 * `nodeResolution`, condivisa/ottimizzata internamente), non una
 * geometria dedicata per nodo: con ~9.800 nodi una `THREE.Group` per
 * nodo produrrebbe decine di migliaia di draw call a ogni frame contro
 * le poche centinaia realmente necessarie.
 *
 * Accessibilità daltonismo: palette Okabe-Ito, vedi layerColors.
 * Dimensione nodi: `nodeVal` è interpretato come VOLUME della sfera da
 * 3d-force-graph, quindi si passa il cubo del raggio desiderato.
 */
@Component({
  selector: 'app-graph-canvas',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './graph-canvas.component.html',
  styleUrl: './graph-canvas.component.scss',
})
export class GraphCanvasComponent implements AfterViewInit, OnDestroy {
  @Input() dataUrl = 'data/graph_data_enriched.json';
  @Input() alwaysLabelAbove = 500;
  @Output() exit = new EventEmitter<void>();

  @ViewChild('containerEl', { static: true }) containerRef!: ElementRef<HTMLDivElement>;

  private readonly graphData = inject(GraphDataService);

  readonly loaded = this.graphData.loaded;
  readonly loadError = this.graphData.loadError;
  readonly totalNodeCount = this.graphData.totalNodeCount;
  readonly minYear = this.graphData.minYear;
  readonly maxYear = this.graphData.maxYear;
  readonly selectedNode = signal<GraphNode | null>(null);
  /** RFC aggiornati dal nodo selezionato (link uscenti di tipo "Updates"),
   *  mostrati nel pannello di dettaglio come voci cliccabili. */
  readonly selectedNodeUpdates = computed<GraphNode[]>(() =>
    this.relatedNodesFor(this.selectedNode(), 'Updates'),
  );
  /** RFC resi obsoleti dal nodo selezionato (link uscenti di tipo
   *  "Obsoletes"), mostrati nel pannello di dettaglio come voci cliccabili. */
  readonly selectedNodeObsoletes = computed<GraphNode[]>(() =>
    this.relatedNodesFor(this.selectedNode(), 'Obsoletes'),
  );
  readonly filtersOpen = signal(false);
  /** Overlay dei comandi mouse: visibile alla prima apertura, richiudibile
   *  e riapribile in qualunque momento dal pulsante "?" in toolbar. */
  readonly controlsHelpOpen = signal(true);
  /** Overlay a schermo intero mostrato durante il caricamento iniziale
   *  (fetch dati + assestamento del layout di forza). Diventa `true` solo
   *  quando il grafo è già "fermo" (onEngineStop) con i dati veri dentro,
   *  così l'utente lo scopre già composto invece di vedere l'esplosione/
   *  assestamento dei nodi. Vedi handleEngineStop() e il fallback in
   *  ngAfterViewInit per i casi limite (dataset vuoto, engine mai fermo). */
  readonly graphReady = signal(false);

  // Palette Okabe-Ito (colorblind-safe): non solo tonalità diverse, ma
  // anche luminosità diverse tra loro, per restare leggibili anche
  // quando la sola discriminazione cromatica è compromessa. Il verde-teal
  // originale di Network è stato sostituito con il giallo Okabe-Ito
  // (#F0E442, anch'esso colorblind-safe): il verde non ha equivalenti tra
  // i colori delle stelle, mentre il giallo richiama una stella di tipo G
  // come il Sole.
  readonly layerColors: Record<DisplayLayer, string> = {
    Application: '#FF7A3D',
    Transport: '#7FD4FF',
    Network: '#F0E442',
    Unclassified: '#C7CDD6',
  };
  readonly linkColors = {
    obsoletes: '#D55E00',
    updates: '#56B4E9',
  };

  readonly decadeFilter = signal<Set<number>>(new Set());
  readonly decadesList = computed<number[]>(() => {
    const first = Math.ceil(this.minYear() / 10) * 10;
    const last = this.maxYear();
    const decades: number[] = [];
    for (let d = first; d <= last; d += 10) decades.push(d);
    return decades;
  });

  readonly allWorkingGroups = computed<string[]>(() => {
    const groups = new Set<string>();
    for (const n of this.graphData.graphData().nodes) {
      groups.add(n.working_group ?? NO_WORKING_GROUP);
    }
    return [...groups].sort((a, b) => (a === NO_WORKING_GROUP ? 1 : b === NO_WORKING_GROUP ? -1 : a.localeCompare(b)));
  });
  readonly selectedWorkingGroups = signal<Set<string>>(new Set());
  readonly workingGroupSearch = signal('');
  readonly filteredWorkingGroups = computed<string[]>(() => {
    const query = this.workingGroupSearch().trim().toLowerCase();
    const all = this.allWorkingGroups();
    if (!query) return all;
    return all.filter(wg => wg.toLowerCase().includes(query));
  });

  readonly filtersActive = computed(
    () =>
      (this.decadesList().length > 0 && this.decadeFilter().size < this.decadesList().length) ||
      this.selectedWorkingGroups().size > 0,
  );

  // --- Ricerca RFC (barra di ricerca "intelligente") ---------------------
  // Non è un filtro: non attenua/evidenzia nulla nel grafo, serve solo a
  // saltare direttamente su un RFC specifico (per numero o per titolo),
  // riusando selectRelatedNode()/focusOn() già usati dal pannello dettaglio.
  readonly rfcSearchQuery = signal('');
  readonly rfcSearchOpen = signal(false);
  readonly rfcSearchHighlightIndex = signal(0);

  /** Normalizza un ID RFC (o l'input dell'utente) per un confronto tollerante
   *  a prefisso "RFC", spazi e zeri iniziali: "RFC 0793", "rfc793" e "793"
   *  devono tutti corrispondere allo stesso documento. */
  private normalizeRfcQuery(raw: string): string {
    return raw
      .trim()
      .toLowerCase()
      .replace(/^rfc\s*/, '')
      .replace(/^0+(?=\d)/, '');
  }

  /** Risultati ordinati per rilevanza: match esatto sull'ID, poi ID che
   *  inizia con la query, poi ID che la contiene, infine titolo che la
   *  contiene. A parità di rilevanza vince l'impact score più alto.
   *  Limitato alle prime 8 voci per restare leggibile come dropdown. */
  readonly rfcSearchResults = computed<GraphNode[]>(() => {
    const rawQuery = this.rfcSearchQuery().trim();
    if (!rawQuery) return [];

    const normalizedQuery = this.normalizeRfcQuery(rawQuery);
    const lowerRawQuery = rawQuery.toLowerCase();
    if (!normalizedQuery && !lowerRawQuery) return [];

    const scored: { node: GraphNode; score: number }[] = [];
    for (const n of this.graphData.graphData().nodes) {
      const normalizedId = this.normalizeRfcQuery(n.id);
      let score = -1;
      if (normalizedQuery && normalizedId === normalizedQuery) score = 0;
      else if (normalizedQuery && normalizedId.startsWith(normalizedQuery)) score = 1;
      else if (normalizedQuery && normalizedId.includes(normalizedQuery)) score = 2;
      else if (n.title?.toLowerCase().includes(lowerRawQuery)) score = 3;
      if (score >= 0) scored.push({ node: n, score });
    }

    scored.sort((a, b) => a.score - b.score || b.node.impact_score - a.node.impact_score);
    return scored.slice(0, 8).map(s => s.node);
  });

  /** Numero di nodi che soddisfano i filtri correnti, `null` quando nessun
   *  filtro è attivo (cioè "tutti evidenziati" non ha senso mostrarlo). */
  readonly filteredMatchCount = signal<number | null>(null);

  private filterMatchList: string[] = [];
  readonly filterMatchIndex = signal<number | null>(null); // posizione corrente nella lista, null = nessun filtro/nessun match

  /**
   * Cache statica (per sessione applicativa, non per istanza) delle
   * posizioni finali del layout di forza del grafo RFC. Angular distrugge
   * e ricrea questo componente ogni volta che si esce/rientra dal menu
   * (ngOnDestroy → ngAfterViewInit), quindi un campo di istanza andrebbe
   * perso; un campo `static` invece sopravvive tra un'istanza e l'altra
   * finché il JS della pagina resta in memoria, e si azzera da solo
   * quando si esce davvero dal sistema (reload/chiusura pagina) — che è
   * esattamente il comportamento richiesto: assestamento delle forze
   * solo alla primissima apertura del grafo per sessione.
   *
   * Se il flusso di "uscita dal sistema" dell'app non ricarica la
   * pagina (SPA che resta viva anche dopo il logout), richiamare
   * `GraphCanvasComponent.resetSettledLayout()` da quel punto per
   * forzare comunque un nuovo assestamento al prossimo ingresso.
   */
  private static settledPositions: Map<string, { x: number; y: number; z: number }> | null = null;

  /** Azzera la cache del layout assestato, forzando un nuovo assestamento
   *  delle forze al prossimo ingresso nel grafo. Da richiamare solo da un
   *  eventuale flusso di logout/uscita dal sistema che non comporta un
   *  reload della pagina. */
  static resetSettledLayout(): void {
    GraphCanvasComponent.settledPositions = null;
  }

  private graph: any;
  private highlightNodes = new Set<string>();
  private highlightLinks = new Set<GraphLink>();
  /** `null` = nessun filtro attivo (nessuna attenuazione). Altrimenti:
   *  insieme degli id dei nodi che soddisfano i filtri correnti. Il grafo
   *  completo resta SEMPRE caricato — i filtri non rimuovono più nulla,
   *  evidenziano i match e attenuano il resto (colore neutro + nodi più
   *  piccoli), restando comunque visibili e cliccabili. */
  private filterMatchSet: Set<string> | null = null;
  private graphDataInitialized = false;
  private resizeObserver?: ResizeObserver;
  /** Garantisce che graphReady venga impostato una sola volta: onEngineStop
   *  può scattare più volte (es. dopo un d3ReheatSimulation successivo), ma
   *  la schermata di caricamento iniziale va nascosta solo alla prima. */
  private readyEmitted = false;
  /** La simulazione fisica (charge+link+collide) converge in tempo fisso
   *  ma NON garantisce che ogni singola coppia di nodi vicini abbia già
   *  risolto l'overlap in quel budget — specialmente in zone dense. Questo
   *  flag distingue il primo `onEngineStop` (fine simulazione normale) dal
   *  secondo, che scatta dopo il passaggio deterministico di pulizia
   *  collisioni (vedi resolveAllCollisions()): solo dopo quello si rivela
   *  il grafo, con zero overlap garantito indipendentemente da quanto ha
   *  girato la fisica prima. */
  private collisionPolishDone = false;

  /** Mappa id-nodo → community rilevata da `detectCommunities()`, calcolata
   *  UNA sola volta al caricamento dei dati (non ad ogni tick) e usata come
   *  chiave di raggruppamento dalla forza `cluster` (vedi setupGraph()).
   *  Dipende solo dalla topologia degli archi, non da layer/working group. */
  private nodeCommunity = new Map<string, string>();

  private selectedNodeRef: GraphNode | null = null;
  private pulseStartTime = 0;

  /** Cronologia delle selezioni (focus su nodo o nessuna selezione), per la
   *  freccia "torna indietro". Ogni voce è lo stato PRECEDENTE al momento
   *  in cui si è passati a una nuova selezione — quindi `goBack()` la
   *  ripristina semplicemente riapplicandola. `null` = nessun nodo
   *  selezionato in quel punto della cronologia. */
  private navigationHistory: (GraphNode | null)[] = [];
  /** true mentre `goBack()` sta riapplicando uno stato precedente: evita
   *  che quella stessa riapplicazione venga a sua volta registrata come
   *  nuova voce di cronologia (altrimenti "indietro" non avanzerebbe mai). */
  private isNavigatingHistory = false;
  readonly canGoBack = signal(false);

  private readonly radiusFor = (impact: number): number => 22.0 + Math.max(impact, 0) * 1.4;

  /** Margine minimo, in unità di scena, che deve SEMPRE restare libero tra
   *  le superfici di due nodi anche dopo la risoluzione delle collisioni —
   *  non un semplice epsilon per evitare divisioni per zero, ma uno spazio
   *  vuoto visibile apposta, così due nodi non risultano mai "a contatto". */
  private readonly NODE_GAP = 8;

  /** Raggio di collisione condiviso da forceCollide (durante la
   *  simulazione) e resolveAllCollisions (passaggio finale deterministico):
   *  un'unica definizione, non due formule duplicate che potrebbero
   *  disallinearsi. Include già metà di NODE_GAP, così sommando i raggi
   *  di due nodi qualsiasi si ottiene sempre almeno NODE_GAP di vuoto tra
   *  le due superfici.
   *  Moltiplicatore ridotto da 4.5 a 2.2: quel valore, molto più grande
   *  della sfera realmente renderizzata (radiusFor puro, usato da
   *  nodeVal), era la vera causa degli archi troppo lunghi — la
   *  collisione impone una distanza minima tra i CENTRI di due nodi
   *  collegati indipendentemente da quanto basso si imposti link.distance:
   *  se la somma dei due raggi di collisione supera la distanza target
   *  del link, è la collisione a vincere e l'arco resta comunque lungo. */
  private collisionRadiusFor(n: GraphNode): number {
    return this.radiusFor(n.impact_score) * 2.2 + this.NODE_GAP / 2;
  }

  /** Dimensione visiva del nodo: invariata se nessun filtro è attivo;
   *  ingrandita per i match, rimpicciolita per i non-match. Il raggio di
   *  collisione (forceCollide, sotto) resta invariato in entrambi i casi,
   *  quindi il layout non si ridispone quando si attiva/disattiva un filtro. */
  private nodeValFor(n: GraphNode): number {
    const baseRadius = this.radiusFor(n.impact_score);
    if (this.filterMatchSet === null) return Math.pow(baseRadius, 3);
    const matched = this.filterMatchSet.has(n.id);
    const radius = baseRadius * (matched ? FILTER_MATCH_SCALE : FILTER_UNMATCHED_SCALE);
    return Math.pow(radius, 3);
  }

  constructor() {
    // Effect 1: carica il dataset completo nel grafo UNA sola volta, non
    // appena disponibile. Da qui in poi il grafo non viene più ricostruito
    // per via dei filtri (niente `graphData()` ripetuto), quindi il layout
    // di forza non riparte/non "salta" quando si attiva un filtro.
    effect(() => {
      const fullData = this.graphData.graphData();
      if (!this.graph || fullData.nodes.length === 0 || this.graphDataInitialized) return;

      // Community rilevate SOLO da nodi+archi (nessun layer/working group):
      // sono la chiave di raggruppamento della forza 'cluster' qui sotto.
      // Va calcolata prima di passare i dati al grafo, così la forza la
      // trova già pronta al primo tick.
      this.nodeCommunity = detectCommunities(fullData.nodes, fullData.links);

      // Se questa è una riapertura del grafo nella stessa sessione, il
      // layout è già assestato: niente nuova simulazione da attendere.
      const usedCachedLayout = this.applySettledLayoutIfCached(fullData.nodes);

      this.graph.graphData(fullData);
      this.graphDataInitialized = true;

      if (usedCachedLayout) {
        this.collisionPolishDone = true;
        // Nodi già pinnati (fx/fy/fz): nessun tick di simulazione serve
        // più, azzerarli risparmia calcoli inutili in background.
        this.graph.cooldownTicks(0);
        this.markGraphReady();
        return;
      }

      // Repulsione scalata in base al numero di nodi
      // Per compensare la spinta più forte senza
      // allungare troppo i tempi di assestamento, d3VelocityDecay/
      // d3AlphaDecay in setupGraph() sono alzati leggermente rispetto ai
      // default di 3d-force-graph.
      const chargeStrength = -10000 - 20000 * Math.min(1, fullData.nodes.length / 6000);
      this.graph.d3Force('charge').strength(chargeStrength).distanceMax(3200);
    });

    // Effect 2: quando cambiano i filtri non si tocca `graphData()` — si
    // ricalcola solo l'insieme dei nodi che li soddisfano e si rinfrescano
    // gli stili (colore/dimensione) di conseguenza.
    effect(() => {
      const fullData = this.graphData.graphData();
      const decades = this.decadeFilter();
      const selectedWg = this.selectedWorkingGroups();
      if (!this.graph || fullData.nodes.length === 0) return;

      this.filterMatchSet = this.computeFilterMatch(fullData, decades, selectedWg);
      this.filteredMatchCount.set(this.filterMatchSet ? this.filterMatchSet.size : null);
      this.filterMatchList = this.filterMatchSet ? [...this.filterMatchSet] : [];
      this.filterMatchIndex.set(null); // reset cursore ogni volta che i filtri cambiano
      this.refreshStyles();
    });

    // Effect 3 (fallback): se il caricamento termina con un dataset vuoto
    // non scatterà mai una simulazione da "fermare" (onEngineStop), quindi
    // la schermata iniziale andrebbe altrimenti mostrata all'infinito.
    effect(() => {
      if (this.readyEmitted) return;
      if (this.loaded() && this.totalNodeCount() === 0) {
        this.markGraphReady();
      }
    });
  }
  
  // Aggiungi un segnale per il messaggio
  readonly loadingMessage = signal('Caricamento grafo RFC…');

  async ngAfterViewInit(): Promise<void> {
    this.setupGraph();
    this.observeResize();

    // Sequenza temporizzata dei messaggi
    setTimeout(() => this.loadingMessage.set('Assestamento delle forze…'), 3000);
    setTimeout(() => this.loadingMessage.set('Quasi fatto…'), 6500);

    // Rete di sicurezza: se onEngineStop non dovesse mai scattare (versioni
    // diverse della libreria, dataset patologico, ecc.) non si vuole restare
    // bloccati con la schermata di caricamento a vita.
    // IMPORTANTE: su macchine più lente (CPU throttled, niente batteria) la
    // simulazione fisica può legittimamente non aver ancora raggiunto
    // cooldownTime/cooldownTicks a 10s — questo timer scattava PRIMA del
    // vero onEngineStop e rivelava il grafo chiamando solo markGraphReady(),
    // saltando resolveAllCollisions() (nodi non ancora separati → si
    // "uniscono" visivamente) e captureSettledLayout() (nessuna posizione
    // salvata → riparte da zero al prossimo ingresso). Deve quindi
    // richiamare la stessa pulizia di handleEngineStop(), non un
    // markGraphReady() "nudo". this.collisionPolishDone/this.readyEmitted
    // garantiscono che se poi arriva anche il vero onEngineStop non si
    // rifà lavoro doppio.
    setTimeout(() => this.handleEngineStop(), 10000);

    // Se i dati sono già nel servizio ritorna subito, altrimenti attende
    // il completamento del fetch.
    await this.graphData.load(this.dataUrl);

    // Una volta caricati, inizializza i dati nel grafo se non è già stato
    // fatto (l'effect qui sopra potrebbe averlo già fatto nel frattempo,
    // tipicamente quando i dati erano già in cache nel servizio da
    // un'apertura precedente nella stessa sessione).
    const data = this.graphData.graphData();
    if (this.graph && data.nodes.length > 0 && !this.graphDataInitialized) {
        this.nodeCommunity = detectCommunities(data.nodes, data.links);
        const usedCachedLayout = this.applySettledLayoutIfCached(data.nodes);

        this.graph.graphData(data);
        this.graphDataInitialized = true;

        if (usedCachedLayout) {
          this.collisionPolishDone = true;
          this.graph.cooldownTicks(0);
          this.markGraphReady();
        } else {
          // d3ReheatSimulation() è un metodo, non una prop: gira subito e
          // sincrono, quindi va rimandato di un margine di sicurezza (vedi
          // resumeAnimation in setupGraph) per lasciare al digest interno
          // (debounced) il tempo di ricostruire state.layout per i nuovi dati.
          setTimeout(() => this.graph?.d3ReheatSimulation(), 50);
        }
    }
  }

  /** Libera la memoria del grafo 3D quando la vista viene chiusa. Senza
   *  questa pulizia, geometrie/materiali/texture di Three.js e il render
   *  loop interno di 3d-force-graph resterebbero vivi a componente
   *  distrutto: riaprendo la vista più volte la memoria si accumulerebbe
   *  (nodi/link precedenti mai liberati, più contesti WebGL). */
  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.disposeGraph();
    this.containerRef?.nativeElement.replaceChildren();
  }

  private disposeGraph(): void {
    if (!this.graph) return;

    // Ferma il loop di animazione interno prima di smontare qualunque cosa.
    this.graph.pauseAnimation?.();

    // _destructor(), se presente, è il modo "ufficiale" della libreria per
    // fermare il render loop, staccare i listener DOM e liberare in
    // sicurezza il renderer WebGL. Se manca (versioni più vecchie), si fa
    // comunque il minimo indispensabile.
    const destructor = (this.graph as { _destructor?: () => void })._destructor;
    if (destructor) {
      destructor.call(this.graph);
    } else {
      const renderer = this.graph.renderer?.();
      renderer?.dispose();
      renderer?.forceContextLoss?.();
    }

    this.graph = null;
    this.selectedNodeRef = null;
    this.highlightNodes.clear();
    this.highlightLinks.clear();
    this.graphDataInitialized = false;
    this.readyEmitted = false;
  }

  /** Calcola quali nodi soddisfano i filtri correnti, SENZA rimuovere
   *  nulla dal dataset. Ritorna `null` quando nessun filtro è attivo
   *  (= tutti i nodi sono "match", nessuna attenuazione da applicare). */
  private computeFilterMatch(
    full: Force3DGraphData,
    decades: ReadonlySet<number>,
    selectedWgs: ReadonlySet<string>,
  ): Set<string> | null {
    const allDecades = this.decadesList();
    const decadeFilterActive = decades.size > 0 && decades.size < allDecades.length;
    const wgFilterActive = selectedWgs.size > 0;

    if (!decadeFilterActive && !wgFilterActive) return null;

    const matched = new Set<string>();
    for (const n of full.nodes) {
      if (decadeFilterActive) {
        if (n.year == null) continue;
        if (!decades.has(Math.floor(n.year / 10) * 10)) continue;
      }
      if (wgFilterActive) {
        const wg = n.working_group ?? NO_WORKING_GROUP;
        if (!selectedWgs.has(wg)) continue;
      }
      matched.add(n.id);
    }
    return matched;
  }

  /** Un link è "attenuato dai filtri" se almeno uno dei due estremi non è
   *  tra i nodi che soddisfano i filtri correnti. */
  private linkMatchesFilter(l: GraphLink): boolean {
    if (this.filterMatchSet === null) return true;
    const s = typeof l.source === 'string' ? l.source : l.source.id;
    const t = typeof l.target === 'string' ? l.target : l.target.id;
    return this.filterMatchSet.has(s) && this.filterMatchSet.has(t);
  }

  private setupGraph(): void {
    const container = this.containerRef.nativeElement;

    const buildGraph3D = ForceGraph3D as any;

    // `pauseAnimation()` come primissima chiamata evita il crash "can't
    // access property 'tick', e.layout is undefined": il render loop
    // (requestAnimationFrame -> tickFrame -> layout.tick()) partirebbe non
    // appena l'istanza viene creata, mentre `state.layout` viene valorizzato
    // solo dentro il ciclo di update interno di Kapsule, non garantito
    // sincrono a ogni chiamata concatenata (es. .graphData(...)). Bloccare
    // subito il render loop (nessun tickFrame finché non lo riattiviamo noi)
    // elimina la race alla radice.
    this.graph = buildGraph3D()(container)
      .pauseAnimation()
      .backgroundColor('#03040a')
      .showNavInfo(false)
      .nodeRelSize(1)
      .nodeResolution(20)
      .nodeVal((n: GraphNode) => this.nodeValFor(n))
      .nodeColor((n: GraphNode) => this.colorForNode(n))
      .nodeOpacity(1)
      .nodeLabel((n: GraphNode) => this.tooltipHtml(n))
      .enableNodeDrag(false)
      .nodeThreeObjectExtend(true)
      .nodeThreeObject((n: GraphNode) => (n.impact_score >= this.alwaysLabelAbove ? this.buildLabelSprite(n) : null))
      .linkColor((l: GraphLink) => this.colorForLink(l))
      .linkWidth((l: GraphLink) => {
        const base = l.type === 'Obsoletes' ? 20.0 : 11.0;
        if (this.isHighlightedLink(l)) return base * 2.0;
        if (!this.linkMatchesFilter(l)) return base * 0.3;
        return base;
      })
      .linkOpacity(0.9)
      // Direzione visiva dell'arco: freccia nativa di 3d-force-graph
      // (non un oggetto custom) posizionata all'estremità target, quindi
      // punta sempre dal source (chi aggiorna/rende obsoleto) al target
      // (chi viene aggiornato/reso obsoleto) — la stessa semantica già
      // usata da `l.source`/`l.target` nel resto del componente.
      .linkDirectionalArrowLength((l: GraphLink) => {
        const base = l.type === 'Obsoletes' ? 18.0 : 11.0;
        if (this.isHighlightedLink(l)) return base * 1.5;
        if (!this.linkMatchesFilter(l)) return base * 0.3;
        return base;
      })
      .linkDirectionalArrowRelPos(1)
      .linkDirectionalArrowColor((l: GraphLink) => this.colorForLink(l))
      .linkDirectionalParticles((l: GraphLink) => (this.isHighlightedLink(l) ? 4 : 0))
      .linkDirectionalParticleWidth(1.6)
      .linkDirectionalParticleSpeed(0.006)
      .cooldownTicks(1000)
      // Questo tempo governa solo la QUALITÀ dello sparpagliamento del
      // layout (charge/link), non più la garanzia di zero overlap: quella
      // è ora responsabilità di resolveAllCollisions(), che scatta
      // comunque all'onEngineStop qui sotto indipendentemente da quanto è
      // durata questa fase. Si può quindi tenerlo basso senza rischi.
      .cooldownTime(8000)
      .onEngineStop(() => this.handleEngineStop())
      .onNodeClick((n: GraphNode) => this.focusOn(n))
      .onBackgroundClick(() => this.clearFocus())
      .onNodeHover((n: GraphNode | null) => (container.style.cursor = n ? 'pointer' : 'grab'));

    // Dataset vuoto iniziale: il `.graphData(data)` reale, più avanti (via
    // effect o in ngAfterViewInit), lo sostituisce quando i dati sono pronti.
    // Il render loop resta comunque bloccato da pauseAnimation() finché non
    // chiamiamo resumeAnimation() in fondo a questo metodo.
    this.graph.graphData({ nodes: [], links: [] });

    // Repulsione base. Il chargeStrength (molto più alto) viene poi
    // sovrascritto dall'effect 1 non appena i dati sono pronti.
    this.graph.d3Force('charge').strength(-7000).distanceMax(3000);

    // Attrazione dei link rinforzata ulteriormente e distanza di riposo
    // dimezzata (era 400/0.25): ora che collisionRadiusFor non impone più
    // un raggio enorme (vedi sopra), il link può davvero avvicinare i
    // nodi collegati invece di restare vincolato dalla collisione.
    this.graph.d3Force('link').distance(180).strength(0.5);

    // Forza di clustering: raggruppa spazialmente i nodi in base alle
    // community rilevate SOLO da nodi+archi (vedi detectCommunities/
    // nodeCommunity), non da attributi come layer o working group. Oltre
    // a tirare i nodi verso il centroide del proprio gruppo, impone
    // anche un margine minimo (550 unità, alzato da 300 per una
    // separazione più marcata) tra i centroidi di community diverse.
    this.graph.d3Force('cluster', forceCluster(n => this.nodeCommunity.get(n.id) ?? n.id, 0.8, 550));

    // Performance: iterazioni di collisione alzate da 2 a 3. È la parte più
    // pesante di ogni tick con ~9.800 nodi (verifica reciproca dei raggi);
    // con la forza di clustering che ora comprime di più i nodi verso il
    // centroide del proprio gruppo, 2 iterazioni lasciavano più overlap
    // residuo da smaltire nel passaggio finale — 3 è il compromesso.
    this.graph.d3Force(
      'collide',
      forceCollide<GraphNode>(n => this.collisionRadiusFor(n))
        .strength(1)
        .iterations(3),
    );

    // alphaDecay e velocityDecay più alti dei default compensano la
    // repulsione molto forte (vedi chargeStrength sopra): più damping
    // (velocityDecay) e un decadimento di alpha leggermente più rapido
    // tengono i tempi di assestamento sotto controllo, a parità di
    // cooldownTicks/cooldownTime/alphaMin qui sotto.
    this.graph.d3AlphaDecay(0.02);
    this.graph.d3VelocityDecay(0.45);
    // alphaMin basso perché, con più repulsione e meno attrazione,
    // l'assestamento richiede più tempo per stabilizzarsi: così la
    // simulazione non si ferma in anticipo e sfrutta davvero tutta la
    // finestra di cooldownTicks/cooldownTime qui sotto (1000 tick / 25s).
    this.graph.d3AlphaMin(0.001);

    const controls = this.graph.controls() as {
      autoRotate: boolean;
      autoRotateSpeed: number;
      minDistance: number;
      maxDistance: number;
      zoomSpeed: number;
      panSpeed: number;
      rotateSpeed: number;
    };
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;
    controls.zoomSpeed = 1.5;
    controls.minDistance = 0.5;
    controls.maxDistance = 40000;
    controls.panSpeed = 0.9;
    controls.rotateSpeed = 0.9;

    this.graph.cameraPosition({ x: 0, y: 0, z: 30000 });

    // Performance: su schermi ad alta densità (Retina e simili) il renderer
    // disegnerebbe a 2x/3x pixel reali, aumentando molto il fill-rate per
    // frame senza un beneficio visivo proporzionale su una scena con
    // migliaia di nodi. Cap a 1.5 come compromesso qualità/velocità.
    const renderer = this.graph.renderer?.();
    if (renderer && typeof renderer.setPixelRatio === 'function') {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    }

    this.graph.scene().add(new THREE.AmbientLight(0xffffff, 1.2));

    // Il ciclo interno di aggiornamento di 3d-force-graph/three-forcegraph
    // (che valorizza state.layout) non è sincrono: è un `debounce(fn, 1)`
    // via setTimeout (kapsule). Chiamare resumeAnimation() subito, in coda
    // alla catena sincrona di setup, forzerebbe un tick immediato prima che
    // quel debounce interno abbia mai la possibilità di scattare, con
    // state.layout ancora non assegnato — da cui lo stesso crash evitato
    // sopra con pauseAnimation(). Un margine ampio (ben oltre l'1ms interno)
    // garantisce che il digest interno sia già passato.
    setTimeout(() => this.graph?.resumeAnimation(), 50);
  }

  private observeResize(): void {
    this.resizeObserver = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry || !this.graph) return;
      this.graph.width(entry.contentRect.width).height(entry.contentRect.height);
    });
    this.resizeObserver.observe(this.containerRef.nativeElement);
  }

  private buildLabelSprite(node: GraphNode): THREE.Object3D {
    const sprite = new SpriteText(node.id);
    sprite.color = '#f4f7ff';
    sprite.textHeight = 3.4;
    sprite.backgroundColor = 'rgba(3, 4, 10, 0.6)';
    sprite.padding = 1.5;
    (sprite as unknown as THREE.Object3D).position.set(0, this.radiusFor(node.impact_score) + 3, 0);
    return sprite as unknown as THREE.Object3D;
  }

  private tooltipHtml(n: GraphNode): string {
    const yearLabel = n.year ?? 'n.d.';
    return `<div style="font:12px 'IBM Plex Mono',monospace;color:#f4f7ff;background:rgba(3,4,10,0.9);padding:7px 10px;border-radius:6px;max-width:280px;border:1px solid rgba(86,180,233,0.4);">
      <strong>${n.id}</strong> <span style="color:#56B4E9;">· ${yearLabel}</span><br/>${n.title}
    </div>`;
  }

  private colorForNode(n: GraphNode): string {
    // Il focus da click (selezione di un nodo) ha priorità sui filtri: se
    // c'è una selezione attiva, l'attenuazione dei filtri passa in secondo
    // piano rispetto a quella del focus.
    const focusDimmed = this.highlightNodes.size > 0 && !this.highlightNodes.has(n.id);
    if (focusDimmed) return FOCUS_DIMMED_NODE_COLOR;

    if (this.filterMatchSet !== null && !this.filterMatchSet.has(n.id)) {
      return FILTER_DIMMED_NODE_COLOR;
    }
    return this.layerColors[toDisplayLayer(n.layer)];
  }

  private colorForLink(l: GraphLink): string {
    const highlighted = this.isHighlightedLink(l);
    if (this.highlightNodes.size > 0 && !highlighted) return FOCUS_DIMMED_NODE_COLOR;

    if (!this.linkMatchesFilter(l)) return FILTER_DIMMED_LINK_COLOR;
    return l.type === 'Obsoletes' ? this.linkColors.obsoletes : this.linkColors.updates;
  }

  /** Non usato direttamente da setupGraph (che ha una closure inline con
   *  gli stessi criteri); tenuto per coerenza/riuso futuro. */
  private widthForLink(l: GraphLink): number {
    const base = l.type === 'Obsoletes' ? 1.6 : 0.7;
    if (this.isHighlightedLink(l)) return base * 2.2;
    if (!this.linkMatchesFilter(l)) return base * 0.3;
    return base;
  }

  private isHighlightedLink(l: GraphLink): boolean {
    return this.highlightLinks.has(l);
  }

  private focusOn(node: GraphNode): void {
    this.recordNavigationHistory();
    this.selectedNode.set(node);

    // Solo archi USCENTI dal nodo selezionato (source === node.id), non
    // quelli entranti: a differenza di reachableFrom/linksAmong (che non
    // distinguono la direzione), qui si filtrano i link direttamente sul
    // dataset completo così da evidenziare solo ciò che parte dal nodo.
    const fullData = this.graphData.graphData();
    const outgoingLinks = fullData.links.filter(l => {
      const sourceId = typeof l.source === 'string' ? l.source : l.source.id;
      return sourceId === node.id;
    });
    const reachableIds = new Set<string>([node.id]);
    for (const l of outgoingLinks) {
      const targetId = typeof l.target === 'string' ? l.target : l.target.id;
      reachableIds.add(targetId);
    }

    this.highlightNodes = reachableIds;
    this.highlightLinks = new Set(outgoingLinks);
    this.refreshStyles();

    this.selectedNodeRef = node;
    this.pulseStartTime = performance.now();

    const n = node as unknown as { x?: number; y?: number; z?: number };
    if (n.x != null && n.y != null && n.z != null) {
      const nodeRadius = this.radiusFor(node.impact_score);
      const distance = Math.max(220, nodeRadius * 4.5);

      const originDist = Math.hypot(n.x, n.y, n.z) || 1;
      const distRatio = 1 + distance / originDist;

      this.graph.cameraPosition(
        { x: n.x * distRatio, y: n.y * distRatio, z: n.z * distRatio },
        { x: n.x, y: n.y, z: n.z },
        900,
      );
    }
  }

  private clearFocus(): void {
    this.recordNavigationHistory();
    this.selectedNode.set(null);
    this.highlightNodes.clear();
    this.highlightLinks.clear();
    this.refreshStyles();

    this.selectedNodeRef = null;
  }

  /** Salva lo stato di selezione ATTUALE (prima che venga sovrascritto) in
   *  cima allo stack di cronologia. Non-op mentre `goBack()` sta già
   *  riapplicando una voce precedente, altrimenti ogni passo indietro
   *  registrerebbe subito un passo avanti che lo annulla. */
  private recordNavigationHistory(): void {
    if (this.isNavigatingHistory) return;
    this.navigationHistory.push(this.selectedNodeRef);
    this.canGoBack.set(true);
  }

  /** Freccia "torna indietro" in toolbar: ripristina l'ultima selezione
   *  (nodo in focus, o nessuna selezione) precedente all'azione corrente. */
  goBack(): void {
    if (this.navigationHistory.length === 0) return;

    const previous = this.navigationHistory.pop()!;
    this.canGoBack.set(this.navigationHistory.length > 0);

    this.isNavigatingHistory = true;
    try {
      if (previous) {
        this.focusOn(previous);
      } else {
        this.clearFocus();
      }
    } finally {
      this.isNavigatingHistory = false;
    }
  }

  /** Azzera la cronologia di navigazione: usato quando un reset esplicito
   *  (vista o uscita dal menu) rende "indietro" concettualmente privo di
   *  senso — non c'è un'azione precedente sensata a cui tornare. */
  private clearNavigationHistory(): void {
    this.navigationHistory = [];
    this.canGoBack.set(false);
  }

  goToMatch(step: 1 | -1): void {
    if (this.filterMatchList.length === 0) return;

    // Il cursore salvato in filterMatchIndex vale solo se corrisponde
    // ancora al nodo attualmente selezionato: se nel frattempo il focus
    // è cambiato per un'altra via (click diretto sul grafo, voce
    // Updates/Obsoletes, "torna indietro"), il cursore è ormai stantio e
    // va ricalcolato da dove ci si trova davvero, altrimenti Succ./Prec.
    // riprende da un RFC diverso da quello in cui si è.
    const selected = this.selectedNode();
    const selectedIndex = selected ? this.filterMatchList.indexOf(selected.id) : -1;
    let current = this.filterMatchIndex();
    if (current === null || selectedIndex !== current) {
      // Se ci si trova già su un nodo che soddisfa i filtri correnti, la
      // navigazione riparte da lì; altrimenti si parte "prima" del primo
      // elemento della lista, così Succ. va al primo e Prec. all'ultimo.
      current = selectedIndex;
    }
    const next = (current + step + this.filterMatchList.length) % this.filterMatchList.length;
    this.filterMatchIndex.set(next);

    const node = this.graphData.getNode(this.filterMatchList[next]);
    if (node) this.focusOn(node);
  }

  /** Chiamato da 3d-force-graph ogni volta che la simulazione si ferma
   *  (alpha sotto soglia, o cooldownTicks/cooldownTime raggiunti). Può
   *  scattare più volte (es. dopo un d3ReheatSimulation successivo), ma la
   *  schermata di caricamento va tolta solo alla prima, e solo se il grafo
   *  contiene già i dati veri. */
  private handleEngineStop(): void {
    if (this.readyEmitted) return;
    if (!this.graphDataInitialized) return;
    if (this.graphData.graphData().nodes.length === 0) return;

    // Prima di rivelare il grafo, garanzia deterministica zero-overlap:
    // vedi resolveAllCollisions(). Costa pochissimo (una volta sola, con
    // griglia spaziale) rispetto ad allungare l'intera simulazione fisica.
    if (!this.collisionPolishDone) {
      this.collisionPolishDone = true;
      this.resolveAllCollisions();
    }

    this.captureSettledLayout();
    this.markGraphReady();
  }

  /** Applica (se presente) il layout già assestato in una precedente
   *  apertura di questa sessione: assegna x/y/z e li "pinna" (fx/fy/fz,
   *  la convenzione di d3-force per un nodo a posizione fissa) su ogni
   *  nodo corrispondente, così la simulazione fisica non lo rimette più
   *  in movimento. Ritorna `true` se la cache è stata applicata (nessuna
   *  nuova simulazione necessaria).
   *
   *  Se il dataset non corrisponde esattamente a quello per cui la cache
   *  era stata costruita (es. enriched.json cambiato tra una sessione e
   *  l'altra), la cache viene scartata: un layout solo parzialmente
   *  applicato sarebbe peggio che rifare l'assestamento da zero. */
  private applySettledLayoutIfCached(nodes: GraphNode[]): boolean {
    const cached = GraphCanvasComponent.settledPositions;
    if (!cached) return false;

    // Verifica il match completo PRIMA di toccare i nodi: se anche uno solo
    // manca in cache, scarta senza aver già pinnato metà del grafo alle
    // vecchie posizioni (altrimenti i nodi pinnati restano immobili mentre
    // quelli nuovi partono da zero, causando sovrapposizioni).
    for (const n of nodes) {
      if (!cached.has(n.id)) {
        GraphCanvasComponent.settledPositions = null;
        return false;
      }
    }

    type PinnedNode = GraphNode & { x?: number; y?: number; z?: number; fx?: number; fy?: number; fz?: number };
    for (const n of nodes as PinnedNode[]) {
      const pos = cached.get(n.id)!;
      n.x = pos.x;
      n.y = pos.y;
      n.z = pos.z;
      n.fx = pos.x;
      n.fy = pos.y;
      n.fz = pos.z;
    }
    return true;
  }

  /** Salva le posizioni finali del layout nella cache statica di
   *  sessione, così i prossimi ingressi nel grafo (finché l'app resta
   *  aperta) possono saltare del tutto l'assestamento delle forze.
   *  Scatta solo la prima volta: la cache, una volta valorizzata, non va
   *  più sovrascritta, dato che i filtri non alterano mai il layout
   *  (vedi computeFilterMatch). */
  private captureSettledLayout(): void {
    if (GraphCanvasComponent.settledPositions) return;
    if (!this.graph) return;

    type PositionedNode = GraphNode & { x: number; y: number; z: number };
    const nodes = (this.graph.graphData().nodes as PositionedNode[]).filter(
      n => n.x != null && n.y != null && n.z != null,
    );
    if (nodes.length === 0) return;

    const map = new Map<string, { x: number; y: number; z: number }>();
    for (const n of nodes) {
      map.set(n.id, { x: n.x, y: n.y, z: n.z });
    }
    GraphCanvasComponent.settledPositions = map;
  }

  /** Passaggio finale, deterministico e indipendente dalla fisica a
   *  molla/repulsione: per ogni nodo, cerca (con una griglia spaziale, non
   *  un confronto O(n²) — con ~9.800 nodi sarebbe troppo lento) gli altri
   *  nodi abbastanza vicini da poter collidere e, se la distanza tra i due
   *  centri è inferiore alla somma dei raggi di collisione, li allontana
   *  esattamente quanto basta a eliminare l'overlap. Ripete finché non
   *  trova più alcuna sovrapposizione (o fino a un tetto di sicurezza di
   *  passate), quindi il risultato NON dipende da quanti tick ha girato
   *  la simulazione prima: anche con un `cooldownTime` molto basso, questo
   *  passaggio chiude comunque ogni overlap residuo. */
  private resolveAllCollisions(): void {
    if (!this.graph) return;
    type PositionedNode = GraphNode & { x: number; y: number; z: number };
    const nodes = (this.graph.graphData().nodes as PositionedNode[]).filter(
      n => n.x != null && n.y != null && n.z != null,
    );
    if (nodes.length === 0) return;

    // Stesso raggio di collisione condiviso usato dalla forceCollide live
    // in setupGraph (vedi collisionRadiusFor), per coerenza garantita: una
    // sola formula, non due copie che potrebbero disallinearsi.
    const collisionRadius = (n: PositionedNode) => this.collisionRadiusFor(n);
    const maxRadius = nodes.reduce((max, n) => Math.max(max, collisionRadius(n)), 0);
    // Celle grandi quanto il doppio del raggio massimo: basta controllare
    // le 26 celle adiacenti per essere certi di non perdere nessuna coppia
    // potenzialmente in collisione.
    const cellSize = Math.max(1, maxRadius * 2);
    const cellKey = (x: number, y: number, z: number) =>
      `${Math.floor(x / cellSize)}|${Math.floor(y / cellSize)}|${Math.floor(z / cellSize)}`;

    // Tetto di passate alzato da 40 a 80: la forza di clustering ora
    // comprime più nodi in regioni più piccole (separazione tra cluster
    // più netta = maggiore densità dentro ogni cluster), quindi possono
    // servire più passate per smaltire le catene di overlap residue.
    const MAX_PASSES = 80;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const grid = new Map<string, PositionedNode[]>();
      for (const n of nodes) {
        const key = cellKey(n.x, n.y, n.z);
        const bucket = grid.get(key);
        if (bucket) bucket.push(n);
        else grid.set(key, [n]);
      }

      let anyOverlap = false;
      for (const n of nodes) {
        const rN = collisionRadius(n);
        const cx = Math.floor(n.x / cellSize);
        const cy = Math.floor(n.y / cellSize);
        const cz = Math.floor(n.z / cellSize);

        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
              const bucket = grid.get(`${cx + dx}|${cy + dy}|${cz + dz}`);
              if (!bucket) continue;

              for (const m of bucket) {
                // Confronta ogni coppia una sola volta (id come tie-break)
                // per non annullare da soli lo spostamento appena fatto.
                if (m === n || m.id <= n.id) continue;

                const ddx = m.x - n.x;
                const ddy = m.y - n.y;
                const ddz = m.z - n.z;
                let dist = Math.hypot(ddx, ddy, ddz);
                const minDist = rN + collisionRadius(m);
                if (dist >= minDist) continue;

                anyOverlap = true;
                // Nodi coincidenti (dist ~ 0): direzione arbitraria ma
                // deterministica, altrimenti non c'è verso lungo cui separarli.
                if (dist < 1e-6) dist = 1e-6;
                const overlap = (minDist - dist) / 2 + 0.01; // piccolo margine
                const ux = ddx / dist;
                const uy = ddy / dist;
                const uz = ddz / dist;
                m.x += ux * overlap;
                m.y += uy * overlap;
                m.z += uz * overlap;
                n.x -= ux * overlap;
                n.y -= uy * overlap;
                n.z -= uz * overlap;
              }
            }
          }
        }
      }

      if (!anyOverlap) break;
    }

    this.graph.refresh();
  }

  private markGraphReady(): void {
    if (this.readyEmitted) return;
    this.readyEmitted = true;
    this.graphReady.set(true);
  }

  private refreshStyles(): void {
    if (!this.graph) return;
    // Non riassegnare gli accessor con `this.graph.nodeColor(this.graph.nodeColor())`:
    // Kapsule (su cui è costruito 3d-force-graph) confronta il nuovo valore
    // col riferimento già impostato per decidere se propagare l'update, e
    // passando indietro la stessa funzione spesso non rileva alcun cambiamento.
    // `refresh()` è il metodo che la libreria espone apposta per questo caso:
    // rilegge gli accessor correnti e ridisegna nodi/link senza riassegnarli.
    this.graph.refresh();
  }

  docUrl(node: GraphNode): string | null {
    return resolveDocUrl(node);
  }

  /** Nodi raggiunti da un link USCENTE dal nodo dato, del tipo richiesto
   *  ('Updates' o 'Obsoletes'). Usato per popolare le liste cliccabili nel
   *  pannello di dettaglio (selectedNodeUpdates / selectedNodeObsoletes). */
  private relatedNodesFor(node: GraphNode | null, type: 'Updates' | 'Obsoletes'): GraphNode[] {
    if (!node) return [];
    const fullData = this.graphData.graphData();
    const targetIds: string[] = [];
    for (const l of fullData.links) {
      if (l.type !== type) continue;
      const sourceId = typeof l.source === 'string' ? l.source : l.source.id;
      if (sourceId !== node.id) continue;
      const targetId = typeof l.target === 'string' ? l.target : l.target.id;
      targetIds.push(targetId);
    }
    return targetIds
      .map(id => this.graphData.getNode(id))
      .filter((n): n is GraphNode => !!n);
  }

  /** Click su un RFC elencato nel pannello di dettaglio (aggiornati /
   *  resi obsoleti dal nodo corrente): sposta il focus su quel nodo,
   *  riusando la stessa logica di selezione/camera/cronologia del click
   *  diretto sul grafo. */
  selectRelatedNode(id: string): void {
    const node = this.graphData.getNode(id);
    if (node) this.focusOn(node);
  }

  toggleDecade(decade: number): void {
    const next = new Set(this.decadeFilter());
    next.has(decade) ? next.delete(decade) : next.add(decade);
    this.decadeFilter.set(next);
  }

  toggleWorkingGroup(wg: string): void {
    const next = new Set(this.selectedWorkingGroups());
    next.has(wg) ? next.delete(wg) : next.add(wg);
    this.selectedWorkingGroups.set(next);
  }

  clearWorkingGroupSelection(): void {
    this.selectedWorkingGroups.set(new Set());
  }

  onWorkingGroupSearch(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.workingGroupSearch.set(value);
  }

  onRfcSearchInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.rfcSearchQuery.set(value);
    this.rfcSearchHighlightIndex.set(0);
    this.rfcSearchOpen.set(value.trim().length > 0);
  }

  onRfcSearchFocus(): void {
    if (this.rfcSearchQuery().trim().length > 0) this.rfcSearchOpen.set(true);
  }

  /** Ritardato apposta: senza questo margine il blur chiuderebbe la lista
   *  prima che il (click) sul risultato scelto abbia modo di scattare. */
  onRfcSearchBlur(): void {
    setTimeout(() => this.rfcSearchOpen.set(false), 150);
  }

  onRfcSearchKeydown(event: KeyboardEvent): void {
    const results = this.rfcSearchResults();

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (results.length === 0) return;
      this.rfcSearchHighlightIndex.set((this.rfcSearchHighlightIndex() + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length === 0) return;
      this.rfcSearchHighlightIndex.set((this.rfcSearchHighlightIndex() - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const node = results[this.rfcSearchHighlightIndex()];
      if (node) this.selectSearchResult(node);
    } else if (event.key === 'Escape') {
      this.clearRfcSearch();
      (event.target as HTMLInputElement).blur();
    }
  }

  selectSearchResult(node: GraphNode): void {
    this.selectRelatedNode(node.id);
    this.clearRfcSearch();
  }

  clearRfcSearch(): void {
    this.rfcSearchQuery.set('');
    this.rfcSearchOpen.set(false);
    this.rfcSearchHighlightIndex.set(0);
  }

  resetFilters(): void {
    // Set vuoto = stato neutro (nessuna decade "spuntata" in blu): dato che
    // computeFilterMatch considera il filtro decadi attivo solo quando
    // 0 < size < totale, un set vuoto equivale comunque a "nessun filtro",
    // ma visivamente lascia le checkbox sbiancate invece che tutte piene.
    this.decadeFilter.set(new Set());
    this.selectedWorkingGroups.set(new Set());
    this.workingGroupSearch.set('');
  }

  toggleFiltersPanel(): void {
    this.filtersOpen.set(!this.filtersOpen());
  }

  openControlsHelp(): void {
    this.controlsHelpOpen.set(true);
  }

  closeControlsHelp(): void {
    this.controlsHelpOpen.set(false);
  }

  resetView(): void {
    this.clearFocus();
    this.clearNavigationHistory();
    this.resetFilters();
    this.graph?.cameraPosition({ x: 0, y: 0, z: 550 }, { x: 0, y: 0, z: 0 }, 1200);
  }

  exitToMenu(): void {
    this.clearFocus();
    this.clearNavigationHistory();
    this.resetFilters();

    this.graph?.cameraPosition({ x: 0, y: 0, z: 30000 }, { x: 0, y: 0, z: 0 }, 0);

    this.exit.emit();
  }
}
