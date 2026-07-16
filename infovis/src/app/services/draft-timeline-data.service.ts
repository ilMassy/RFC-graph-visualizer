import { Injectable, signal } from '@angular/core';
import { RfcGraphData, RfcNode } from '../models/graph.model';

export const NO_WORKING_GROUP = '— nessun gruppo —';

/**
 * DraftTimelineDataService — dati per l'Opzione 2 del menu ("RFC in
 * draft e abortiti")
 * ======================================================================
 * SOLO draft/aborted (il complemento esatto di GraphDataService, che
 * prende solo gli RFC pubblicati). Indicizza tutto per anno UNA VOLTA
 * al caricamento, con gli id già ordinati alfabeticamente dentro ogni
 * anno — così il componente di rendering non deve mai ordinare/filtrare
 * a runtime, solo leggere lo slice visibile.
 */
@Injectable({ providedIn: 'root' })
export class DraftTimelineDataService {
  private nodesById = new Map<string, RfcNode>();
  /** anno -> id ordinati alfabeticamente; chiave `null` = anno non risolto. */
  private byYear = new Map<number | null, string[]>();

  private readonly _loaded = signal(false);
  private readonly _loadError = signal<string | null>(null);
  private readonly _minYear = signal(1990);
  private readonly _maxYear = signal(new Date().getFullYear() + 1);

  readonly loaded = this._loaded.asReadonly();
  readonly loadError = this._loadError.asReadonly();
  readonly minYear = this._minYear.asReadonly();
  readonly maxYear = this._maxYear.asReadonly();
  readonly totalCount = signal(0);

  async load(url: string): Promise<void> {
    this._loadError.set(null);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} caricando ${url}`);
      const data: RfcGraphData = await res.json();
      this.index(data);
      this._loaded.set(true);
    } catch (err) {
      this._loadError.set(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private index(data: RfcGraphData): void {
    this.nodesById.clear();
    this.byYear.clear();

    // SOLO draft/aborted — gli RFC pubblicati sono l'altra vista.
    for (const n of data.nodes) {
      if (!n.is_draft && !n.is_aborted) continue;
      this.nodesById.set(n.id, n);
      const key = n.year ?? null;
      if (!this.byYear.has(key)) this.byYear.set(key, []);
      this.byYear.get(key)!.push(n.id);
    }

    for (const ids of this.byYear.values()) {
      ids.sort((a, b) => a.localeCompare(b));
    }

    const years = [...this.byYear.keys()].filter((y): y is number => y != null);
    if (years.length > 0) {
      this._minYear.set(Math.min(...years));
      this._maxYear.set(Math.max(...years));
    }
    this.totalCount.set(this.nodesById.size);
  }

  getNode(id: string): RfcNode | undefined {
    return this.nodesById.get(id);
  }

  /** Id ordinati alfabeticamente per un anno (null = bucket "n.d."). */
  idsForYear(year: number | null): readonly string[] {
    return this.byYear.get(year) ?? [];
  }

  /** Anni presenti nel dataset, in ordine crescente (esclude il
   *  bucket "n.d.", gestito a parte). */
  years(): number[] {
    return [...this.byYear.keys()].filter((y): y is number => y != null).sort((a, b) => a - b);
  }

  hasNoYearBucket(): boolean {
    return (this.byYear.get(null)?.length ?? 0) > 0;
  }

  allWorkingGroups(): string[] {
    const groups = new Set<string>();
    for (const n of this.nodesById.values()) {
      groups.add(n.working_group ?? NO_WORKING_GROUP);
    }
    return [...groups].sort((a, b) => (a === NO_WORKING_GROUP ? 1 : b === NO_WORKING_GROUP ? -1 : a.localeCompare(b)));
  }
}
