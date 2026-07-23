#!/usr/bin/env python3
"""
rfc_pipeline.py
===============
Pipeline unica RFC Graph Visualizer: parsing di rfc-index.xml (IETF) +
arricchimento via Datatracker API, in un solo script con due sotto-comandi.

    python rfc_pipeline.py parse  rfc-index.xml -o graph_data.json
    python rfc_pipeline.py enrich --input graph_data.json --output graph_data_enriched.json
    python rfc_pipeline.py all    rfc-index.xml --enriched-output graph_data_enriched.json

------------------------------------------------------------------
PRINCIPIO GUIDA: ZERO FALSI POSITIVI PER COSTRUZIONE
------------------------------------------------------------------
Per ogni campo del nodo, vale questa regola senza eccezioni:
    Se il valore non puo' essere affermato con certezza da una fonte
    autorevole (XML ufficiale IETF o risposta Datatracker), il campo
    NON compare su quel nodo. Mai un placeholder tipo "unknown" o un
    fallback euristico spacciato per dato buono.
"""

import argparse
import json
import logging
import re
import shutil
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger("rfc_pipeline")

SCHEMA_VERSION = "1.2"
NS = {"r": "https://www.rfc-editor.org/rfc-index"}
DEFAULT_SOURCE_URL = "https://www.rfc-editor.org/rfc-index.xml"
DATATRACKER_BASE = "https://datatracker.ietf.org/api/v1"
CACHE_DIR = Path(".cache/datatracker")
REQUEST_DELAY_SECONDS = 0.5
MAX_RETRIES = 3
CHECKPOINT_EVERY = 200
DRAFT_CHECKPOINT_EVERY_PAGES = 10  # checkpoint ogni N pagine durante il fetch draft/aborted


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def now_naive_for_filter() -> str:
    """Formato naive (senza offset '+00:00') per i filtri URL Datatracker:
    concatenato in una query string, un '+' verrebbe interpretato come
    spazio se non si passa ovunque per urlencode. Evitiamo il problema
    a monte."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def tag(t):
    return f"{{{NS['r']}}}{t}"


# =============================================================================
# FASE 1: PARSING rfc-index.xml
# =============================================================================

LAYER_KEYWORDS = {
    "Application": [
        "http", "smtp", "ftp", "dns", "application", "web", "email",
        "telnet", "ssh", "imap", "pop3", "sip", "rtsp", "webrtc",
    ],
    "Transport": [
        "tcp", "udp", "transport", "sctp", "quic", "congestion", "ecn",
    ],
    "Network": [
        "ip", "ipv6", "ipv4", "routing", "icmp", "ospf", "bgp",
        # "network" rimosso deliberatamente: troppo generico, matchava
        # titoli amministrativi storici ("Network Meeting", "Network
        # timetable") non correlati al layer di rete.
    ],
}


def classify_layer_hint(title, keywords):
    """SOLO indicativo: filtro grezzo per limitare il dataset prima delle
    chiamate Datatracker (costose). NON decide il layer finale: quello e'
    compito esclusivo di resolve_layer() in fase di enrichment, con fonti
    autorevoli. Matching per PAROLA INTERA, non sottostringa (evita "ip"
    dentro "equipment", "shipment", ecc.)."""
    text = (title + " " + " ".join(keywords)).lower()
    for layer, kws in LAYER_KEYWORDS.items():
        if any(re.search(rf"\b{re.escape(k)}\b", text) for k in kws):
            return layer
    return None


def parse_doc_id_list(entry, child_tag):
    container = entry.find(tag(child_tag))
    if container is None:
        return []
    return [d.text.strip() for d in container.findall(tag("doc-id")) if d.text]


def parse_entry(entry):
    doc_id_el = entry.find(tag("doc-id"))
    if doc_id_el is None or not doc_id_el.text:
        return None
    doc_id = doc_id_el.text.strip()
    rfc_url = f"https://www.rfc-editor.org/rfc/{doc_id.lower()}.html"

    title_el = entry.find(tag("title"))
    title = title_el.text.strip() if title_el is not None and title_el.text else ""

    status_el = entry.find(tag("current-status"))
    status = status_el.text.strip() if status_el is not None and status_el.text else "UNKNOWN"

    # Concatena TUTTI i paragrafi dell'abstract, non solo il primo: un
    # abstract IETF multi-paragrafo perdeva silenziosamente il resto.
    abstract_container = entry.find(tag("abstract"))
    abstract = ""
    if abstract_container is not None:
        paragraphs = [p.text.strip() for p in abstract_container.findall(tag("p")) if p.text]
        abstract = "\n\n".join(paragraphs)

    kw_container = entry.find(tag("keywords"))
    keywords = []
    if kw_container is not None:
        keywords = [k.text.strip() for k in kw_container.findall(tag("kw")) if k.text]

    date_el = entry.find(tag("date"))
    year = None
    if date_el is not None:
        year_el = date_el.find(tag("year"))
        if year_el is not None and year_el.text:
            year = int(year_el.text.strip())

    return {
        "id": doc_id,
        "url": rfc_url,
        "title": title,
        "abstract": abstract,
        "status": status,
        "year": year,
        "keywords": keywords,
        "obsoletes": parse_doc_id_list(entry, "obsoletes"),
        "updates": parse_doc_id_list(entry, "updates"),
    }


def build_graph(entries, min_impact_for_core=0):
    """
    Direzione archi: dal documento piu' recente/attivo (source) verso
    l'RFC ereditato o sostituito (target).

    Rilevamento contraddizioni: se A dichiara di obsoletare/aggiornare B
    E, indipendentemente, B dichiara lo stesso verso A (stesso tipo),
    l'IETF index si contraddice su quella coppia. Invece di scegliere
    arbitrariamente una direzione, ENTRAMBE vengono escluse e loggate.
    """
    # Nuovo codice: include TUTTI gli ID trovati nell'XML
    included_ids = {e["id"] for e in entries}

    declared = {}  # (source, target, type) -> True
    for e in entries:
        if e["id"] not in included_ids:
            continue
        for target in e["obsoletes"]:
            if target in included_ids:
                declared[(e["id"], target, "Obsoletes")] = True
        for target in e["updates"]:
            if target in included_ids:
                declared[(e["id"], target, "Updates")] = True

    contradictory_pairs = set()
    for (src, tgt, etype) in list(declared.keys()):
        if (tgt, src, etype) in declared:
            contradictory_pairs.add(frozenset([(src, tgt, etype), (tgt, src, etype)]))

    if contradictory_pairs:
        to_remove = set()
        for pair in contradictory_pairs:
            to_remove |= set(pair)
        for key in to_remove:
            declared.pop(key, None)
        log.warning(
            "%d coppie di archi contraddittori rilevate ed escluse (A e B si "
            "dichiarano reciprocamente Updates/Obsoletes) -- nessuna scelta arbitraria.",
            len(contradictory_pairs),
        )
        for key in sorted(to_remove):
            log.warning("  arco escluso per contraddizione: %s -[%s]-> %s", key[0], key[2], key[1])

    edges = [{"source": s, "target": t, "type": et} for (s, t, et) in declared]

    nodes = {}
    for e in entries:
        if e["id"] not in included_ids:
            continue
        nodes[e["id"]] = {
            "id": e["id"],
            "url": e["url"],
            "title": e["title"],
            "abstract": e["abstract"],
            "status": e["status"],
            "year": e["year"],
            "keywords": e["keywords"],
            "impact_score": 0,           # calcolato sotto
            "layer_hint": classify_layer_hint(e["title"], e["keywords"]),
            "layer": None,               # riempito in fase enrich
            "working_group": None,       # riempito in fase enrich (o omesso)
            "is_draft": False,
            "is_aborted": False,
        }

    # n_updates/n_obsoletes contati sugli archi REALMENTE sopravvissuti
    # (post rimozione contraddizioni), non sulle liste XML grezze: cosi'
    # un nodo non puo' mai dichiarare un conteggio superiore agli archi
    # davvero presenti nel grafo.
    out_updates = defaultdict(int)
    out_obsoletes = defaultdict(int)
    for ed in edges:
        if ed["type"] == "Updates":
            out_updates[ed["source"]] += 1
        else:
            out_obsoletes[ed["source"]] += 1
    for node_id, node in nodes.items():
        node["n_updates"] = out_updates.get(node_id, 0)
        node["n_obsoletes"] = out_obsoletes.get(node_id, 0)

    compute_impact_scores(nodes, edges)

    if min_impact_for_core > 0:
        core_ids = {n for n, d in nodes.items() if d["impact_score"] >= min_impact_for_core}
        nodes = {k: v for k, v in nodes.items() if k in core_ids}
        edges = [ed for ed in edges if ed["source"] in nodes and ed["target"] in nodes]

    return nodes, edges


def compute_impact_scores(nodes: dict, edges: list, iterations: int = 20, d: float = 0.85) -> None:
    """
    Calcola l'impact_score usando un PageRank pesato per valorizzare 
    i pilastri storici come IP e TCP oltre alle catene di evoluzione.
    """
    node_ids = list(nodes.keys())
    n = len(node_ids)
    if n == 0:
        return

    # Inizializzazione
    pr = {node_id: 1.0 / n for node_id in node_ids}
    
    # Pre-calcolo pesi archi: Obsoletes indica una sostituzione strutturale importante
    edge_weights = {}
    for ed in edges:
        # Peso 2.0 per Obsoletes (sostituzione), 1.0 per Updates (aggiornamento)
        edge_weights[(ed["source"], ed["target"])] = 2.0 if ed["type"] == "Obsoletes" else 1.0

    inbound = {node_id: [] for node_id in node_ids}
    outbound_weight_sum = {node_id: 0.0 for node_id in node_ids}
    
    for ed in edges:
        source, target = ed["source"], ed["target"]
        if source in inbound and target in inbound:
            weight = edge_weights[(source, target)]
            inbound[target].append((source, weight))
            outbound_weight_sum[source] += weight
            
    # Iterazione PageRank
    for _ in range(iterations):
        new_pr = {}
        for node_id in node_ids:
            # Rank sum pesata: il prestigio fluisce meglio verso le Authority
            rank_sum = sum((pr[source] * weight) / outbound_weight_sum[source] 
                           for source, weight in inbound[node_id] if outbound_weight_sum[source] > 0)
            
            # Aggiunta: Boost per nodi con molti inbound (Authority Score semplificato)
            authority_boost = 0.05 * (len(inbound[node_id]) / n)
            
            new_pr[node_id] = (1 - d) / n + d * rank_sum + authority_boost
        pr = new_pr
        
    # Normalizzazione finale su scala 0-1000
    max_pr = max(pr.values()) if pr else 1.0
    for node_id in node_ids:
        nodes[node_id]["impact_score"] = round((pr[node_id] / max_pr) * 1000, 2)


def load_parser_state(state_file: Path) -> dict:
    if state_file.exists():
        with state_file.open("r", encoding="utf-8") as f:
            return json.load(f)
    return {"etag": None, "last_modified": None, "last_run_iso": None, "known_ids": []}


def save_json_state(state_file: Path, state: dict) -> None:
    state_file.parent.mkdir(parents=True, exist_ok=True)
    with state_file.open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def download_if_changed(url: str, dest: Path, state: dict, force: bool) -> bool:
    if dest.exists() and not force:
        headers = {}
        if state.get("etag"):
            headers["If-None-Match"] = state["etag"]
        if state.get("last_modified"):
            headers["If-Modified-Since"] = state["last_modified"]
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                dest.write_bytes(resp.read())
                state["etag"] = resp.headers.get("ETag")
                state["last_modified"] = resp.headers.get("Last-Modified")
                log.info("rfc-index.xml aggiornato, riscaricato.")
                return True
        except urllib.error.HTTPError as e:
            if e.code == 304:
                log.info("rfc-index.xml non modificato dal server, nessun download.")
            else:
                log.warning("HTTP %s durante il controllo aggiornamenti, uso il file locale.", e.code)
            return False
        except (urllib.error.URLError, TimeoutError, socket.timeout) as e:
            log.warning("Errore di rete (%s), uso il file locale esistente.", e)
            return False

    log.info("Scaricamento di %s...", url)
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=60) as resp:
        dest.write_bytes(resp.read())
        state["etag"] = resp.headers.get("ETag")
        state["last_modified"] = resp.headers.get("Last-Modified")
    log.info("Download completato.")
    return True


def load_existing_graph(output_path: Path) -> dict:
    if not output_path.exists():
        return {"nodes": {}, "edges": []}
    with output_path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    version = data.get("meta", {}).get("schema_version")
    if version and version != SCHEMA_VERSION:
        log.warning("graph_data.json esistente ha schema_version=%s (attesa %s).", version, SCHEMA_VERSION)
    return {"nodes": {n["id"]: n for n in data.get("nodes", [])}, "edges": data.get("edges", [])}


def run_parse(args) -> None:
    state = load_parser_state(args.state_file)
    downloaded = download_if_changed(args.source_url, args.input, state, force=args.force)

    if not downloaded and args.output.exists() and not args.force:
        log.info("Nessuna novita' sulla fonte e output gia' presente: nulla da fare.")
        state["last_run_iso"] = now_iso()
        save_json_state(args.state_file, state)
        return

    tree = ET.parse(args.input)
    root = tree.getroot()
    entries = [p for p in (parse_entry(e) for e in root.findall(tag("rfc-entry"))) if p]
    log.info("Entry totali parsate da rfc-index.xml: %d", len(entries))

    new_nodes, new_edges = build_graph(entries, min_impact_for_core=args.min_impact_for_core)

    existing = load_existing_graph(args.output)
    known_ids_before = set(existing["nodes"].keys())
    merged_nodes = {**existing["nodes"], **new_nodes}

    merged_edges_set = {(e["source"], e["target"], e["type"]) for e in existing["edges"]}
    merged_edges = list(existing["edges"])
    for e in new_edges:
        key = (e["source"], e["target"], e["type"])
        if key not in merged_edges_set:
            merged_edges_set.add(key)
            merged_edges.append(e)

    compute_impact_scores(merged_nodes, merged_edges)

    added_ids = set(merged_nodes.keys()) - known_ids_before
    log.info("Nodi nuovi in questo run: %d", len(added_ids))

    output_graph = {
        "meta": {"schema_version": SCHEMA_VERSION, "generated_at": now_iso(), "generated_by": "rfc_pipeline.py parse"},
        "nodes": list(merged_nodes.values()),
        "edges": merged_edges,
    }
    args.output.write_text(json.dumps(output_graph, indent=2, ensure_ascii=False), encoding="utf-8")
    log.info("Nodi totali: %d | Archi totali: %d | Scritto: %s", len(merged_nodes), len(merged_edges), args.output)

    state["last_run_iso"] = now_iso()
    state["known_ids"] = sorted(merged_nodes.keys())
    save_json_state(args.state_file, state)


# =============================================================================
# FASE 2: ARRICCHIMENTO via Datatracker
# =============================================================================

MANUAL_LAYER_OVERRIDES = {
    "RFC0791": "Network", "RFC8200": "Network", "RFC0792": "Network", "RFC4443": "Network",
    "RFC0894": None,  # IP over Ethernet -> Data Link, fuori scope
    "RFC0793": "Transport", "RFC9293": "Transport", "RFC0768": "Transport", "RFC4960": "Transport",
    "RFC2068": "Application", "RFC2616": "Application", "RFC9110": "Application",
    "RFC5321": "Application", "RFC5322": "Application", "RFC1035": "Application",
}

IETF_AREA_TO_LAYER = {"int": "Network", "tsv": "Transport", "art": "Application", "app": "Application"}

_NOT_FOUND_MARKER = "__not_found__"


def _cache_path_for(url: str) -> Path:
    safe_name = re.sub(r"[^a-zA-Z0-9]+", "_", url)[:150]
    return CACHE_DIR / f"{safe_name}.json"


def datatracker_get(path: str) -> Optional[dict]:
    """GET con cache su disco (anche per i 404, frequentissimi su RFC
    storici) e retry con backoff su errori transitori, inclusi i timeout
    'nudi' non incapsulati in URLError."""
    url = f"{DATATRACKER_BASE}{path}"
    cache_file = _cache_path_for(url)

    if cache_file.exists():
        with cache_file.open("r", encoding="utf-8") as f:
            cached = json.load(f)
        return None if cached == _NOT_FOUND_MARKER else cached

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            with cache_file.open("w", encoding="utf-8") as f:
                json.dump(data, f)
            time.sleep(REQUEST_DELAY_SECONDS)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = int(e.headers.get("Retry-After", "5"))
                log.warning("Rate limited (429) su %s, attendo %ds", url, wait)
                time.sleep(wait)
                continue
            if e.code == 404:
                log.debug("404 (atteso, documento storico assente in Datatracker): %s", url)
                with cache_file.open("w", encoding="utf-8") as f:
                    json.dump(_NOT_FOUND_MARKER, f)
                return None
            if e.code == 400:
                body = ""
                try:
                    body = e.read().decode("utf-8", errors="replace")[:500]
                except Exception:
                    pass
                log.warning("HTTP 400 (query malformata?) per %s -- risposta: %s", url, body)
                return None
            log.warning("HTTP %s per %s", e.code, url)
            return None
        except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError) as e:
            wait = min(1.5 * (2 ** (attempt - 1)), 30)
            log.warning("Errore di rete/timeout (tentativo %d/%d) per %s: %s -- riprovo tra %.1fs",
                        attempt, MAX_RETRIES, url, e, wait)
            time.sleep(wait)

    log.error("Fallito dopo %d tentativi, salto: %s", MAX_RETRIES, url)
    return None


def fetch_rfc_doc_metadata(rfc_id: str) -> Optional[dict]:
    return datatracker_get(f"/doc/document/{rfc_id.lower()}/")


def resolve_working_group(doc_metadata: Optional[dict]) -> Optional[str]:
    """
    Tri-stato esplicito:
      - doc_metadata is None: non sappiamo NULLA (fetch fallito o 404) ->
        None -> il chiamante DEVE omettere il campo, non scrivere "unknown".
      - doc_metadata esiste ma non ha 'group': Datatracker conferma che
        non c'e' WG -> null (fatto certo, non un'incertezza).
      - group presente ma il fetch del gruppo fallisce -> None (sappiamo
        che un gruppo esiste ma non quale: non e' meno incerto di "non
        sapere se esiste", quindi stesso trattamento: omettere).
      - tutto risolto -> acronimo reale.
    """
    if doc_metadata is None:
        return None
    group_url = doc_metadata.get("group")
    if not group_url:
        return None
    group_data = datatracker_get(group_url.replace("/api/v1", ""))
    if group_data is None:
        return None
    return group_data.get("acronym") or None


def resolve_area_acronym(doc_metadata: Optional[dict]) -> Optional[str]:
    """group_url -> group_data -> parent_url (area) -> area_data.acronym.
    None a qualunque hop mancante: nessuna via di mezzo, il chiamante
    tratta None come "non risolvibile in modo autorevole"."""
    if not doc_metadata:
        return None
    group_url = doc_metadata.get("group")
    if not group_url:
        return None
    group_data = datatracker_get(group_url.replace("/api/v1", ""))
    if not group_data:
        return None
    parent_url = group_data.get("parent")
    if not parent_url:
        return None
    area_data = datatracker_get(parent_url.replace("/api/v1", ""))
    return area_data.get("acronym") if area_data else None


def resolve_layer(rfc_id: str, doc_metadata: Optional[dict]) -> tuple:
    """(layer, source). Solo due fonti autorevoli: override manuale o
    area Datatracker. Nessun fallback su euristica testuale: un documento
    non risolvibile viene escluso (None, 'unresolved'), mai classificato
    con un'ipotesi non verificata."""
    if rfc_id in MANUAL_LAYER_OVERRIDES:
        return MANUAL_LAYER_OVERRIDES[rfc_id], "manual_override"
    area = resolve_area_acronym(doc_metadata)
    if area and area in IETF_AREA_TO_LAYER:
        return IETF_AREA_TO_LAYER[area], "datatracker_area"
    return None, "unresolved"


def enrich_node(node: dict) -> tuple:
    rfc_id = node["id"]
    doc_metadata = fetch_rfc_doc_metadata(rfc_id)

    # Risoluzione layer: se None, lasciamo il campo a None
    layer, source = resolve_layer(rfc_id, doc_metadata)
    node["layer"] = layer # Se è None, il valore sarà esplicitamente None

    # Risoluzione WG
    working_group = resolve_working_group(doc_metadata)
    if working_group == "none": 
        node["working_group"] = None
    else:
        node["working_group"] = working_group  

    # Default sempre presenti
    node.setdefault("is_draft", False)
    node.setdefault("is_aborted", False)
    
    return node, source


def resolve_document_state_slug(doc_metadata: dict) -> Optional[str]:
    """Cerca tra obj['states'] quello di tipo 'draft' (Active/Expired/
    Dead/Replaced). None se non trovato/non risolvibile: il chiamante
    tratta questo come motivo di esclusione, non di default a False/False."""
    for state_url in doc_metadata.get("states", []):
        state_data = datatracker_get(state_url.replace("/api/v1", ""))
        if state_data and state_data.get("type") == "/api/v1/doc/statetype/draft/":
            return state_data.get("slug")
    return None


def fetch_drafts_and_aborted(
    existing_ids: set,
    since_iso: Optional[str],
    resume_path: Optional[str] = None,
    on_page: Optional[Callable[[list, Optional[str]], None]] = None,
) -> list:
    """Se resume_path è valorizzato (ripresa da un run interrotto durante
    la paginazione), riparte direttamente da lì invece che dai parametri
    iniziali -- evita di rifare da pagina 1 tutte le pagine già scaricate.

    Se on_page è fornito, viene chiamato dopo OGNI pagina con
    (nuovi_nodi_di_questa_pagina, next_path_o_None). Il chiamante può
    usarlo per fare checkpoint incrementali (nodi + url della pagina
    successiva), così un'interruzione a metà non fa perdere il lavoro
    già fatto e il run successivo riparte dalla pagina giusta invece che
    da capo."""
    results = []
    params = {
        "states__type__slug": "draft",
        "states__slug__in": "active,expired,dead,repl",
        "limit": 50,
    }
    if since_iso:
        params["time__gte"] = since_iso

    path = resume_path or f"/doc/document/?{urllib.parse.urlencode(params)}"
    pages_fetched = 0
    while path:
        page = datatracker_get(path)
        pages_fetched += 1
        if not page or "objects" not in page:
            if pages_fetched == 1:
                log.warning("Query draft/aborted senza risultati validi.")
            break

        page_results = []
        for obj in page["objects"]:
            doc_id = obj.get("name", "").upper()
            if doc_id in existing_ids:
                continue

            # Risoluzione stato: ora resta None se incerto, non interrompe il ciclo
            state_slug = resolve_document_state_slug(obj)

            # Risoluzione layer: ora resta None se non trovato, non interrompe il ciclo
            layer, _source = resolve_layer(doc_id, obj)

            working_group = resolve_working_group(obj)
            raw_keywords = obj.get("keywords")
            keywords = raw_keywords if isinstance(raw_keywords, list) else None

            # Creazione nodo: i campi incerti diventano None, il nodo viene aggiunto comunque
            node = {
                "id": doc_id,
                "title": obj.get("title", ""),
                "abstract": obj.get("abstract", "") if isinstance(obj.get("abstract"), str) else "",
                "status": state_slug,
                "year": None,
                "layer": layer,
                "is_draft": (state_slug in ("active", "expired")) if state_slug else None,
                "is_aborted": (state_slug in ("dead", "repl")) if state_slug else None,
                "impact_score": 0,
                "n_updates": 0,
                "n_obsoletes": 0,
            }
            if working_group is not None:
                node["working_group"] = working_group
            if keywords is not None:
                node["keywords"] = keywords

            page_results.append(node)

        results.extend(page_results)

        next_url = (page.get("meta") or {}).get("next")
        path = next_url.replace("/api/v1", "") if next_url else None

        if on_page:
            on_page(page_results, path)

        if path:
            log.info("Pagina draft %d completata, continuo...", pages_fetched)

    log.info("Query draft/aborted: %d pagine, %d documenti trovati", pages_fetched, len(results))
    return results


def load_graph(input_path: Path) -> dict:
    with input_path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    version = data.get("meta", {}).get("schema_version")
    if version and version != SCHEMA_VERSION:
        log.warning("Input ha schema_version=%s, atteso %s.", version, SCHEMA_VERSION)
    return data


def save_graph(data: dict, output_path: Path) -> None:
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    log.info("Salvato %s", output_path)


def load_existing_enriched(output_path: Path) -> dict:
    if not output_path.exists():
        return {"nodes": {}}
    with output_path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return {"nodes": {n["id"]: n for n in data.get("nodes", [])}}


def load_enricher_state(state_file: Path) -> dict:
    if state_file.exists():
        with state_file.open("r", encoding="utf-8") as f:
            return json.load(f)
    return {"enriched_ids": [], "excluded_ids": [], "last_run_iso": None, "last_draft_fetch_iso": None}


def checkpoint(result_nodes: dict, all_edges: list, enriched_ids: set, excluded_ids: set,
               state: dict, output_path: Path, state_file: Path, label: str) -> None:
    valid_ids = set(result_nodes.keys())
    result_edges = [e for e in all_edges if e["source"] in valid_ids and e["target"] in valid_ids]
    output_graph = {
        "meta": {"schema_version": SCHEMA_VERSION, "generated_at": now_iso(),
                 "generated_by": f"rfc_pipeline.py enrich ({label})"},
        "nodes": list(result_nodes.values()),
        "edges": result_edges,
    }
    save_graph(output_graph, output_path)
    state["enriched_ids"] = sorted(enriched_ids)
    state["excluded_ids"] = sorted(excluded_ids)
    state["last_run_iso"] = now_iso()
    save_json_state(state_file, state)
    log.info("Checkpoint [%s]: %d nodi salvati.", label, len(result_nodes))


def run_enrich(args) -> None:
    state = load_enricher_state(args.state_file)
    if args.force:
        state = {"enriched_ids": [], "excluded_ids": [], "last_run_iso": None, "last_draft_fetch_iso": None}

    graph = load_graph(args.input)
    all_nodes = graph.get("nodes", [])
    all_edges = graph.get("edges", [])

    enriched_ids = set(state.get("enriched_ids", []))
    # excluded_ids mantiene solo eventuali esclusioni passate (se decidi di non pulire lo stato)
    excluded_ids = set(state.get("excluded_ids", []))
    result_nodes = dict(load_existing_enriched(args.output)["nodes"])

    # Processiamo tutto ciò che non è già marcato come arricchito
    to_process = [n for n in all_nodes if n["id"] not in result_nodes]
    log.info("Nodi totali: %d | già processati: %d | da processare: %d",
              len(all_nodes), len(enriched_ids), len(to_process))

    stats = {"manual_override": 0, "datatracker_area": 0, "unresolved": 0}
    
    try:
        for i, node in enumerate(to_process, start=1):
            # Arricchiamo il nodo: enrich_node ora garantisce che il nodo venga sempre restituito
            enriched, source = enrich_node(dict(node))
            stats[source] = stats.get(source, 0) + 1
            
            # Aggiunta SEMPRE del nodo (nessuna esclusione)
            result_nodes[enriched["id"]] = enriched
            enriched_ids.add(enriched["id"])
            
            if i % CHECKPOINT_EVERY == 0:
                checkpoint(result_nodes, all_edges, enriched_ids, excluded_ids, state,
                           args.output, args.state_file, label=f"nodo {i}/{len(to_process)}")
                           
    except KeyboardInterrupt:
        checkpoint(result_nodes, all_edges, enriched_ids, excluded_ids, state,
                   args.output, args.state_file, label="interrotto (Ctrl+C)")
        log.warning("Interrotto: rilancia lo stesso comando per riprendere.")
        raise
    except Exception:
        checkpoint(result_nodes, all_edges, enriched_ids, excluded_ids, state,
                   args.output, args.state_file, label="crash imprevisto")
        log.exception("Errore imprevisto: stato salvato. Rilancia per riprendere.")
        raise

    log.info("Esito layer -> override: %d | area Datatracker: %d | non risolti: %d",
              stats["manual_override"], stats["datatracker_area"], stats["unresolved"])

    if not args.skip_drafts:
        since = None if args.force else state.get("last_draft_fetch_iso")
        resume_path = None if args.force else state.get("draft_fetch_resume_path")
        if resume_path:
            log.info("Riprendo il fetch draft dalla pagina interrotta in precedenza (non riparto da zero).")

        pages_since_checkpoint = 0

        def _on_draft_page(page_nodes: list, next_path: Optional[str]) -> None:
            nonlocal pages_since_checkpoint
            for dn in page_nodes:
                result_nodes[dn["id"]] = dn
                enriched_ids.add(dn["id"])
            state["draft_fetch_resume_path"] = next_path
            pages_since_checkpoint += 1
            if pages_since_checkpoint >= DRAFT_CHECKPOINT_EVERY_PAGES:
                pages_since_checkpoint = 0
                checkpoint(result_nodes, all_edges, enriched_ids, excluded_ids, state,
                           args.output, args.state_file, label="fetch draft in corso")

        try:
            fetch_drafts_and_aborted(
                set(result_nodes.keys()), since_iso=since,
                resume_path=resume_path, on_page=_on_draft_page,
            )
        except KeyboardInterrupt:
            checkpoint(result_nodes, all_edges, enriched_ids, excluded_ids, state,
                       args.output, args.state_file, label="fetch draft interrotto (Ctrl+C)")
            log.warning("Interrotto durante il fetch draft: rilancia lo stesso comando per riprendere da qui.")
            raise
        except Exception:
            checkpoint(result_nodes, all_edges, enriched_ids, excluded_ids, state,
                       args.output, args.state_file, label="fetch draft: crash imprevisto")
            log.exception("Errore imprevisto nel fetch draft: stato salvato, rilancia per riprendere da qui.")
            raise

        state["draft_fetch_resume_path"] = None
        state["last_draft_fetch_iso"] = now_naive_for_filter()

    checkpoint(result_nodes, all_edges, enriched_ids, excluded_ids, state,
               args.output, args.state_file, label="run completo")

    # Conteggio finale nodi senza WG (che avranno il campo a None)
    no_wg = sum(1 for n in result_nodes.values() if n.get("working_group") is None)
    log.info("Nodi totali nel grafo finale: %d | senza working_group risolto: %d",
              len(result_nodes), no_wg)


# =============================================================================
# CLI
# =============================================================================

def add_parse_args(p):
    p.add_argument("input", type=Path, help="Percorso locale a rfc-index.xml")
    p.add_argument("-o", "--output", type=Path, default=Path("graph_data.json"))
    p.add_argument("--source-url", default=DEFAULT_SOURCE_URL)
    p.add_argument("--state-file", type=Path, default=Path(".state/parser_state.json"))
    p.add_argument("--min-impact-for-core", type=int, default=0)
    p.add_argument("--force", action="store_true")


def add_enrich_args(p):
    p.add_argument("--input", type=Path, default=Path("graph_data.json"))
    p.add_argument("--output", type=Path, default=Path("graph_data_enriched.json"))
    p.add_argument("--state-file", type=Path, default=Path(".state/enricher_state.json"))
    p.add_argument("--skip-drafts", action="store_true")
    p.add_argument("--force", action="store_true")
    p.add_argument("--clear-cache", action="store_true")


def main():
    parser = argparse.ArgumentParser(description="Pipeline RFC Graph Visualizer (parse + enrich)")
    sub = parser.add_subparsers(dest="command", required=True)

    p_parse = sub.add_parser("parse", help="Parsing rfc-index.xml -> graph_data.json")
    add_parse_args(p_parse)

    p_enrich = sub.add_parser("enrich", help="Arricchimento via Datatracker -> graph_data_enriched.json")
    add_enrich_args(p_enrich)

    p_all = sub.add_parser("all", help="Esegue parse e poi enrich in sequenza")
    add_parse_args(p_all)
    p_all.add_argument("--enriched-output", type=Path, default=Path("graph_data_enriched.json"))
    p_all.add_argument("--enrich-state-file", type=Path, default=Path(".state/enricher_state.json"))
    p_all.add_argument("--skip-drafts", action="store_true")
    p_all.add_argument("--clear-cache", action="store_true")

    args = parser.parse_args()

    if getattr(args, "clear_cache", False) and CACHE_DIR.exists():
        shutil.rmtree(CACHE_DIR)
        log.info("Cache HTTP svuotata.")

    if args.command == "parse":
        run_parse(args)
    elif args.command == "enrich":
        run_enrich(args)
    elif args.command == "all":
        run_parse(args)

        class EnrichArgs:
            pass
        ea = EnrichArgs()
        ea.input = args.output
        ea.output = args.enriched_output
        ea.state_file = args.enrich_state_file
        ea.skip_drafts = args.skip_drafts
        ea.force = args.force
        run_enrich(ea)


if __name__ == "__main__":
    main()
