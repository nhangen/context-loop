#!/bin/bash
# Smoke tests for hooks/context-loop-gate.sh entry-point behavior.
# Run with: bash tests/gate.test.sh

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$REPO/hooks/context-loop-gate.sh"

PASS=0
FAIL=0
FAILURES=()

check() {
  local name="$1"
  local got="$2"
  local want="$3"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1))
    echo "  PASS  $name"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$name -- got:[$got] want:[$want]")
    echo "  FAIL  $name -- got:[$got] want:[$want]"
  fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Sandbox HOME so the gate's mkdir / DB writes go to TMP, never the user's
# real ~/.claude during tests.
export HOME="$TMP"
mkdir -p "$HOME/.claude"

echo "test: empty input -> emits {} and exits 0"
out=$(printf '{}' | "$GATE" 2>/dev/null)
ec=$?
check "  exit 0"  "$ec"  "0"
check "  output {}"  "$out"  "{}"

echo "test: transcript_path that does not exist -> emits {}"
out=$(printf '{"transcript_path":"/nonexistent/no.jsonl","session_id":""}' | "$GATE" 2>/dev/null)
ec=$?
check "  exit 0"  "$ec"  "0"
check "  output {}"  "$out"  "{}"

echo "test: empty session id, no transcript -> emits {}"
out=$(printf '{}' | "$GATE" 2>/dev/null)
check "  output {}"  "$out"  "{}"

echo "test: stop_hook_active=true with no transcript still exits cleanly"
out=$(printf '{"stop_hook_active":true}' | "$GATE" 2>/dev/null)
ec=$?
check "  exit 0"  "$ec"  "0"
check "  output {}"  "$out"  "{}"

# --- Compact-boundary tests -------------------------------------------------
# fill is measured from the LAST assistant turn. The /compact summarization
# call ingests the entire pre-compact window, so right after a compact the
# only recorded assistant usage is that huge stale turn. We must NOT nag then.
# Small window so modest token sums cross thresholds deterministically.
export CONTEXT_LOOP_WINDOW=100000

# Large pre-compact assistant turn (fill 0.80 -> escalated), plain text so the
# mid-chain tool-use guard doesn't short-circuit for the wrong reason.
PRECOMPACT='{"type":"assistant","uuid":"a1","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"cache_read_input_tokens":80000,"cache_creation_input_tokens":0,"output_tokens":100},"content":[{"type":"text","text":"pre"}]}}'
COMPACT='{"type":"user","isCompactSummary":true,"message":{"content":[{"type":"text","text":"summary"}]}}'
POSTSMALL='{"type":"assistant","uuid":"a2","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"cache_read_input_tokens":5000,"cache_creation_input_tokens":0,"output_tokens":50},"content":[{"type":"text","text":"post"}]}}'

run_gate() {  # $1 = transcript file
  printf '{"transcript_path":"%s","session_id":"cbtest"}' "$1" | "$GATE" 2>/dev/null
}

echo "test: compact summary is the newest entry -> no nag (stale pre-compact usage ignored)"
TF="$TMP/t_compact_last.jsonl"
printf '%s\n%s\n' "$PRECOMPACT" "$COMPACT" > "$TF"
out=$(run_gate "$TF")
check "  output {}"  "$out"  "{}"

echo "test: small assistant turn AFTER compact -> no nag (fill from post-compact turn)"
TF="$TMP/t_post_small.jsonl"
printf '%s\n%s\n%s\n' "$PRECOMPACT" "$COMPACT" "$POSTSMALL" > "$TF"
out=$(run_gate "$TF")
check "  output {}"  "$out"  "{}"

echo "test: large turn with NO compact summary -> still nags (normal escalation intact)"
TF="$TMP/t_no_compact.jsonl"
printf '%s\n' "$PRECOMPACT" > "$TF"
out=$(run_gate "$TF")
nag="no"; case "$out" in *"context at"*) nag="yes";; esac
check "  nags"  "$nag"  "yes"

unset CONTEXT_LOOP_WINDOW
# ---------------------------------------------------------------------------

echo
echo "passed: $PASS  failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
