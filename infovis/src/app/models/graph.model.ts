/**
 * Modello dati allineato allo schema prodotto da rfc_pipeline.py
 * (SCHEMA_VERSION 1.2) + draft_metadata_enricher.py (vedi backend/).
 *
 * NB storico: in una versione precedente il frontend escludeva i
 * ~34.600 nodi draft/aborted isolati (impact_score 0, zero archi) per
 * risparmiare memoria. Su richiesta esplicita, quel filtro è stato
 * RIMOSSO: il grafo ora include tutti i 44.411 nodi del dataset.
 *
 * NB tecnico su GraphNode/GraphLink: inizialmente ereditavano dai tipi
 * `NodeObject`/`LinkObject` esportati da 3d-force-graph, per riflettere
 * il fatto che la libreria muta questi oggetti in-place aggiungendo
 * x/y/z/vx/vy/vz. In pratica il tipo `NodeObject` della libreria
 * dichiara `id` come `string | number`, in conflitto con `id: string`
 * di RfcNode — TypeScript non permette a un'interfaccia di ereditare
 * due definizioni incompatibili dello stesso campo. Piuttosto che
 * forzare un cast, i campi di simulazione sono dichiarati qui
 * direttamente: stessa cosa, senza dipendere dai typing (poco
 * affidabili tra le versioni) del pacchetto esterno.
 */

export type EdgeType = 'Updates' | 'Obsoletes';

export interface RfcNode {
  id: string;
  url?: string;
  title: string;
  abstract: string;
  status: string | null;
  year: number | null;
  keywords?: string[];
  impact_score: number;
  layer_hint?: string | null;
  layer: string | null;
  working_group: string | null;
  is_draft: boolean | null;
  is_aborted: boolean | null;
  n_updates: number;
  n_obsoletes: number;
}

export interface RfcEdge {
  source: string;
  target: string;
  type: EdgeType;
}

export interface GraphMeta {
  schema_version: string;
  generated_at: string;
  generated_by: string;
}

export interface RfcGraphData {
  meta: GraphMeta;
  nodes: RfcNode[];
  edges: RfcEdge[];
}

export type DisplayLayer = 'Application' | 'Transport' | 'Network' | 'Unclassified';

export function toDisplayLayer(layer: string | null): DisplayLayer {
  if (layer === 'Application' || layer === 'Transport' || layer === 'Network') {
    return layer;
  }
  return 'Unclassified';
}

export type DocKind = 'rfc' | 'draft' | 'aborted';

export function docKind(node: Pick<RfcNode, 'is_draft' | 'is_aborted'>): DocKind {
  if (node.is_aborted) return 'aborted';
  if (node.is_draft) return 'draft';
  return 'rfc';
}

export function resolveDocUrl(node: Pick<RfcNode, 'id' | 'url' | 'is_draft'>): string | null {
  if (node.url) return node.url;
  if (node.is_draft) return `https://datatracker.ietf.org/doc/html/${node.id.toLowerCase()}`;
  return null;
}

/** Nodo così come lo vede 3d-force-graph a runtime: gli stessi campi
 *  di dominio di RfcNode più i campi di simulazione che la libreria
 *  aggiunge/muta in-place (x/y/z/vx/vy/vz). Non eredita dai tipi della
 *  libreria — vedi nota in testa al file. */
export interface GraphNode extends RfcNode {
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  [key: string]: unknown; // 3d-force-graph aggiunge altre proprietà interne (es. __threeObj)
}

export interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  type: EdgeType;
}

export interface Force3DGraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}
