#!/usr/bin/env python3
"""
repair_draft_state.py
======================

Riparazione UNA TANTUM per il bug descritto in aggiornamenti_e_proposte_2.md
(punto 3): fino ad oggi draft_metadata_enricher.py marcava un draft come
"processed" anche quando la risoluzione di `year` falliva per un motivo
transitorio (errore di rete, rate limit esaurito dopo i retry) — quel
fallimento non veniva mai scritto in cache HTTP (segno che l'intenzione
era di ritentarlo), ma l'id finiva comunque in `processed_ids`, quindi
`needs_enrichment()` non lo riproponeva mai più ai run successivi.

Questo script NON tocca la logica di enrichment (quella è corretta nella
versione aggiornata di draft_metadata_enricher.py): si limita a togliere
dallo stato persistito gli id che sono stati bloccati per errore, così il
prossimo run del vero script li ritenta.

Un draft con year=None viene lasciato COSÌ COM'È (non "riparato", cioè
resta in processed_ids) se e solo se esiste in cache una risposta
DEFINITIVA per quel documento (404, o 200 senza campo `time` valido):
in quel caso "n.d." è corretto e ritentare non cambierebbe nulla.
Viene invece rimosso da processed_ids (e quindi ritentato) se non
esiste alcuna voce di cache per lui: significa che l'ultimo tentativo
è fallito prima di ottenere una risposta HTTP e non doveva essere
considerato definitivo.

Uso:
    python repair_draft_state.py \
        --graph graph_data_enriched.json \
        --state .state/draft_metadata_state.json \
        --cache-dir .cache/datatracker_docdetail \
        [--dry-run]

Dopo l'esecuzione, rilanciare semplicemente draft_metadata_enricher.py:
riprenderà solo dagli id effettivamente da ritentare.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def _cache_path(cache_dir: Path, key: str) -> Path:
    safe_key = re.sub(r"[^A-Za-z0-9_.-]", "_", key)
    return cache_dir / f"{safe_key}.json"


def has_definitive_cache_entry(node_id: str, cache_dir: Path) -> bool:
    """Vero se esiste una risposta HTTP cacheata (200 o 404) per questo
    draft — cioè un esito che draft_metadata_enricher.py considera
    'definitivo' e per cui quindi year=None è legittimo, non un bug."""
    path = f"/doc/document/{node_id.lower()}/"
    cache_file = _cache_path(cache_dir, path)
    if not cache_file.exists():
        return False
    try:
        with cache_file.open("r", encoding="utf-8") as f:
            cached = json.load(f)
    except (json.JSONDecodeError, OSError):
        # Cache corrotta/illeggibile: trattarla come non definitiva,
        # meglio ritentare che fidarsi di un file danneggiato.
        return False
    return cached.get("status") in (200, 404)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--graph", type=Path, required=True, help="graph_data_enriched.json attuale")
    parser.add_argument("--state", type=Path, required=True, help="file di stato di draft_metadata_enricher.py")
    parser.add_argument("--cache-dir", type=Path, required=True, help="cache HTTP di draft_metadata_enricher.py")
    parser.add_argument("--dry-run", action="store_true", help="mostra cosa verrebbe cambiato senza scrivere nulla")
    args = parser.parse_args()

    if not args.graph.exists():
        print(f"Grafo non trovato: {args.graph}", file=sys.stderr)
        sys.exit(1)
    if not args.state.exists():
        print(f"Stato non trovato: {args.state}", file=sys.stderr)
        sys.exit(1)
    if not args.cache_dir.exists():
        print(f"Cache dir non trovata: {args.cache_dir}", file=sys.stderr)
        sys.exit(1)

    with args.graph.open("r", encoding="utf-8") as f:
        graph = json.load(f)
    with args.state.open("r", encoding="utf-8") as f:
        state = json.load(f)

    processed_ids = set(state.get("processed_ids", []))

    # Solo i draft/aborted con year ancora null sono candidati: quelli con
    # year risolto sono per definizione a posto, non li tocchiamo.
    candidates = [
        n for n in graph["nodes"]
        if (n.get("is_draft") or n.get("is_aborted"))
        and n.get("year") is None
        and n["id"] in processed_ids
    ]

    to_unstick = [n["id"] for n in candidates if not has_definitive_cache_entry(n["id"], args.cache_dir)]
    legitimately_nd = len(candidates) - len(to_unstick)

    print(f"Candidati con year=null e già in processed_ids: {len(candidates)}")
    print(f"  - di cui con risposta cache definitiva (404 / time assente): {legitimately_nd} → restano 'n.d.', corretto")
    print(f"  - di cui SENZA alcuna risposta cache (bloccati per errore transitorio): {len(to_unstick)} → verranno rimossi da processed_ids")

    if args.dry_run:
        print("\n--dry-run: nessuna modifica scritta.")
        return

    new_processed_ids = sorted(processed_ids - set(to_unstick))
    state["processed_ids"] = new_processed_ids

    backup_path = args.state.with_suffix(args.state.suffix + ".bak")
    with backup_path.open("w", encoding="utf-8") as f:
        json.dump({"processed_ids": sorted(processed_ids), "note": "backup pre-riparazione"}, f, ensure_ascii=False, indent=2)

    with args.state.open("w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

    print(f"\nStato aggiornato: {len(to_unstick)} id rimossi da processed_ids (backup del vecchio stato in {backup_path}).")
    print("Ora puoi rilanciare draft_metadata_enricher.py: riprenderà da questi id senza ripartire da zero.")


if __name__ == "__main__":
    main()
