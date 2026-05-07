#!/bin/bash
# context-loop Stop hook gate.
# Reads transcript_path from stdin, hands off to bun worker which decides
# whether to inject an additionalContext payload nudging the agent to
# checkpoint+compact.

set -euo pipefail

INPUT=$(cat)

JSONL_FILE=$(echo "$INPUT" | /usr/bin/jq -r '.transcript_path // empty' 2>/dev/null)
SESSION_ID=$(echo "$INPUT" | /usr/bin/jq -r '.session_id // empty' 2>/dev/null)

if [ -z "$JSONL_FILE" ] || [ ! -f "$JSONL_FILE" ]; then
  if [ -n "$SESSION_ID" ]; then
    for dir in "$HOME/.claude/projects"/*/; do
      candidate="${dir}${SESSION_ID}.jsonl"
      if [ -f "$candidate" ]; then
        JSONL_FILE="$candidate"
        break
      fi
    done
  fi
fi

if [ -z "$JSONL_FILE" ] || [ ! -f "$JSONL_FILE" ]; then
  echo '{}'
  exit 0
fi

BUN="${BUN_PATH:-$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")}"
if [ ! -x "$BUN" ]; then
  echo '{}'
  exit 0
fi

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="${CONTEXT_LOOP_STATE_DIR:-$HOME/.claude/plugins/cache/nhangen-tools/context-loop/0.1.0/state}"
ADVISORY_AT="${CONTEXT_LOOP_ADVISORY_AT:-0.35}"
BLOCK_AT="${CONTEXT_LOOP_BLOCK_AT:-0.50}"
COOLDOWN_TURNS="${CONTEXT_LOOP_COOLDOWN_TURNS:-15}"

mkdir -p "$STATE_DIR" 2>/dev/null || true

"$BUN" "$HOOK_DIR/context-loop-worker.ts" \
  "$JSONL_FILE" "$STATE_DIR" "$SESSION_ID" \
  "$ADVISORY_AT" "$BLOCK_AT" "$COOLDOWN_TURNS" 2>/dev/null || echo '{}'
