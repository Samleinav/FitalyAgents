#!/usr/bin/env bash
# start-voice-pipeline.sh
# Starts fitaly-voice pipeline for the voice-retail example.
# Requires: fitaly-voice installed (pip install -e ../../fitaly-voice)
# Requires: Redis running and REDIS_URL set

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
STORE_ID="${STORE_ID:-store-001}"
SESSION_ID="${SESSION_ID:-session-$(date +%s)}"
AOSC_CACHE="${AOSC_CACHE:-$SCRIPT_DIR/../aosc_cache.npz}"
BUS_MODE="${BUS_MODE:-redis}"
SOURCE="${SOURCE:-mic}"
AUDIO_PATH="${AUDIO_PATH:-}"

echo "[fitaly-voice] Starting pipeline"
echo "  Redis:   $REDIS_URL"
echo "  Store:   $STORE_ID"
echo "  Session: $SESSION_ID"
echo "  Cache:   $AOSC_CACHE"
echo "  Source:  $SOURCE"

EXTRA_ARGS=()
if [[ -n "$AUDIO_PATH" ]]; then
  EXTRA_ARGS+=("--path" "$AUDIO_PATH")
fi
if [[ -f "$AOSC_CACHE" ]]; then
  EXTRA_ARGS+=("--cache" "$AOSC_CACHE")
fi

REDIS_URL="$REDIS_URL" \
STORE_ID="$STORE_ID" \
python -m fitaly_voice run \
  --mode "$BUS_MODE" \
  --source "$SOURCE" \
  --session "$SESSION_ID" \
  --store "$STORE_ID" \
  --redis-url "$REDIS_URL" \
  "${EXTRA_ARGS[@]}"
