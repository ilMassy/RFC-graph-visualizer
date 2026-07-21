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
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import * as d3 from 'd3';
import { DraftTimelineDataService, NO_WORKING_GROUP } from '../../services/draft-timeline-data.service';
import { RfcNode, resolveDocUrl } from '../../models/graph.model';

const YEAR_COLUMN_WIDTH = 110;
const NO_YEAR_GAP = 90;
const ITEM_WIDTH = 84;
const ITEM_HEIGHT = 16;
const ITEM_GAP = 3;
const BASELINE_OFFSET = 36;

/** Numero massimo di risultati mostrati nel dropdown della ricerca. */
const MAX_SEARCH_RESULTS = 8;

/** Una voce dell'indice di ricerca: il nodo più la sua posizione nella
 *  colonna (anno o "n.d.") così da poter centrare la vista senza dover
 *  rifare la ricerca lineare al momento della selezione. */
interface DraftSearchEntry {
  node: RfcNode;
  /** Indice nell'array `years` della colonna di appartenenza, oppure
   *  `null` se il nodo è nella colonna "n.d.". */
  yearIndex: number | null;
  /** Posizione del nodo all'interno della pila (ordinata alfabeticamente
   *  dal basso verso l'alto, coerente con idsForYear). */
  idx: number;
  /** Testo concatenato e normalizzato (id, titolo, working group,
   *  status, keyword, abstract) su cui gira il match testuale. */
  haystack: string;
}

/**
 * DraftTimelineComponent — Opzione 2 del menu: "Visualizza RFC in
 * draft e abortiti"
 * ======================================================================
 * Sfondo bianco (contrasto deliberato rispetto al grafo 3D — resta
 * così anche nel restyling di coerenza con l'altra vista, che riguarda
 * tipografia/pulsanti/spaziature, non il tema colore di sfondo).
 *
 * Accessibilità daltonismo: blu/vermiglio (Okabe-Ito) al posto di
 * blu/rosso puro — resta distinguibile sotto deuteranopia/protanopia,
 * e in più i due colori differiscono anche in luminosità (il vermiglio
 * è più chiaro/caldo, il blu più scuro/freddo), non solo in tonalità.
 */
@Component({
  selector: 'app-draft-timeline',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './draft-timeline.component.html',
  styleUrl: './draft-timeline.component.scss',
})
export class DraftTimelineComponent implements AfterViewInit, OnDestroy {
  @Input() dataUrl = 'data/graph_data_enriched.json';
  @Output() exit = new EventEmitter<void>();

  @ViewChild('canvasEl', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('wrapperEl', { static: true }) wrapperRef!: ElementRef<HTMLDivElement>;

  private readonly data = inject(DraftTimelineDataService);

  readonly loaded = this.data.loaded;
  readonly loadError = this.data.loadError;
  readonly totalCount = this.data.totalCount;
  readonly selectedNode = signal<RfcNode | null>(null);
  readonly filtersOpen = signal(false);
  /** Nodo sotto il cursore in questo momento (per il tooltip in stile
   *  graph-canvas), distinto da selectedNode che invece resta fissato
   *  dopo un click. `null` quando il mouse non è su nessun elemento. */
  readonly hoveredNode = signal<RfcNode | null>(null);
  /** Posizione del tooltip in coordinate SCHERMO (relative al wrapper del
   *  canvas), aggiornata a ogni mousemove insieme a hoveredNode. */
  readonly hoveredPos = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  readonly allWorkingGroups = signal<string[]>([]);
  readonly selectedWorkingGroups = signal<Set<string>>(new Set());
  readonly workingGroupSearch = signal('');
  readonly filteredWorkingGroups = computed(() => {
    const query = this.workingGroupSearch().trim().toLowerCase();
    const all = this.allWorkingGroups();
    if (!query) return all;
    return all.filter(wg => wg.toLowerCase().includes(query));
  });
  /** Numero di RFC per ciascun working group (chiave = working_group,
   *  oppure NO_WORKING_GROUP per i nodi senza gruppo), usato per mostrare
   *  il conteggio accanto a ogni voce del filtro. */
  readonly workingGroupCounts = signal<Map<string, number>>(new Map());
  /** Numero di RFC effettivamente coperti dal filtro attivo: somma dei
   *  conteggi dei working group selezionati, o totalCount() se nessun
   *  filtro è attivo. */
  readonly filteredCount = computed(() => {
    const selected = this.selectedWorkingGroups();
    if (selected.size === 0) return this.totalCount();
    const counts = this.workingGroupCounts();
    let sum = 0;
    for (const wg of selected) sum += counts.get(wg) ?? 0;
    return sum;
  });

  // Palette Okabe-Ito: blu e vermiglio, distinguibili anche sotto le
  // forme più comuni di daltonismo — stessi valori usati sia per il
  // disegno reale (fillStyle) sia per la legenda (single source of truth).
  readonly draftColor = '#0072B2';
  readonly abortedColor = '#D55E00';

  /** Testo digitato nella barra di ricerca dei singoli draft. */
  readonly draftSearchQuery = signal('');
  /** True mentre l'input di ricerca ha il focus (o subito dopo, per
   *  lasciare il tempo al mousedown su un risultato di essere gestito
   *  prima che il dropdown si chiuda). Controlla la visibilità del
   *  dropdown insieme a draftSearchQuery. */
  readonly draftSearchFocused = signal(false);
  /** Indice del risultato evidenziato per la navigazione da tastiera. */
  readonly activeResultIndex = signal(0);
  /** Risultati della ricerca sui singoli draft, ordinati per rilevanza.
   *  Dipende solo da draftSearchQuery/loaded: searchIndex è costruito una
   *  volta sola al caricamento e non cambia a runtime. */
  readonly draftSearchResults = computed<DraftSearchEntry[]>(() => {
    const query = this.draftSearchQuery().trim().toLowerCase();
    if (!query || !this.loaded()) return [];
    const tokens = query.split(/\s+/).filter(Boolean);
    const scored: { entry: DraftSearchEntry; score: number }[] = [];
    for (const entry of this.searchIndex) {
      const score = this.scoreEntry(entry, tokens);
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score || a.entry.node.id.localeCompare(b.entry.node.id));
    return scored.slice(0, MAX_SEARCH_RESULTS).map(s => s.entry);
  });

  private ctx!: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = window.devicePixelRatio || 1;
  private zoomTransform: d3.ZoomTransform = d3.zoomIdentity;
  private zoomBehavior!: d3.ZoomBehavior<HTMLCanvasElement, unknown>;
  private canvasSelection!: d3.Selection<HTMLCanvasElement, unknown, null, undefined>;
  private resizeObserver?: ResizeObserver;
  private years: number[] = [];
  private hasNoYear = false;
  /** Indice di tutti i draft costruito una sola volta al caricamento,
   *  usato dalla ricerca. Non è un signal: a cambiare è solo la query. */
  private searchIndex: DraftSearchEntry[] = [];

  async ngAfterViewInit(): Promise<void> {
    this.ctx = this.canvasRef.nativeElement.getContext('2d')!;
    this.setupInteraction();
    this.observeResize();

    if (!this.data.loaded()) {
      try {
        await this.data.load(this.dataUrl);
      } catch {
        return;
      }
    }

    this.years = this.data.years();
    this.hasNoYear = this.data.hasNoYearBucket();
    this.allWorkingGroups.set(this.data.allWorkingGroups());
    this.workingGroupCounts.set(this.computeWorkingGroupCounts());
    this.buildSearchIndex();

    const initialWorldX = this.xForYearIndex(this.years.length - 1);
    this.zoomTransform = d3.zoomIdentity.translate(this.width / 2 - initialWorldX, this.height - 60);
    this.draw();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  private setupInteraction(): void {
    const canvas = d3.select(this.canvasRef.nativeElement);
    this.canvasSelection = canvas;
    const zoom = d3
      .zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.02, 3])
      .on('zoom', (event: d3.D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        this.zoomTransform = event.transform;
        this.hoveredNode.set(null);
        this.draw();
      });
    this.zoomBehavior = zoom;
    canvas.call(zoom);
    canvas.on('click', (event: MouseEvent) => this.handleClick(event));
    canvas.on('mousemove', (event: MouseEvent) => this.handleHover(event));
    canvas.on('mouseleave', () => this.hoveredNode.set(null));
  }

  private observeResize(): void {
    this.resizeObserver = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      this.resizeCanvas(entry.contentRect.width, entry.contentRect.height);
    });
    this.resizeObserver.observe(this.wrapperRef.nativeElement);
    const rect = this.wrapperRef.nativeElement.getBoundingClientRect();
    this.resizeCanvas(rect.width, rect.height);
  }

  private resizeCanvas(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const canvas = this.canvasRef.nativeElement;
    canvas.width = Math.max(1, width * this.dpr);
    canvas.height = Math.max(1, height * this.dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    this.draw();
  }

  private xForYearIndex(idx: number): number {
    return idx * YEAR_COLUMN_WIDTH;
  }

  private xForNoYearColumn(): number {
    return this.years.length * YEAR_COLUMN_WIDTH + NO_YEAR_GAP;
  }

  private toWorld(screenX: number, screenY: number): [number, number] {
    return this.zoomTransform.invert([screenX, screenY]) as [number, number];
  }

  private draw(): void {
    if (!this.ctx || this.years.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.translate(this.zoomTransform.x, this.zoomTransform.y);
    ctx.scale(this.zoomTransform.k, this.zoomTransform.k);

    const [xLeft, yTop] = this.toWorld(0, 0);
    const [xRight, yBottom] = this.toWorld(this.width, this.height);

    const firstIdx = Math.max(0, Math.floor(xLeft / YEAR_COLUMN_WIDTH) - 1);
    const lastIdx = Math.min(this.years.length - 1, Math.ceil(xRight / YEAR_COLUMN_WIDTH) + 1);

    ctx.textAlign = 'center';
    ctx.font = `${12 / this.zoomTransform.k}px "IBM Plex Mono", monospace`;

    for (let i = firstIdx; i <= lastIdx; i++) {
      this.drawColumn(ctx, this.years[i], this.xForYearIndex(i), yTop, yBottom);
    }

    if (this.hasNoYear) {
      const ndX = this.xForNoYearColumn();
      if (ndX >= xLeft - YEAR_COLUMN_WIDTH && ndX <= xRight + YEAR_COLUMN_WIDTH) {
        this.drawColumn(ctx, null, ndX, yTop, yBottom);
      }
    }

    ctx.restore();
  }

  private drawColumn(ctx: CanvasRenderingContext2D, year: number | null, xCenter: number, yTop: number, yBottom: number): void {
    const ids = this.data.idsForYear(year);

    ctx.fillStyle = '#1a1a1a';
    ctx.fillText(year != null ? String(year) : 'n.d.', xCenter, -6);

    if (ids.length === 0) return;

    const step = ITEM_HEIGHT + ITEM_GAP;
    const idxMin = Math.max(0, Math.floor((-BASELINE_OFFSET - yBottom) / step) - 1);
    const idxMax = Math.min(ids.length - 1, Math.ceil((-BASELINE_OFFSET - yTop) / step) + 1);

    for (let idx = idxMin; idx <= idxMax; idx++) {
      const id = ids[idx];
      const node = this.data.getNode(id);
      if (!node) continue;
      const itemY = -BASELINE_OFFSET - idx * step;

      const selectedWgs = this.selectedWorkingGroups();
      const wg = node.working_group ?? NO_WORKING_GROUP;
      const isDimmed = selectedWgs.size > 0 && !selectedWgs.has(wg);

      ctx.fillStyle = isDimmed ? 'rgba(200,200,200,0.25)' : node.is_aborted ? this.abortedColor : this.draftColor;
      if (!isDimmed && this.selectedNode()?.id === id) ctx.fillStyle = '#111111';
      ctx.fillRect(xCenter - ITEM_WIDTH / 2, itemY - ITEM_HEIGHT, ITEM_WIDTH, ITEM_HEIGHT);
    }
  }

  /** Scorre tutti i bucket (anni + eventuale "n.d.") una sola volta, alla
   *  fine del caricamento, e conta quanti RFC appartengono a ciascun
   *  working group — stessa logica di fallback usata in drawColumn per
   *  determinare a quale gruppo appartiene un nodo. */
  private computeWorkingGroupCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    const buckets: (number | null)[] = [...this.years];
    if (this.hasNoYear) buckets.push(null);

    for (const year of buckets) {
      for (const id of this.data.idsForYear(year)) {
        const node = this.data.getNode(id);
        if (!node) continue;
        const wg = node.working_group ?? NO_WORKING_GROUP;
        counts.set(wg, (counts.get(wg) ?? 0) + 1);
      }
    }
    return counts;
  }

  private hitTest(screenX: number, screenY: number): RfcNode | null {
    const [worldX, worldY] = this.toWorld(screenX, screenY);

    let year: number | null = null;
    let xCenter = 0;
    let bestDist = Infinity;

    const ndX = this.xForNoYearColumn();
    if (this.hasNoYear && Math.abs(worldX - ndX) < bestDist) {
      bestDist = Math.abs(worldX - ndX);
      xCenter = ndX;
      year = null;
    }
    const idxGuess = Math.round(worldX / YEAR_COLUMN_WIDTH);
    if (idxGuess >= 0 && idxGuess < this.years.length) {
      const x = this.xForYearIndex(idxGuess);
      if (Math.abs(worldX - x) < bestDist) {
        bestDist = Math.abs(worldX - x);
        xCenter = x;
        year = this.years[idxGuess];
      }
    }

    if (bestDist > ITEM_WIDTH / 2) return null;

    const ids = this.data.idsForYear(year);
    if (ids.length === 0) return null;

    const step = ITEM_HEIGHT + ITEM_GAP;
    const idx = Math.round((-BASELINE_OFFSET - worldY) / step);
    if (idx < 0 || idx >= ids.length) return null;

    const itemY = -BASELINE_OFFSET - idx * step;
    if (worldY < itemY - ITEM_HEIGHT || worldY > itemY) return null;

    return this.data.getNode(ids[idx]) ?? null;
  }

  private handleClick(event: MouseEvent): void {
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const node = this.hitTest(event.clientX - rect.left, event.clientY - rect.top);
    this.selectedNode.set(node);
    this.draw();
  }

  private handleHover(event: MouseEvent): void {
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const node = this.hitTest(x, y);
    this.canvasRef.nativeElement.style.cursor = node ? 'pointer' : 'grab';

    if (node) {
      this.hoveredPos.set({ x, y });
      // Evita di riassegnare lo stesso riferimento a ogni pixel di
      // movimento del mouse: manterrebbe il tooltip identico ma
      // rifarebbe comunque girare i computed/effect a valle inutilmente.
      if (this.hoveredNode() !== node) this.hoveredNode.set(node);
    } else if (this.hoveredNode() !== null) {
      this.hoveredNode.set(null);
    }
  }

  docUrl(node: RfcNode): string | null {
    return resolveDocUrl(node);
  }

  /** Scorre tutti i bucket una sola volta, alla fine del caricamento, e
   *  costruisce l'indice usato dalla barra di ricerca: per ogni draft
   *  memorizza la posizione (colonna + indice nella pila) e un testo
   *  concatenato su cui far girare il match. Stessa logica di
   *  attraversamento di computeWorkingGroupCounts. */
  private buildSearchIndex(): void {
    const entries: DraftSearchEntry[] = [];
    const buckets: (number | null)[] = [...this.years];
    if (this.hasNoYear) buckets.push(null);

    for (const year of buckets) {
      const yearIndex = year != null ? this.years.indexOf(year) : null;
      const ids = this.data.idsForYear(year);
      ids.forEach((id, idx) => {
        const node = this.data.getNode(id);
        if (!node) return;
        const haystack = [node.id, node.title, node.working_group, node.status, node.abstract, ...(node.keywords ?? [])]
          .filter((v): v is string => !!v)
          .join(' ')
          .toLowerCase();
        entries.push({ node, yearIndex, idx, haystack });
      });
    }
    this.searchIndex = entries;
  }

  /** Punteggio di rilevanza per una voce dell'indice rispetto ai token
   *  della query (semantica AND: ogni token deve comparire da qualche
   *  parte, altrimenti la voce è esclusa con -1). A parità di presenza,
   *  pesa di più un match sull'id del draft rispetto a titolo/abstract,
   *  così digitare ad es. "draft-ietf-tls" porta in cima l'RFC giusto
   *  anche se la stessa stringa compare altrove nel testo. */
  private scoreEntry(entry: DraftSearchEntry, tokens: string[]): number {
    const id = entry.node.id.toLowerCase();
    const title = (entry.node.title ?? '').toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (!entry.haystack.includes(token)) return -1;
      if (id === token) score += 100;
      else if (id.startsWith(token)) score += 60;
      else if (id.includes(token)) score += 40;
      else if (title.startsWith(token)) score += 30;
      else if (title.includes(token)) score += 20;
      else score += 5;
    }
    return score;
  }

  onDraftSearchInput(event: Event): void {
    this.draftSearchQuery.set((event.target as HTMLInputElement).value);
    this.activeResultIndex.set(0);
  }

  onDraftSearchFocus(): void {
    this.draftSearchFocused.set(true);
  }

  onDraftSearchBlur(): void {
    // Piccolo ritardo: il mousedown sul risultato (che seleziona) arriva
    // prima di questo timeout, così il dropdown non sparisce troppo presto.
    setTimeout(() => this.draftSearchFocused.set(false), 120);
  }

  onDraftSearchKeydown(event: KeyboardEvent): void {
    const results = this.draftSearchResults();
    if (results.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.activeResultIndex.set((this.activeResultIndex() + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeResultIndex.set((this.activeResultIndex() - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.selectSearchResult(results[this.activeResultIndex()]);
    } else if (event.key === 'Escape') {
      this.clearDraftSearch();
    }
  }

  selectSearchResult(entry: DraftSearchEntry): void {
    this.selectedNode.set(entry.node);
    this.centerOnNode(entry);
    this.clearDraftSearch();
  }

  clearDraftSearch(): void {
    this.draftSearchQuery.set('');
    this.activeResultIndex.set(0);
    this.draftSearchFocused.set(false);
  }

  /** Sposta e (se necessario) ravvicina la vista in modo che il draft
   *  trovato dalla ricerca finisca al centro del canvas. Passa dal
   *  zoomBehavior di d3 (anziché assegnare zoomTransform direttamente)
   *  così lo stato interno di d3-zoom resta sincronizzato: altrimenti il
   *  prossimo drag/scroll dell'utente ripartirebbe dalla vecchia
   *  trasformazione, facendo "saltare" la vista. */
  private centerOnNode(entry: DraftSearchEntry): void {
    const step = ITEM_HEIGHT + ITEM_GAP;
    const xCenter = entry.yearIndex != null ? this.xForYearIndex(entry.yearIndex) : this.xForNoYearColumn();
    const itemY = -BASELINE_OFFSET - entry.idx * step;
    const k = Math.min(3, Math.max(this.zoomTransform.k, 0.6));
    const tx = this.width / 2 - k * xCenter;
    const ty = this.height / 2 - k * itemY;
    const next = d3.zoomIdentity.translate(tx, ty).scale(k);
    this.canvasSelection.call(this.zoomBehavior.transform, next);
  }

  toggleWorkingGroup(wg: string): void {
    const next = new Set(this.selectedWorkingGroups());
    next.has(wg) ? next.delete(wg) : next.add(wg);
    this.selectedWorkingGroups.set(next);
    this.draw();  
  }

  clearWorkingGroupSelection(): void {
    this.selectedWorkingGroups.set(new Set());
    this.draw();
  }

  onWorkingGroupSearch(event: Event): void {
    this.workingGroupSearch.set((event.target as HTMLInputElement).value);
  }

  toggleFiltersPanel(): void {
    this.filtersOpen.set(!this.filtersOpen());
  }
}
