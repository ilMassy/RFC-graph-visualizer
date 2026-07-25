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
DRAFT_RECHECK_CHECKPOINT_EVERY_NODES = 50  # checkpoint ogni N nodi durante il ricontrollo draft attivi


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
    offline = getattr(args, "offline", False)

    if offline:
        # Bug corretto qui (punto 13 di aggiornamenti_e_proposte_3.md):
        # download_if_changed() trattava sempre `input` anche come
        # destinazione dell'eventuale download da --source-url, quindi
        # passare un file locale custom come sample_rfc_index.xml poteva
        # farlo sovrascrivere con l'indice reale. Con --offline si salta
        # del tutto la fonte remota: `input` viene solo letto, mai scritto.
        if not args.input.exists():
            raise FileNotFoundError(
                f"--offline richiede che {args.input} esista già: nessun download verrà tentato."
            )
        log.info(
            "--offline: parso %s così com'è, nessuna richiesta a %s e nessuna sovrascrittura del file di input.",
            args.input, args.source_url,
        )
    else:
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


def datatracker_get(path: str, bypass_cache: bool = False) -> tuple:
    """GET con cache su disco (anche per i 404, frequentissimi su RFC
    storici) e retry con backoff su errori transitori, inclusi i timeout
    'nudi' non incapsulati in URLError.

    La cache NON ha scadenza: va bene per un RFC pubblicato (contenuto
    immutabile), ma sarebbe SBAGLIATO per l'endpoint /doc/document/{id}/
    di un draft ancora attivo, il cui stato puo' cambiare da un run
    all'altro. bypass_cache=True salta la lettura della cache (ma scrive
    comunque il risultato fresco, aggiornandola) -- usato esclusivamente
    da recheck_active_drafts() per garantire una lettura sempre aggiornata
    dello stato, altrimenti dopo il primo run ogni ricontrollo successivo
    leggerebbe per sempre lo stesso risultato cachato al primo giro,
    rendendo il ricontrollo periodico inutile silenziosamente.

    Restituisce una coppia (data, definitive):
      - definitive=True: risposta certa -- 200 (da cache o appena
        ottenuta), 404, o 400 (query malformata: deterministico, un
        retry darebbe lo stesso esito). Il chiamante puo' persistere
        questo risultato, incluso un `data` a None, senza doverlo
        ritentare in futuro.
      - definitive=False: fallimento transitorio (errore di rete/timeout,
        o un codice HTTP diverso da 404/400/429) rimasto tale dopo tutti
        i retry. Il chiamante NON deve trattare l'assenza di dato come un
        fatto certo: il nodo va lasciato "da processare" per essere
        ritentato integralmente al prossimo run. Prima di questo fix,
        qualunque fallimento (anche solo un timeout momentaneo) veniva
        confuso con un 404 vero, e il nodo restava con layer/working_group
        vuoti per sempre perche' non veniva mai ripescato da to_process."""
    url = f"{DATATRACKER_BASE}{path}"
    cache_file = _cache_path_for(url)

    if cache_file.exists() and not bypass_cache:
        with cache_file.open("r", encoding="utf-8") as f:
            cached = json.load(f)
        return (None if cached == _NOT_FOUND_MARKER else cached), True

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            with cache_file.open("w", encoding="utf-8") as f:
                json.dump(data, f)
            time.sleep(REQUEST_DELAY_SECONDS)
            return data, True
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
                time.sleep(REQUEST_DELAY_SECONDS)
                return None, True
            if e.code == 400:
                body = ""
                try:
                    body = e.read().decode("utf-8", errors="replace")[:500]
                except Exception:
                    pass
                log.warning("HTTP 400 (query malformata?) per %s -- risposta: %s", url, body)
                time.sleep(REQUEST_DELAY_SECONDS)
                return None, True
            # Altri codici HTTP (5xx, 403, ...): non e' detto che ripetere
            # la richiesta dia lo stesso esito (es. un 503 momentaneo del
            # server), quindi si ritenta come per un errore di rete invece
            # di arrendersi subito al primo tentativo.
            wait = min(1.5 * (2 ** (attempt - 1)), 30)
            log.warning("HTTP %s per %s (tentativo %d/%d) -- riprovo tra %.1fs",
                        e.code, url, attempt, MAX_RETRIES, wait)
            time.sleep(wait)
        except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError) as e:
            wait = min(1.5 * (2 ** (attempt - 1)), 30)
            log.warning("Errore di rete/timeout (tentativo %d/%d) per %s: %s -- riprovo tra %.1fs",
                        attempt, MAX_RETRIES, url, e, wait)
            time.sleep(wait)

    log.error("Fallito dopo %d tentativi, non definitivo: verra' ritentato al prossimo run: %s", MAX_RETRIES, url)
    return None, False


def fetch_rfc_doc_metadata(rfc_id: str, bypass_cache: bool = False) -> tuple:
    """(doc_metadata, definitive) -- vedi datatracker_get(). bypass_cache
    va usato solo quando serve leggere lo stato AGGIORNATO di un
    documento già visto in precedenza (vedi recheck_active_drafts)."""
    return datatracker_get(f"/doc/document/{rfc_id.lower()}/", bypass_cache=bypass_cache)


def resolve_working_group(doc_metadata: Optional[dict], doc_metadata_definitive: bool) -> tuple:
    """
    Restituisce (working_group, definitive). Quattro-stato esplicito:
      - doc_metadata_definitive=False: non sappiamo nemmeno se il
        documento e' risolvibile (fetch metadata fallito in modo
        transitorio) -> (None, False): NON e' un "nessun WG" certo, va
        ritentato integralmente al prossimo run.
      - doc_metadata is None (ma in modo definitivo, es. 404): (None, True)
        -> fatto certo, il chiamante puo' omettere il campo per sempre.
      - doc_metadata esiste ma non ha 'group': Datatracker conferma che
        non c'e' WG -> (None, True), fatto certo.
      - group presente ma il fetch del gruppo fallisce in modo
        transitorio -> (None, False): da ritentare, non e' meno incerto
        di "non sapere se il documento esiste".
      - group presente e risolto -> (acronimo o None, True).
    """
    if not doc_metadata_definitive:
        return None, False
    if doc_metadata is None:
        return None, True
    group_url = doc_metadata.get("group")
    if not group_url:
        return None, True
    group_data, group_definitive = datatracker_get(group_url.replace("/api/v1", ""))
    if not group_definitive:
        return None, False
    if group_data is None:
        return None, True
    return (group_data.get("acronym") or None), True


def resolve_area_acronym(doc_metadata: Optional[dict], doc_metadata_definitive: bool) -> tuple:
    """group_url -> group_data -> parent_url (area) -> area_data.acronym.

    Restituisce (area_acronym, definitive). None a qualunque hop mancante
    in modo CERTO (404, o campo assente su una risposta 200) -> definitive
    resta True: il chiamante tratta quel None come "non risolvibile in
    modo autorevole", non come un'incertezza da ritentare. Se invece uno
    qualunque degli hop fallisce in modo transitorio, definitive=False e
    il chiamante non deve fidarsi del None come esito finale."""
    if not doc_metadata_definitive:
        return None, False
    if not doc_metadata:
        return None, True
    group_url = doc_metadata.get("group")
    if not group_url:
        return None, True
    group_data, group_definitive = datatracker_get(group_url.replace("/api/v1", ""))
    if not group_definitive:
        return None, False
    if not group_data:
        return None, True
    parent_url = group_data.get("parent")
    if not parent_url:
        return None, True
    area_data, area_definitive = datatracker_get(parent_url.replace("/api/v1", ""))
    if not area_definitive:
        return None, False
    return (area_data.get("acronym") if area_data else None), True


def resolve_layer(rfc_id: str, doc_metadata: Optional[dict], doc_metadata_definitive: bool) -> tuple:
    """(layer, source, definitive). Solo due fonti autorevoli: override
    manuale o area Datatracker. Nessun fallback su euristica testuale: un
    documento non risolvibile in modo CERTO viene escluso (None,
    'unresolved', True), mai classificato con un'ipotesi non verificata.
    Se la risoluzione fallisce in modo transitorio, definitive=False e il
    chiamante non deve considerare 'unresolved' come esito finale."""
    if rfc_id in MANUAL_LAYER_OVERRIDES:
        return MANUAL_LAYER_OVERRIDES[rfc_id], "manual_override", True
    area, area_definitive = resolve_area_acronym(doc_metadata, doc_metadata_definitive)
    if not area_definitive:
        return None, "unresolved", False
    if area and area in IETF_AREA_TO_LAYER:
        return IETF_AREA_TO_LAYER[area], "datatracker_area", True
    return None, "unresolved", True


def enrich_node(node: dict) -> tuple:
    """(node, source, definitive). Se definitive=False (fallimento
    transitorio su una delle risoluzioni Datatracker), il nodo viene
    restituito INVARIATO: il chiamante non deve scriverlo nel dataset ne'
    marcarlo come processato, altrimenti un timeout momentaneo diventa un
    layer/working_group mancante per sempre."""
    rfc_id = node["id"]
    doc_metadata, doc_metadata_definitive = fetch_rfc_doc_metadata(rfc_id)

    layer, source, layer_definitive = resolve_layer(rfc_id, doc_metadata, doc_metadata_definitive)
    working_group, wg_definitive = resolve_working_group(doc_metadata, doc_metadata_definitive)

    if not (layer_definitive and wg_definitive):
        return node, "unresolved", False

    # Risoluzione layer: se None, lasciamo il campo a None (esito certo)
    node["layer"] = layer

    # Risoluzione WG: resolve_working_group() restituisce sempre None o un
    # acronimo (mai la stringa "none"), quindi l'assegnazione è diretta.
    node["working_group"] = working_group

    # Default sempre presenti
    node.setdefault("is_draft", False)
    node.setdefault("is_aborted", False)

    return node, source, True


def resolve_document_state_slug(doc_metadata: dict) -> tuple:
    """Cerca tra obj['states'] quello di tipo 'draft' (Active/Expired/
    Dead/Replaced).

    Restituisce (slug, definitive):
      - definitive=True: slug trovato, oppure nessuno stato di tipo
        draft tra quelli elencati (fatto certo, la lista states e'
        completa in una risposta 200).
      - definitive=False: una delle chiamate di stato e' fallita in modo
        transitorio -- il chiamante non deve trattare "nessuno stato
        draft trovato" come definitivo in questo caso."""
    for state_url in doc_metadata.get("states", []):
        state_data, state_definitive = datatracker_get(state_url.replace("/api/v1", ""))
        if not state_definitive:
            return None, False
        if state_data and state_data.get("type") == "/api/v1/doc/statetype/draft/":
            return state_data.get("slug"), True
    return None, True


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
    retried_later_count = 0
    excluded_no_state_count = 0
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
        page, page_definitive = datatracker_get(path)
        if not page_definitive:
            # Fallimento transitorio sulla pagina stessa: ci fermiamo qui
            # senza consumare resume_path, cosi' il prossimo run riparte
            # da questa stessa pagina invece di saltarla.
            log.warning("Pagina draft %d non ottenuta (fallimento transitorio), mi fermo qui: verra' ritentata al prossimo run.", pages_fetched + 1)
            break
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

            # Risoluzione stato: None solo se CERTO (nessuno stato draft
            # tra quelli elencati), mai come conseguenza di un fallimento
            # transitorio -- vedi controllo *_definitive sotto.
            state_slug, state_definitive = resolve_document_state_slug(obj)
            layer, _source, layer_definitive = resolve_layer(doc_id, obj, True)
            working_group, wg_definitive = resolve_working_group(obj, True)

            if not (state_definitive and layer_definitive and wg_definitive):
                # Fallimento transitorio su almeno una risoluzione per
                # questo documento: NON lo aggiungiamo a questo run, cosi'
                # resta fuori da existing_ids e viene ritentato per intero
                # (invece di essere salvato con status/layer/WG a meta' e
                # mai piu' ripescato, dato che existing_ids e' l'unico
                # criterio usato per decidere cosa e' gia' "fatto").
                retried_later_count += 1
                continue

            if state_slug is None:
                # Caso anomalo: il documento soddisfa il filtro
                # states__type__slug=draft della query (quindi DOVREBBE
                # avere uno stato di tipo draft tra active/expired/dead/
                # repl), eppure resolve_document_state_slug() non ne trova
                # uno tra gli 'states' elencati sull'oggetto. E' un esito
                # CERTO (non un fallimento transitorio), ma non e' uno dei
                # quattro stati che il resto della pipeline sa gestire
                # (recheck_active_drafts() si aspetta 'active'/'expired'
                # per ricontrollare, 'dead'/'repl' come terminali).
                # Prima di questa correzione, un caso simile veniva comunque
                # aggiunto al dataset con is_draft/is_aborted a None: un
                # nodo fantasma che non passava il filtro di NESSUNA delle
                # due viste frontend (ne' grafo RFC ne' timeline draft) e
                # non veniva mai piu' ricontrollato o rimosso da nessun
                # meccanismo esistente, restando dead weight nel JSON per
                # sempre. Coerentemente con "zero falsi positivi": se non
                # e' risolvibile a uno stato noto, il documento semplicemente
                # non entra nel dataset in questo run. Non essendo aggiunto,
                # non finisce in existing_ids, quindi verra' ririchiesto (a
                # basso costo, vista la rarita' del caso) ai run futuri,
                # invece di essere perso o "congelato" per sempre.
                log.warning(
                    "%s: nessuno stato di tipo 'draft' risolvibile tra quelli elencati, pur "
                    "avendo soddisfatto il filtro della query -- escluso da questo run (caso "
                    "anomalo, verra' ririchiesto al prossimo run).",
                    doc_id,
                )
                excluded_no_state_count += 1
                continue

            raw_keywords = obj.get("keywords")
            keywords = raw_keywords if isinstance(raw_keywords, list) else None

            # Creazione nodo: layer/working_group possono essere None (esito
            # certo), ma is_draft/is_aborted sono ORA sempre un booleano --
            # mai None, perche' state_slug None e' stato escluso sopra.
            node = {
                "id": doc_id,
                "title": obj.get("title", ""),
                "abstract": obj.get("abstract", "") if isinstance(obj.get("abstract"), str) else "",
                "status": state_slug,
                "year": None,
                "layer": layer,
                "is_draft": state_slug in ("active", "expired"),
                "is_aborted": state_slug in ("dead", "repl"),
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

    log.info(
        "Query draft/aborted: %d pagine, %d documenti trovati, %d rimandati a un retry futuro "
        "(fallimento transitorio), %d esclusi per stato draft non risolvibile (caso anomalo)",
        pages_fetched, len(results), retried_later_count, excluded_no_state_count,
    )
    return results


def recheck_active_drafts(
    result_nodes: dict,
    resume_after_id: Optional[str] = None,
    on_progress: Optional[Callable[[str], None]] = None,
    on_transient_failure: Optional[Callable[[], None]] = None,
    skip_ids: Optional[set] = None,
) -> tuple:
    """Ricontrolla su Datatracker lo stato dei draft già presenti nel
    dataset che risultano ancora 'active'/'expired' (unici stati non
    terminali: un draft 'dead' o 'repl' non torna piu' indietro, quindi
    NON viene mai incluso qui -- e' gia' un fatto certo che non cambiera'
    piu'. Vedi fetch_drafts_and_aborted(): quella funzione, al contrario,
    ignora ogni id gia' presente in existing_ids e quindi non si accorge
    mai da sola di un draft 'active' che nel frattempo e' diventato RFC,
    dead o repl -- e' esattamente il buco che questa funzione chiude.

    skip_ids: id da NON ricontrollare in questo run perché il loro stato
    è già stato risolto pochi istanti prima, nello stesso run, da
    fetch_drafts_and_aborted() (che scrive direttamente 'is_draft' letto
    da Datatracker). Senza questo filtro, ogni draft appena scoperto in
    un run "da zero" verrebbe ricontrollato una seconda volta con
    bypass_cache=True subito dopo essere stato scritto, raddoppiando
    inutilmente le richieste proprio nella run più pesante. 
    Non riguarda i run successivi: un draft che sopravvive da un
    run all'altro non è mai in skip_ids, e viene ricontrollato come
    prima con dati sempre freschi.

    Tre esiti possibili per un draft 'active'/'expired' ricontrollato:
      - ancora active/expired: nessun cambiamento, resta candidato per il
        prossimo ricontrollo futuro.
      - diventato dead/repl: aggiorniamo il nodo sul posto
        (is_draft=False, is_aborted=True, status=nuovo slug) e da qui in
        poi non verra' piu' ricontrollato (e' terminale).
      - qualsiasi altro esito (tipicamente: pubblicato come RFC, quindi
        non ha piu' uno stato di tipo 'draft' risolvibile, oppure il
        documento non e' piu' raggiungibile via /doc/document/): il nodo
        draft viene rimosso dal dataset. Il documento risultante (l'RFC)
        arriva separatamente dal parsing di rfc-index.xml nella fase 1;
        qui ci limitiamo a non lasciare un nodo draft ormai falso.

    La lista dei draft da controllare viene ordinata per id (ordine
    deterministico tra run, a differenza dell'ordine di iterazione di un
    dict che puo' cambiare se nel frattempo sono stati aggiunti nodi).
    Se resume_after_id è valorizzato (ripresa da un run precedente
    interrotto a meta' ricontrollo), i nodi fino a quell'id incluso
    vengono saltati: un'interruzione a meta' non costringe piu' a
    ripartire dal primo nodo della lista.
    Se on_progress è fornito, viene chiamato dopo OGNI nodo con esito
    DEFINITIVO (non su un fallimento transitorio) con l'id appena
    processato, cosi' il chiamante puo' fare checkpoint periodici (nodi
    aggiornati/rimossi + id di ripresa) senza perdere il lavoro gia'
    fatto in caso di interruzione.
    Se on_transient_failure è fornito, viene chiamato ogni volta che un
    nodo fallisce in modo transitorio. Il chiamante deve usarlo per
    smettere di far avanzare resume_after_id da quel punto in poi in
    questo stesso run: senza questa cautela, un nodo fallito
    transitoriamente ma seguito (in ordine alfabetico) da nodi risolti
    con successo verrebbe "scavalcato" dal resume e MAI PIU' ritentato
    finche' un run intero non si completa senza interruzioni.

    Ritorna (n_aggiornati_ad_aborted, n_rimossi, n_rimandati_a_retry_futuro).
    Muta result_nodes in place (aggiornamenti e rimozioni)."""
    skip_ids = skip_ids or set()
    to_check = sorted(
        (n for n in result_nodes.values() if n.get("is_draft") is True and n["id"] not in skip_ids),
        key=lambda n: n["id"],
    )
    total_candidates = len(to_check)
    if resume_after_id:
        to_check = [n for n in to_check if n["id"] > resume_after_id]
        if total_candidates:
            log.info(
                "Riprendo il ricontrollo draft attivi da dopo '%s' (non riparto da zero): "
                "%d/%d nodi restanti.",
                resume_after_id, len(to_check), total_candidates,
            )
    updated_to_aborted = 0
    removed = 0
    retried_later_count = 0

    log.info("Ricontrollo draft attivi/scaduti: %d nodi da verificare...", len(to_check))

    for i, node in enumerate(to_check, start=1):
        if i % 50 == 0:
            log.info("  ... avanzamento ricontrollo: %d/%d nodi verificati", i, len(to_check))

        node_id = node["id"]
        old_status = node.get("status")
        doc_metadata, doc_metadata_definitive = fetch_rfc_doc_metadata(node["id"], bypass_cache=True)
        if not doc_metadata_definitive:
            # Fallimento transitorio: il nodo resta invariato (ancora
            # is_draft=True) e verra' ricontrollato al prossimo run --
            # NON lo trattiamo come "diventato non-draft".
            log.warning("  [%d/%d] %s: fallimento transitorio, rimandato al prossimo run", i, len(to_check), node["id"])
            retried_later_count += 1
            if on_transient_failure:
                on_transient_failure()
            continue

        if doc_metadata is None:
            # 404 definitivo su un id che prima esisteva: non piu'
            # risolvibile in modo autorevole, va tolto dal dataset invece
            # di restare un draft "fantasma".
            log.info("  [%d/%d] %s: non piu' risolvibile (404) -- RIMOSSO dal dataset (era %s)", i, len(to_check), node["id"], old_status)
            del result_nodes[node["id"]]
            removed += 1
            continue

        state_slug, state_definitive = resolve_document_state_slug(doc_metadata)
        if not state_definitive:
            log.warning("  [%d/%d] %s: fallimento transitorio nella risoluzione dello stato, rimandato al prossimo run", i, len(to_check), node["id"])
            retried_later_count += 1
            if on_transient_failure:
                on_transient_failure()
            continue

        if state_slug in ("active", "expired"):
            # Nessun cambiamento, ma il ricontrollo per QUESTO run e'
            # comunque completo per questo id: segnaliamo il progresso
            # cosi' un'interruzione successiva non lo rifa' ripartire da
            # qui. Al prossimo run "all"/"enrich" (senza --force) sara'
            # comunque ricontrollato di nuovo, dato che resta is_draft=True.
            if on_progress:
                on_progress(node_id)
            continue  # nessun cambiamento: resta draft, ricontrollato in futuro

        if state_slug in ("dead", "repl"):
            log.info("  [%d/%d] %s: %s -> %s (draft -> abortito)", i, len(to_check), node["id"], old_status, state_slug)
            node["status"] = state_slug
            node["is_draft"] = False
            node["is_aborted"] = True
            updated_to_aborted += 1
            if on_progress:
                on_progress(node_id)
            continue

        # state_slug è None (nessuno stato di tipo 'draft' trovato, tipico
        # di un documento ormai pubblicato come RFC) o un altro slug non
        # gestito: il draft non è più tale, esce dal dataset.
        log.info(
            "  [%d/%d] %s: %s -> %s -- RIMOSSO dal dataset (probabile pubblicazione come RFC)",
            i, len(to_check), node["id"], old_status, state_slug or "nessuno stato draft",
        )
        del result_nodes[node["id"]]
        removed += 1
        if on_progress:
            on_progress(node_id)

    log.info(
        "Ricontrollo draft attivi/scaduti completato: %d ricontrollati | %d passati ad abortito (dead/repl) | "
        "%d rimossi (non più draft) | %d rimandati a un retry futuro (fallimento transitorio)",
        len(to_check), updated_to_aborted, removed, retried_later_count,
    )
    return updated_to_aborted, removed, retried_later_count


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
    return {
        "enriched_ids": [], "excluded_ids": [], "last_run_iso": None,
        "last_draft_fetch_iso": None, "draft_recheck_resume_id": None,
    }


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
        state = {
            "enriched_ids": [], "excluded_ids": [], "last_run_iso": None,
            "last_draft_fetch_iso": None, "draft_recheck_resume_id": None,
        }

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
    retried_later_count = 0

    try:
        for i, node in enumerate(to_process, start=1):
            enriched, source, definitive = enrich_node(dict(node))

            if not definitive:
                # Fallimento transitorio su questo nodo (timeout/errore di
                # rete su una delle chiamate Datatracker): NON lo marchiamo
                # come processato. Resta fuori da result_nodes, quindi il
                # prossimo run lo rimette in to_process e lo ritenta per
                # intero, invece di lasciarlo per sempre con layer/WG
                # mancanti come se fosse un esito certo.
                retried_later_count += 1
                if i % CHECKPOINT_EVERY == 0:
                    checkpoint(result_nodes, all_edges, enriched_ids, excluded_ids, state,
                               args.output, args.state_file, label=f"nodo {i}/{len(to_process)}")
                continue

            stats[source] = stats.get(source, 0) + 1

            # Aggiunta SEMPRE del nodo risolto in modo definitivo (nessuna esclusione)
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

    log.info(
        "Esito layer -> override: %d | area Datatracker: %d | non risolti: %d | "
        "rimandati a un retry futuro (fallimento transitorio): %d",
        stats["manual_override"], stats["datatracker_area"], stats["unresolved"], retried_later_count,
    )

    if not args.skip_drafts:
        since = None if args.force else state.get("last_draft_fetch_iso")
        resume_path = None if args.force else state.get("draft_fetch_resume_path")
        if resume_path:
            log.info("Riprendo il fetch draft dalla pagina interrotta in precedenza (non riparto da zero).")

        pages_since_checkpoint = 0
        newly_fetched_draft_ids: set = set()

        def _on_draft_page(page_nodes: list, next_path: Optional[str]) -> None:
            nonlocal pages_since_checkpoint
            for dn in page_nodes:
                result_nodes[dn["id"]] = dn
                enriched_ids.add(dn["id"])
                newly_fetched_draft_ids.add(dn["id"])
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

        # Ricontrollo dei draft 'active'/'expired' già presenti nel dataset
        # (non solo fetch dei nuovi): un draft attivo può nel frattempo
        # essere diventato RFC, dead o repl, e senza questo passaggio
        # resterebbe per sempre marcato 'active' anche a transizione
        # avvenuta (vedi nota in fetch_drafts_and_aborted). Eseguito nello
        # stesso gate di --skip-drafts perché è concettualmente parte
        # della gestione dei draft.
        #
        # Resume: come per il fetch draft/aborted sopra, se il ricontrollo
        # era stato interrotto a metà in un run precedente riprendiamo da
        # dopo l'ultimo id ricontrollato invece di rifare da capo tutti i
        # nodi.
        recheck_resume_after_id = None if args.force else state.get("draft_recheck_resume_id")
        if recheck_resume_after_id:
            log.info("Riprendo il ricontrollo draft dalla posizione interrotta in precedenza (non riparto da zero).")

        nodes_since_recheck_checkpoint = 0
        # Una volta che un nodo fallisce in modo transitorio in questo run,
        # congeliamo l'avanzamento del resume (vedi docstring di
        # recheck_active_drafts): altrimenti, in caso di interruzione
        # successiva, quel nodo fallito resterebbe "prima" del punto di
        # ripresa salvato e non verrebbe mai piu' ritentato finche' un run
        # intero non si completa senza interruzioni.
        resume_frozen = False

        def _on_recheck_progress(processed_id: str) -> None:
            nonlocal nodes_since_recheck_checkpoint
            if not resume_frozen:
                state["draft_recheck_resume_id"] = processed_id
            nodes_since_recheck_checkpoint += 1
            if nodes_since_recheck_checkpoint >= DRAFT_RECHECK_CHECKPOINT_EVERY_NODES:
                nodes_since_recheck_checkpoint = 0
                checkpoint(result_nodes, all_edges, enriched_ids, excluded_ids, state,
                           args.output, args.state_file, label="ricontrollo draft in corso")

        def _on_recheck_transient_failure() -> None:
            nonlocal resume_frozen
            resume_frozen = True

        try:
            _, n_removed, _ = recheck_active_drafts(
                result_nodes,
                resume_after_id=recheck_resume_after_id,
                on_progress=_on_recheck_progress,
                on_transient_failure=_on_recheck_transient_failure,
                skip_ids=newly_fetched_draft_ids,
            )
        except KeyboardInterrupt:
            checkpoint(result_nodes, all_edges, enriched_ids, excluded_ids, state,
                       args.output, args.state_file, label="ricontrollo draft interrotto (Ctrl+C)")
            log.warning("Interrotto durante il ricontrollo draft: rilancia lo stesso comando per riprendere da qui.")
            raise
        except Exception:
            checkpoint(result_nodes, all_edges, enriched_ids, excluded_ids, state,
                       args.output, args.state_file, label="ricontrollo draft: crash imprevisto")
            log.exception("Errore imprevisto nel ricontrollo draft: stato salvato, rilancia per riprendere da qui.")
            raise

        # Ricontrollo completato per intero in questo run (nessuna
        # interruzione): resettiamo il resume, cosi' il prossimo run parte
        # da capo su TUTTI i draft attivi rimasti (e' un ricontrollo
        # periodico completo, non un lavoro "una tantum" da esaurire).
        state["draft_recheck_resume_id"] = None
        if n_removed:
            # Alcuni id sono usciti dal dataset: teniamo enriched_ids/
            # excluded_ids coerenti (non è critico per la logica attuale,
            # che si basa su result_nodes, ma evita id "fantasma" nello
            # stato salvato).
            enriched_ids = enriched_ids & set(result_nodes.keys())
            excluded_ids = excluded_ids & set(result_nodes.keys())
        checkpoint(result_nodes, all_edges, enriched_ids, excluded_ids, state,
                   args.output, args.state_file, label="ricontrollo draft attivi")

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
    p.add_argument(
        "input", type=Path,
        help=(
            "Percorso locale a rfc-index.xml. Salvo con --offline, è anche la destinazione "
            "dell'eventuale download da --source-url e può quindi essere sovrascritto: per "
            "parsare un file custom (es. sample_rfc_index.xml) così com'è, usare --offline."
        ),
    )
    p.add_argument("-o", "--output", type=Path, default=Path("graph_data.json"))
    p.add_argument("--source-url", default=DEFAULT_SOURCE_URL)
    p.add_argument("--state-file", type=Path, default=Path(".state/parser_state.json"))
    p.add_argument("--min-impact-for-core", type=int, default=0)
    p.add_argument("--force", action="store_true")
    p.add_argument(
        "--offline", "--no-download",
        dest="offline", action="store_true",
        help=(
            "Parsa 'input' così com'è, senza controllare o scaricare nulla dalla fonte "
            "remota (--source-url). Da usare quando 'input' è un file locale custom (es. "
            "sample_rfc_index.xml) che non deve mai essere sovrascritto da un download."
        ),
    )


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
