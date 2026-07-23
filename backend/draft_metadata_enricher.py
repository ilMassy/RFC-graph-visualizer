#!/usr/bin/env python3
"""
draft_metadata_enricher.py
===========================

Secondo passaggio di arricchimento, separato da rfc_pipeline.py per
tenere le due responsabilità distinte: rfc_pipeline.py costruisce il
grafo (parsing + layer/working group); questo script si occupa SOLO
di completare i campi che oggi mancano sui nodi Internet-Draft/aborted
(url, year) e di ripulire il campo abstract su tutto il dataset.

PRINCIPIO GUIDA: stessa filosofia incrementale di rfc_pipeline.py.
Non riprocessa mai un nodo già completato in un run precedente (stato
persistito su disco), fa checkpoint periodici per essere resiliente a
interruzioni, e mette in cache le risposte HTTP (incluse quelle di
errore) per non ripetere richieste già fatte. Pensato per essere
lanciato dopo ogni `rfc_pipeline.py enrich`, anche dallo stesso
scheduler periodico (vedi docs/.../aggiornamenti_e_proposte, sez. 13).

Cosa fa, nel dettaglio:
  - url:  per un draft, costruita direttamente come
          https://datatracker.ietf.org/doc/html/{id in minuscolo} —
          non richiede nemmeno una chiamata di rete, è deterministica
          dal nome del documento.
  - year: richiede una chiamata a Datatracker (endpoint documento
          singolo) per leggere il campo `time` (data dell'ultima
          revisione nota). NB: è un'approssimazione dichiarata — non
          è la data di prima sottomissione (che richiederebbe
          ricostruire la cronologia delle revisioni via /doc/docevent/,
          più costoso in richieste), ma l'anno dell'ultima attività
          nota sul documento. Sufficiente per posizionare il nodo su
          una timeline annuale; se in futuro serve la precisione della
          prima submission, è il punto da rivedere.
  - abstract: normalizza whitespace (spazi/righe multiple collassate)
          e tronca a ABSTRACT_MAX_CHARS con ellissi se più lungo,
          per contenere il payload del JSON senza perdere la sostanza
          del riassunto.

Uso:
    python draft_metadata_enricher.py \
        --input graph_data_enriched.json \
        --output graph_data_enriched.json
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("draft_metadata_enricher")

DATATRACKER_BASE = "https://datatracker.ietf.org/api/v1"
USER_AGENT = "rfc-graph-visualizer/draft-metadata-enricher (progetto universitario, RomaTre)"

STATE_FILE_DEFAULT = ".state/draft_metadata_state.json"
CACHE_DIR_DEFAULT = ".cache/datatracker_docdetail"

CHECKPOINT_EVERY = 200
REQUEST_DELAY_SECONDS = 0.5
MAX_RETRIES = 3
ABSTRACT_MAX_CHARS = 800


# ---------------------------------------------------------------------------
# Utility di I/O
# ---------------------------------------------------------------------------

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_json_atomic(path: Path, data: Any) -> None:
    """Scrive su un file temporaneo e poi rinomina: evita di lasciare
    graph_data_enriched.json a metà scritto se il processo viene
    interrotto proprio durante il salvataggio."""
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=None)
    os.replace(tmp_path, path)


def load_state(state_path: Path) -> dict:
    if state_path.exists():
        try:
            return load_json(state_path)
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("Stato non leggibile (%s), riparto da zero: %s", state_path, exc)
    return {"processed_ids": [], "last_run_iso": None}


def save_state(state_path: Path, state: dict) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    save_json_atomic(state_path, state)


# ---------------------------------------------------------------------------
# Datatracker HTTP, con cache su disco e retry (stesso principio di
# rfc_pipeline.py, riscritto qui in forma minima per non introdurre una
# dipendenza diretta tra i due script)
# ---------------------------------------------------------------------------

def _cache_path(cache_dir: Path, key: str) -> Path:
    safe_key = re.sub(r"[^A-Za-z0-9_.-]", "_", key)
    return cache_dir / f"{safe_key}.json"


def datatracker_get(path: str, cache_dir: Path) -> tuple[Optional[dict], bool]:
    """GET su Datatracker con cache su disco e retry con backoff su
    errori di rete/rate limit.

    Restituisce una coppia (body, definitive):
      - definitive=True  → risposta certa (200 o 404, letta da cache o
        appena ottenuta): ha senso persisterla e non richiederla più.
        body è il documento se 200, None se 404.
      - definitive=False → richiesta fallita per motivi transitori
        (errore di rete/HTTP diverso da 404/429, o retry esauriti)
        dopo tutti i tentativi: NON è un risultato definitivo, il
        chiamante non deve considerare l'id come "processato" e deve
        lasciarlo disponibile per un retry al prossimo run. Per questo
        motivo questo esito non viene mai scritto in cache."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = _cache_path(cache_dir, path)

    if cache_file.exists():
        cached = load_json(cache_file)
        return (cached.get("body") if cached.get("status") == 200 else None), True

    url = f"{DATATRACKER_BASE}{path}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                save_json_atomic(cache_file, {"status": 200, "body": body})
                return body, True
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                save_json_atomic(cache_file, {"status": 404, "body": None})
                return None, True
            if exc.code == 429:
                retry_after = int(exc.headers.get("Retry-After", "5"))
                log.warning("Rate limited su %s, attendo %ss", path, retry_after)
                time.sleep(retry_after)
                continue
            log.warning("HTTP %s su %s (tentativo %s/%s)", exc.code, path, attempt, MAX_RETRIES)
        except (urllib.error.URLError, TimeoutError) as exc:
            log.warning("Errore di rete su %s (tentativo %s/%s): %s", path, attempt, MAX_RETRIES, exc)
        time.sleep(2 ** attempt)  # backoff esponenziale

    log.error("Impossibile ottenere %s dopo %s tentativi: non definitivo, verrà ritentato al prossimo run", path, MAX_RETRIES)
    return None, False


# ---------------------------------------------------------------------------
# Logica di arricchimento
# ---------------------------------------------------------------------------

def build_draft_url(node_id: str) -> str:
    """L'id di un draft, in minuscolo, coincide col nome ufficiale IETF
    (es. DRAFT-LIOR-... -> draft-lior-...). Nessuna chiamata di rete
    necessaria: è deterministico dal nome stesso."""
    return f"https://datatracker.ietf.org/doc/html/{node_id.lower()}"


def resolve_year_from_datatracker(node_id: str, cache_dir: Path) -> tuple[Optional[int], bool]:
    """Interroga il dettaglio del documento su Datatracker e ne estrae
    l'anno dal campo `time` (data dell'ultima revisione nota).

    Restituisce (year, definitive):
      - year è None se il documento non è risolvibile o il campo `time`
        è assente/malformato — mai un anno inventato.
      - definitive indica se questo None (o questo year) è un esito
        certo (404, o 200 senza `time` valido — ripetere la richiesta
        darebbe lo stesso risultato, quindi niente da guadagnare a
        ritentare) oppure il sintomo di un fallimento transitorio della
        richiesta HTTP, nel qual caso il chiamante NON deve considerare
        il nodo come definitivamente privo di anno."""
    draft_name = node_id.lower()
    detail, definitive = datatracker_get(f"/doc/document/{draft_name}/", cache_dir)
    if not definitive:
        return None, False
    if not detail:
        return None, True
    time_str = detail.get("time")
    if not isinstance(time_str, str) or len(time_str) < 4:
        return None, True
    try:
        return int(time_str[:4]), True
    except ValueError:
        return None, True


def optimize_abstract(text: str, max_chars: int = ABSTRACT_MAX_CHARS) -> str:
    """Collassa whitespace/andate a capo multiple in singoli spazi, poi
    tronca a max_chars su un confine di parola, con ellissi se serve.
    Non altera il contenuto informativo oltre alla compressione dello
    spazio bianco: non è un riassunto automatico, solo pulizia +
    troncamento per contenere il payload."""
    if not text:
        return text
    normalized = re.sub(r"\s+", " ", text).strip()
    if len(normalized) <= max_chars:
        return normalized
    truncated = normalized[:max_chars].rsplit(" ", 1)[0]
    return f"{truncated}…"


def needs_enrichment(node: dict) -> bool:
    is_draft_like = bool(node.get("is_draft")) or bool(node.get("is_aborted"))
    if not is_draft_like:
        return False
    return not node.get("url") or node.get("year") is None


# ---------------------------------------------------------------------------
# Orchestrazione
# ---------------------------------------------------------------------------

def run(
    input_path: Path,
    output_path: Path,
    state_path: Path,
    cache_dir: Path,
    force: bool,
    limit: Optional[int],
) -> None:
    graph = load_json(input_path)
    nodes: list[dict] = graph["nodes"]

    state = {"processed_ids": [], "last_run_iso": None} if force else load_state(state_path)
    processed_ids = set(state["processed_ids"])

    to_process = [n for n in nodes if needs_enrichment(n) and n["id"] not in processed_ids]
    if limit is not None:
        to_process = to_process[:limit]

    log.info(
        "Nodi totali: %s | già processati: %s | da arricchire in questo run: %s",
        len(nodes), len(processed_ids), len(to_process),
    )

    enriched_count = 0
    retried_later_count = 0
    for i, node in enumerate(to_process, start=1):
        node["url"] = build_draft_url(node["id"])
        year, definitive = resolve_year_from_datatracker(node["id"], cache_dir)
        if year is not None:
            node["year"] = year
        if definitive:
            # Esito certo (anno risolto, 404, o time assente/malformato su
            # una risposta 200): non ha senso richiederlo di nuovo in futuro.
            processed_ids.add(node["id"])
        else:
            # Fallimento transitorio: NON marchiamo l'id come processato,
            # così needs_enrichment() lo riproporrà al prossimo run invece
            # di lasciarlo bloccato in "n.d." per sempre (bug corretto qui).
            retried_later_count += 1
        enriched_count += 1

        time.sleep(REQUEST_DELAY_SECONDS)

        if i % CHECKPOINT_EVERY == 0:
            log.info("Checkpoint: %s/%s nodi arricchiti in questo run", i, len(to_process))
            state["processed_ids"] = sorted(processed_ids)
            state["last_run_iso"] = now_iso()
            save_state(state_path, state)
            save_json_atomic(output_path, graph)

    # Ottimizzazione abstract: passata leggera su TUTTI i nodi (non solo
    # quelli appena arricchiti), idempotente — un abstract già
    # normalizzato non cambia se rieseguita.
    for node in nodes:
        if node.get("abstract"):
            node["abstract"] = optimize_abstract(node["abstract"])

    graph.setdefault("meta", {})["generated_by"] = (
        graph.get("meta", {}).get("generated_by", "") + " + draft_metadata_enricher.py"
    ).strip(" +")
    graph["meta"]["generated_at"] = now_iso()

    state["processed_ids"] = sorted(processed_ids)
    state["last_run_iso"] = now_iso()
    save_state(state_path, state)
    save_json_atomic(output_path, graph)

    log.info(
        "Completato: %s nodi tentati in questo run (%s risolti in modo definitivo, %s rimandati a un retry futuro per fallimento transitorio), output scritto in %s",
        enriched_count, enriched_count - retried_later_count, retried_later_count, output_path,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", type=Path, default=Path("graph_data_enriched.json"))
    parser.add_argument("--output", type=Path, default=Path("graph_data_enriched.json"))
    parser.add_argument("--state-file", type=Path, default=Path(STATE_FILE_DEFAULT))
    parser.add_argument("--cache-dir", type=Path, default=Path(CACHE_DIR_DEFAULT))
    parser.add_argument("--force", action="store_true", help="ignora lo stato salvato e riprocessa tutto")
    parser.add_argument("--limit", type=int, default=None, help="processa al massimo N nodi (utile per test rapidi)")
    args = parser.parse_args()

    if not args.input.exists():
        log.error("File di input non trovato: %s", args.input)
        sys.exit(1)

    run(args.input, args.output, args.state_file, args.cache_dir, args.force, args.limit)


if __name__ == "__main__":
    main()
