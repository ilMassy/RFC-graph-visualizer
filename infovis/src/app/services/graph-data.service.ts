import { Injectable, computed, signal } from '@angular/core';
import { Force3DGraphData, GraphLink, GraphNode, RfcGraphData } from '../models/graph.model';

/**
 * GraphDataService — vista "Grafo degli RFC" (Opzione 1 del menu)
 * ===================================================================
 * SOLO RFC pubblicati: draft/aborted vengono scartati già in fase di
 * indicizzazione, non fanno parte di questa vista.
 *
 * Nodi e archi sono `signal<...>`, non semplici campi privati (`Map`/
 * array): un `computed()` si aggiorna solo quando cambia un segnale
 * letto al suo interno, non quando muta il contenuto di una struttura
 * dati "opaca" come una Map o un array normale.
 *
 * Il servizio è `providedIn: 'root'`, quindi la stessa istanza è
 * condivisa tra la vista "Grafo RFC" e la vista "Draft/Aborted
 * timeline". `load()` traccia l'URL effettivamente caricato e ricarica
 * ogni volta che l'URL richiesto differisce da quello in memoria, così
 * il passaggio tra le due viste rifà sempre il fetch del dataset giusto.
 */
@Injectable({ providedIn: 'root' })
export class GraphDataService {
  private readonly _nodes = signal<GraphNode[]>([]);
  private readonly _links = signal<GraphLink[]>([]);
  private nodesById = new Map<string, GraphNode>(); // lookup puntuali (getNode/neighborsOf); non letta da alcun computed

  private readonly _loaded = signal(false);
  private readonly _loadError = signal<string | null>(null);
  private readonly _minYear = signal(1969);
  private readonly _maxYear = signal(new Date().getFullYear() + 1);

  /** URL dell'ultimo dataset effettivamente caricato con successo.
   *  Permette a `load()` di distinguere "richiesta dello stesso dataset
   *  già in memoria" (skip, evita un fetch inutile) da "richiesta di un
   *  dataset diverso da quello attualmente in memoria" (ricarica).
   *
   *  È un signal (non un campo privato semplice) apposta perché un
   *  componente possa leggere `this.graphData.loadedUrl() === this.dataUrl`
   *  dentro un `effect()` e sapere con certezza — in modo reattivo — se i
   *  dati attualmente in `graphData()` sono davvero i suoi, invece di
   *  affidarsi al solo `graphData().nodes.length > 0` (vero anche quando
   *  i nodi in memoria sono residui dell'altra vista, dato il singleton
   *  condiviso tra le due). */
  private readonly _loadedUrl = signal<string | null>(null);
  readonly loadedUrl = this._loadedUrl.asReadonly();

  readonly loaded = this._loaded.asReadonly();
  readonly loadError = this._loadError.asReadonly();
  readonly minYear = this._minYear.asReadonly();
  readonly maxYear = this._maxYear.asReadonly();
  readonly totalNodeCount = computed(() => this._nodes().length);

  readonly graphData = computed<Force3DGraphData>(() => ({
    nodes: this._nodes(),
    links: this._links(),
  }));

  async load(url: string): Promise<void> {
    // Stesso dataset già in memoria: nessun fetch da rifare.
    if (this._loadedUrl() === url && this._loaded()) return;

    // Il vecchio loadedUrl smette subito di valere non appena inizia il
    // caricamento di un url diverso (anche prima che il fetch finisca),
    // così un componente che guarda `loadedUrl() === dataUrl` vede subito
    // "non ancora miei" invece di considerare per errore ancora validi i
    // dati del load precedente.
    this._loadedUrl.set(null);
    this._loadError.set(null);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} caricando ${url}`);
      const data: RfcGraphData = await res.json();
      this.index(data);
      this._loadedUrl.set(url);
      this._loaded.set(true);
    } catch (err) {
      this._loaded.set(false);
      this._loadedUrl.set(null);
      this._loadError.set(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private index(data: RfcGraphData): void {
    console.log('DEBUG SERVICE: Indicizzazione avviata, nodi trovati:', data.nodes.length);
    this.nodesById.clear();
    // SOLO RFC pubblicati — i draft/aborted appartengono alla vista
    // "draft-timeline", qui vengono scartati già in indicizzazione.
    const nodes: GraphNode[] = [];
    for (const n of data.nodes) {
      if (n.is_draft || n.is_aborted) continue;
      const gn = { ...n } as GraphNode;
      this.nodesById.set(n.id, gn);
      nodes.push(gn);
    }

    const links: GraphLink[] = [];
    for (const e of data.edges) {
      if (!this.nodesById.has(e.source) || !this.nodesById.has(e.target)) continue;
      links.push({ source: e.source, target: e.target, type: e.type });
    }

    const years = nodes.map(n => n.year).filter((y): y is number => y != null);
    if (years.length > 0) this._minYear.set(Math.min(...years));
    this._maxYear.set(new Date().getFullYear() + 1);

    // Impostare i segnali per ultimo, dopo che tutto è pronto: è questo
    // che fa scattare l'aggiornamento di totalNodeCount/graphData.
    this._nodes.set(nodes);
    this._links.set(links);

    console.log('DEBUG SERVICE: Indicizzazione terminata, nodi totali:', this._nodes().length);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodesById.get(id);
  }

  neighborsOf(id: string): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const l of this._links()) {
      const s = typeof l.source === 'string' ? l.source : l.source.id;
      const t = typeof l.target === 'string' ? l.target : l.target.id;
      if (s === id) ids.add(t);
      if (t === id) ids.add(s);
    }
    return ids;
  }

  /** Tutti i nodi raggiungibili da `id` seguendo Updates/Obsoletes in
  *  entrambe le direzioni, fino a `maxDepth` hop (BFS). */
  reachableFrom(id: string, maxDepth = Infinity): ReadonlySet<string> {
    const visited = new Set<string>([id]);
    let frontier = [id];
    let depth = 0;
    while (frontier.length > 0 && depth < maxDepth) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        for (const n of this.neighborsOf(nodeId)) {
          if (!visited.has(n)) {
            visited.add(n);
            next.push(n);
          }
        }
      }
      frontier = next;
      depth++;
    }
    return visited;
  }

  /** Tutti i link con entrambi gli estremi nell'insieme dato. */
  linksAmong(ids: ReadonlySet<string>): ReadonlySet<GraphLink> {
    const result = new Set<GraphLink>();
    for (const l of this._links()) {
      const s = typeof l.source === 'string' ? l.source : l.source.id;
      const t = typeof l.target === 'string' ? l.target : l.target.id;
      if (ids.has(s) && ids.has(t)) result.add(l);
    }
    return result;
  }

  incidentLinksOf(id: string): ReadonlySet<GraphLink> {
    const result = new Set<GraphLink>();
    for (const l of this._links()) {
      const s = typeof l.source === 'string' ? l.source : l.source.id;
      const t = typeof l.target === 'string' ? l.target : l.target.id;
      if (s === id || t === id) result.add(l);
    }
    return result;
  }
}
