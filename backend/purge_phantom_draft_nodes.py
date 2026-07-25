#!/usr/bin/env python3
"""
purge_phantom_draft_nodes.py
=============================
Rimuove da un graph_data_enriched.json già
scritto gli eventuali nodi con is_draft e is_aborted entrambi None --
i "nodi fantasma" prodotti da versioni di rfc_pipeline.py precedenti
alla correzione di fetch_drafts_and_aborted(). Rimuove anche gli archi che li coinvolgono come source/target
(anche se, per costruzione, questi nodi non ne hanno mai avuti).

Uso:
    python purge_phantom_draft_nodes.py --input graph_data_enriched.json --output graph_data_enriched.json
    python purge_phantom_draft_nodes.py --input graph_data_enriched.json --dry-run
"""
import argparse
import json
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--output", type=Path, default=None, help="default: sovrascrive --input")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    with args.input.open("r", encoding="utf-8") as f:
        graph = json.load(f)

    nodes = graph.get("nodes", [])
    phantom_ids = {n["id"] for n in nodes if n.get("is_draft") is None and n.get("is_aborted") is None}

    if not phantom_ids:
        print("Nessun nodo fantasma trovato: nulla da fare.")
        return

    print(f"Trovati {len(phantom_ids)} nodi fantasma (is_draft/is_aborted entrambi null):")
    for pid in sorted(phantom_ids):
        print(f"  - {pid}")

    if args.dry_run:
        print("--dry-run: nessuna modifica scritta.")
        return

    graph["nodes"] = [n for n in nodes if n["id"] not in phantom_ids]
    graph["edges"] = [e for e in graph.get("edges", []) if e["source"] not in phantom_ids and e["target"] not in phantom_ids]

    output = args.output or args.input
    with output.open("w", encoding="utf-8") as f:
        json.dump(graph, f, indent=2, ensure_ascii=False)
    print(f"Rimossi {len(phantom_ids)} nodi. Scritto: {output}")


if __name__ == "__main__":
    main()
