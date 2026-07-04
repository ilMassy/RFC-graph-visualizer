# Comandi per testare la pipeline di backend

Riferimento rapido per testare `backend/rfc_pipeline.py` senza dover ricordare a memoria le opzioni. Da eseguire dentro `backend/`, con il virtualenv attivo:

```bash
cd ~/Scrivania/INFOVIS/backend
source venv/bin/activate
```

---

## 1. Test veloce su dati campione (`sample_rfc_index.xml`)

Usa il file XML di esempio invece di quello reale (44.000+ entry) per iterare rapidamente senza aspettare il download/parsing completo:

```bash
python rfc_pipeline.py parse sample_rfc_index.xml -o output/graph_data_test.json --state-file .state/parser_state_test.json
```

Controlla l'output:

```bash
python -c "
import json
data = json.load(open('output/graph_data_test.json'))
print('Nodi:', len(data['nodes']))
print('Archi:', len(data['edges']))
print(json.dumps(data['nodes'][0], indent=2))
"
```

## 2. Fase `parse` — indice reale completo

Scarica (se necessario) `rfc-index.xml` e produce `graph_data.json`:

```bash
python rfc_pipeline.py parse rfc-index.xml -o output/graph_data.json
```

Verifica che il download condizionale funzioni — rilancia lo stesso comando una seconda volta: deve loggare "non modificato dal server, nessun download" invece di riscaricare tutto:

```bash
python rfc_pipeline.py parse rfc-index.xml -o output/graph_data.json
```

Forza un nuovo parsing completo ignorando lo stato salvato (utile dopo aver modificato `rfc_pipeline.py`):

```bash
python rfc_pipeline.py parse rfc-index.xml -o output/graph_data.json --force
```

## 3. Fase `enrich` — arricchimento via Datatracker

⚠️ Interroga l'API pubblica di Datatracker: con il dataset reale (~10.000 RFC) ci vuole tempo per via del rate limiting (0.5s per richiesta). Per un primo test, usa `--skip-drafts` per saltare il fetch dei 34.000+ Internet-Draft e limitarti solo agli RFC pubblicati:

```bash
python rfc_pipeline.py enrich --input output/graph_data.json --output output/graph_data_enriched.json --skip-drafts
```

Test dell'interruzione/ripresa — lancia il comando e interrompi con `Ctrl+C` dopo qualche secondo, poi rilancia lo stesso comando: deve riprendere da dove si era fermato invece di ripartire da zero (verificalo controllando che il log iniziale riporti "già processati: N" con N > 0):

```bash
python rfc_pipeline.py enrich --input output/graph_data.json --output output/graph_data_enriched.json
```

Test con anche i draft (run completo, quello che produce il dataset finale):

```bash
python rfc_pipeline.py enrich --input output/graph_data.json --output output/graph_data_enriched.json
```

Svuota la cache HTTP locale (utile se si sospetta una risposta 404 "fantasma" rimasta in cache da un errore temporaneo):

```bash
python rfc_pipeline.py enrich --input output/graph_data.json --output output/graph_data_enriched.json --clear-cache
```

Riparti da zero ignorando `enriched_ids` (ri-arricchisce tutto, anche ciò che era già stato processato):

```bash
python rfc_pipeline.py enrich --input output/graph_data.json --output output/graph_data_enriched.json --force
```

## 4. Comando `all` — pipeline completa in un solo passaggio

```bash
python rfc_pipeline.py all rfc-index.xml --enriched-output output/graph_data_enriched.json
```

## 5. Verifiche sull'output finale

Conteggio nodi/archi e controllo che lo schema sia quello atteso:

```bash
python -c "
import json
data = json.load(open('output/graph_data_enriched.json'))
print('Schema version:', data['meta']['schema_version'])
print('Generato il:', data['meta']['generated_at'])
print('Nodi totali:', len(data['nodes']))
print('Archi totali:', len(data['edges']))

draft = sum(1 for n in data['nodes'] if n.get('is_draft'))
aborted = sum(1 for n in data['nodes'] if n.get('is_aborted'))
print('Draft attivi/scaduti:', draft)
print('Draft morti/sostituiti:', aborted)
print('RFC pubblicati:', len(data['nodes']) - draft - aborted)
"
```

Controllo dei nodi con layer non risolto (deve essere una minoranza sugli RFC pubblicati, quasi tutti sui draft):

```bash
python -c "
import json
data = json.load(open('output/graph_data_enriched.json'))
no_layer_rfc = sum(1 for n in data['nodes'] if n.get('layer') is None and not n.get('is_draft') and not n.get('is_aborted'))
no_layer_draft = sum(1 for n in data['nodes'] if n.get('layer') is None and (n.get('is_draft') or n.get('is_aborted')))
print('RFC senza layer risolto:', no_layer_rfc)
print('Draft senza layer risolto:', no_layer_draft)
"
```

Controllo che non ci siano archi pendenti (source/target non presenti nei nodi):

```bash
python -c "
import json
data = json.load(open('output/graph_data_enriched.json'))
ids = {n['id'] for n in data['nodes']}
pendenti = [e for e in data['edges'] if e['source'] not in ids or e['target'] not in ids]
print('Archi pendenti trovati:', len(pendenti))
"
```

## 6. Pulizia tra un test e l'altro

Rimuove stato e cache per ripartire completamente da zero (usare con cautela: la prossima `enrich` rifà tutte le chiamate a Datatracker):

```bash
rm -rf .state .cache
```

Rimuove solo gli output di test generati al punto 1, senza toccare lo stato del dataset reale:

```bash
rm -f output/graph_data_test.json .state/parser_state_test.json
```
