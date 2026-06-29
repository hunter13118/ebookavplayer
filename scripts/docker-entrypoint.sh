#!/bin/sh
set -e
DATA="${DATA_DIR:-/data}"
mkdir -p "$DATA/books" "$DATA/media" "$DATA/packs" "$DATA/uploads" "$DATA/audio"
if [ ! -f "$DATA/pipeline.json" ]; then
  cp /app/deploy/pipeline.default.json "$DATA/pipeline.json"
fi
exec uvicorn server.app:app --host 0.0.0.0 --port "${PORT:-8080}"
