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

echo
echo "passed: $PASS  failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
