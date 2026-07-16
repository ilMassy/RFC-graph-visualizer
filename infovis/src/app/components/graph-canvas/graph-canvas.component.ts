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
  // quando la sola discriminazione cromatica è compromessa.
  readonly layerColors: Record<DisplayLayer, string> = {
    Application: '#FF7A3D',
    Transport: '#7FD4FF',
    Network: '#22D3A8',
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

  /** Numero di nodi che soddisfano i filtri correnti, `null` quando nessun
   *  filtro è attivo (cioè "tutti evidenziati" non ha senso mostrarlo). */
  readonly filteredMatchCount = signal<number | null>(null);

  private filterMatchList: string[] = [];
  readonly filterMatchIndex = signal<number | null>(null); // posizione corrente nella lista, null = nessun filtro/nessun match

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

  private selectedNodeRef: GraphNode | null = null;
  private pulseStartTime = 0;

  private readonly radiusFor = (impact: number): number => 22.0 + Math.max(impact, 0) * 1.4;

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

      this.graph.graphData(fullData);
      this.graphDataInitialized = true;

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
    setTimeout(() => this.loadingMessage.set('Assestamento delle forze…'), 10000);
    setTimeout(() => this.loadingMessage.set('Quasi fatto…'), 20000);

    // Rete di sicurezza: se onEngineStop non dovesse mai scattare (versioni
    // diverse della libreria, dataset patologico, ecc.) non si vuole restare
    // bloccati con la schermata di caricamento a vita.
    setTimeout(() => this.markGraphReady(), 28000);

    // Se i dati sono già nel servizio ritorna subito, altrimenti attende
    // il completamento del fetch.
    await this.graphData.load(this.dataUrl);

    // Una volta caricati, inizializza i dati nel grafo se non è già stato fatto.
    const data = this.graphData.graphData();
    if (this.graph && data.nodes.length > 0) {
        this.graph.graphData(data);
        // d3ReheatSimulation() è un metodo, non una prop: gira subito e
        // sincrono, quindi va rimandato di un margine di sicurezza (vedi
        // resumeAnimation in setupGraph) per lasciare al digest interno
        // (debounced) il tempo di ricostruire state.layout per i nuovi dati.
        setTimeout(() => this.graph?.d3ReheatSimulation(), 50);
        this.graphDataInitialized = true;
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
      .nodeResolution(12)
      .nodeVal((n: GraphNode) => this.nodeValFor(n))
      .nodeColor((n: GraphNode) => this.colorForNode(n))
      .nodeOpacity(1)
      .nodeLabel((n: GraphNode) => this.tooltipHtml(n))
      .enableNodeDrag(false)
      .nodeThreeObjectExtend(true)
      .nodeThreeObject((n: GraphNode) => (n.impact_score >= this.alwaysLabelAbove ? this.buildLabelSprite(n) : null))
      .linkColor((l: GraphLink) => this.colorForLink(l))
      .linkWidth((l: GraphLink) => {
        const base = l.type === 'Obsoletes' ? 14.0 : 7.0;
        if (this.isHighlightedLink(l)) return base * 2.0;
        if (!this.linkMatchesFilter(l)) return base * 0.3;
        return base;
      })
      .linkOpacity(0.6)
      .linkDirectionalParticles((l: GraphLink) => (this.isHighlightedLink(l) ? 4 : 0))
      .linkDirectionalParticleWidth(1.6)
      .linkDirectionalParticleSpeed(0.006)
      .cooldownTicks(1000)
      .cooldownTime(25000)
      .onEngineStop(() => this.handleEngineStop())
      .onNodeClick((n: GraphNode) => this.focusOn(n))
      .onBackgroundClick(() => this.clearFocus())
      .onNodeHover((n: GraphNode | null) => (container.style.cursor = n ? 'pointer' : 'grab'));

    // Dataset vuoto iniziale: il `.graphData(data)` reale, più avanti (via
    // effect o in ngAfterViewInit), lo sostituisce quando i dati sono pronti.
    // Il render loop resta comunque bloccato da pauseAnimation() finché non
    // chiamiamo resumeAnimation() in fondo a questo metodo.
    this.graph.graphData({ nodes: [], links: [] });

    // Repulsione base e attrazione dei link ridotta per un layout meno
    // "collante", con più spinta a separarsi. Valori di partenza, poi
    // sovrascritti dal chargeStrength (molto più alto) nell'effect 1 non
    // appena i dati sono pronti.
    this.graph.d3Force('charge').strength(-5000).distanceMax(2000);
    this.graph.d3Force('link').distance(650).strength(0.03);

    // Performance: iterazioni di collisione limitate a 2. È la parte più
    // pesante di ogni tick con ~9.800 nodi (verifica reciproca dei raggi);
    // con 2 iterazioni gli overlap residui sono trascurabili a schermo ma
    // il costo per tick si dimezza.
    this.graph.d3Force(
      'collide',
      forceCollide<GraphNode>(n => this.radiusFor(n.impact_score) * 4.5)
        .strength(1)
        .iterations(2),
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
    controls.maxDistance = 20000;
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
    this.selectedNode.set(node);
    const reachableIds = this.graphData.reachableFrom(node.id, 1); // limita i hop, es. 1
    this.highlightNodes = new Set(reachableIds);
    this.highlightLinks = new Set(this.graphData.linksAmong(reachableIds));
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
    this.selectedNode.set(null);
    this.highlightNodes.clear();
    this.highlightLinks.clear();
    this.refreshStyles();

    this.selectedNodeRef = null;
  }

  goToMatch(step: 1 | -1): void {
    if (this.filterMatchList.length === 0) return;
    const current = this.filterMatchIndex();
    const next = current === null ? 0 : (current + step + this.filterMatchList.length) % this.filterMatchList.length;
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
    this.markGraphReady();
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

  resetFilters(): void {
    this.decadeFilter.set(new Set(this.decadesList()));
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
    this.resetFilters();
    this.graph?.cameraPosition({ x: 0, y: 0, z: 550 }, { x: 0, y: 0, z: 0 }, 1200);
  }

  exitToMenu(): void {
    this.clearFocus();
    this.resetFilters();

    this.graph?.cameraPosition({ x: 0, y: 0, z: 30000 }, { x: 0, y: 0, z: 0 }, 0);

    this.exit.emit();
  }
}
