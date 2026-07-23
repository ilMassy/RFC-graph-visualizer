#!/usr/bin/env bash
# update_dataset.sh
# ==================
# Aggiorna direttamente il dataset usato dal frontend, in
# infovis/public/data/graph_data_enriched.json (nessuna copia locale in
# backend/, nessuno step di "cp" finale: il file del frontend E' la
# fonte di verita', letta e scritta in-place da entrambi gli script).
#
# Step eseguiti in sequenza:
#   0. bootstrap (solo se necessario) -- vedi sotto
#   1. rfc_pipeline.py all        (fetch condizionale rfc-index.xml + enrich)
#   2. draft_metadata_enricher.py (url/year/abstract sui nodi draft/aborted)
#
# Pensato per essere lanciato ad ogni avvio del frontend (hook npm
# prestart/prebuild in infovis/package.json): tutti gli step sono
# incrementali (stato su disco + cache HTTP), quindi se non ci sono
# novita' lato IETF il costo di un run "a vuoto" e' minimo.
#
# BOOTSTRAP/RICONCILIAZIONE: lo stato di rfc_pipeline.py enrich
# (.state/enricher_state.json, non versionato) decide cosa e' "gia'
# processato" guardando SOLO la lista di id salvata li' -- non guarda se
# il nodo ha gia' i campi risolti. Se questo file manca (clone fresco,
# cache persa, ecc.) o e' disallineato rispetto al dataset (es. run
# precedente interrotto presto, che ha salvato uno stato parziale) ma il
# dataset in infovis/public/data/ e' gia' piu' completo di quanto dice lo
# stato, senza riconciliazione la pipeline rielaborerebbe da zero nodi
# gia' presenti, nodo per nodo, chiamata Datatracker per chiamata
# Datatracker. Per evitarlo: ad ogni run, uniamo enriched_ids nello stato
# con tutti gli id che il dataset gia' contiene (union, non sovrascrittura
# secca), cosi' uno stato esistente ma incompleto non fa ripartire tutto
# da capo.
# (draft_metadata_enricher.py non ha bisogno di un bootstrap analogo: la
# sua needs_enrichment() guarda direttamente se url/year mancano sul
# nodo, quindi e' gia' idempotente sui dati, indipendentemente dallo stato.)

set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DATA_DIR="/home/ilmassy/Scrivania/INFOVIS/infovis/public/data"
DATASET_FILE="graph_data_enriched.json"
DATASET_PATH="$FRONTEND_DATA_DIR/$DATASET_FILE"
ENRICH_STATE_FILE="$BACKEND_DIR/.state/enricher_state.json"
PARSE_OUTPUT="$FRONTEND_DATA_DIR/graph_data.json"

VENV_PYTHON="$BACKEND_DIR/venv/bin/python"
if [ -x "$VENV_PYTHON" ]; then
    PYTHON="$VENV_PYTHON"
else
    echo "[update_dataset] venv non trovato in $BACKEND_DIR/venv, uso python3 di sistema"
    PYTHON="python3"
fi

cd "$BACKEND_DIR"
mkdir -p "$FRONTEND_DATA_DIR"

echo ""
echo "=================================================================="
echo " [update_dataset] AVVIO aggiornamento dataset RFC (pre-build hook)"
echo " [update_dataset] $(date '+%Y-%m-%d %H:%M:%S')"
echo "=================================================================="

echo ""
echo "[update_dataset] (0/3) controllo stato locale enrich ..."
if [ -f "$DATASET_PATH" ]; then
    mkdir -p "$(dirname "$ENRICH_STATE_FILE")"
    "$PYTHON" - "$DATASET_PATH" "$ENRICH_STATE_FILE" <<'PYEOF'
import json
import sys

dataset_path, state_path = sys.argv[1], sys.argv[2]

with open(dataset_path, encoding="utf-8") as f:
    data = json.load(f)
dataset_ids = {n["id"] for n in data.get("nodes", [])}

try:
    with open(state_path, encoding="utf-8") as f:
        state = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    state = {
        "enriched_ids": [],
        "excluded_ids": [],
        "last_run_iso": None,
        "last_draft_fetch_iso": None,
    }

before = set(state.get("enriched_ids", []))
merged = before | dataset_ids
state["enriched_ids"] = sorted(merged)
state.setdefault("excluded_ids", [])
state.setdefault("last_run_iso", None)
state.setdefault("last_draft_fetch_iso", None)

added = len(merged) - len(before)
with open(state_path, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2)

if added > 0:
    print(f"[update_dataset]     riconciliati {added} nodi gia' presenti nel dataset ma non nello stato enrich (totale enriched_ids: {len(merged)}).")
else:
    print(f"[update_dataset]     stato enrich gia' allineato col dataset ({len(merged)} nodi).")
PYEOF
else
    echo "[update_dataset]     nessun dataset preesistente in $DATASET_PATH: prima run da zero."
fi
echo "[update_dataset] (0/3) completato."

echo ""
echo "[update_dataset] (1/3) rfc_pipeline.py all ..."
"$PYTHON" rfc_pipeline.py all rfc-index.xml \
    -o "$PARSE_OUTPUT" \
    --enriched-output "$DATASET_PATH" \
    --enrich-state-file "$ENRICH_STATE_FILE"
echo "[update_dataset] (1/3) completato."

echo ""
echo "[update_dataset] (2/3) draft_metadata_enricher.py ..."
"$PYTHON" draft_metadata_enricher.py --input "$DATASET_PATH" --output "$DATASET_PATH"
echo "[update_dataset] (2/3) completato."

echo ""
echo "=================================================================="
echo " [update_dataset] FINE aggiornamento dataset (3/3) -- procedo con la build"
echo " [update_dataset] dataset aggiornato direttamente in: $DATASET_PATH"
echo "=================================================================="
echo ""
