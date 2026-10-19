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
export CONTEXT_LOOP_ERROR_LOG="$TMP/context-loop-errors.log"
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
#
# Deliberately above the ESCALATED default of 0.50, not at it: the "nags using
# default 0.50" test below needs a fill strictly between 0.35 and 0.50 to
# distinguish the default from a broken 0.80 override (which would also nag
# here), and between 0.50 and the typoed 0.80 override (which would not).
PRECOMPACT='{"type":"assistant","uuid":"a1","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"cache_read_input_tokens":80000,"cache_creation_input_tokens":0,"output_tokens":100},"content":[{"type":"text","text":"pre"}]}}'
COMPACT='{"type":"user","isCompactSummary":true,"message":{"content":[{"type":"text","text":"summary"}]}}'
POSTSMALL='{"type":"assistant","uuid":"a2","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"cache_read_input_tokens":5000,"cache_creation_input_tokens":0,"output_tokens":50},"content":[{"type":"text","text":"post"}]}}'

# Shape verified against a real Claude Code session transcript containing a
# genuine /compact run — not inferred. The real row also carries
# parentUuid, logicalParentUuid, isSidechain, level, compactMetadata, uuid,
# timestamp, userType, entrypoint, cwd, sessionId, version, gitBranch, and
# slug. This fixture keeps only the three fields the worker reads (type,
# subtype, content); the omitted ones are inert here but are what a reader
# comparing this against a live transcript will see.
COMPACT_SYS='{"type":"system","subtype":"compact_boundary","content":"Conversation compacted"}'
NON_USER_COMPACT_FLAG='{"type":"system","subtype":"status","isCompactSummary":true,"content":"Status update"}'

# Mid-range post-boundary turn: fill 0.40 -> above advisory (0.35), below
# escalated (0.50), so the cooldown branch actually decides the outcome.
POSTMID='{"type":"assistant","uuid":"a2","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"cache_read_input_tokens":40000,"cache_creation_input_tokens":0,"output_tokens":50},"content":[{"type":"text","text":"post"}]}}'

# Fill 0.45 -> above the ADVISORY default (0.35) and strictly BELOW the
# ESCALATED default (0.50). This is the pin: with the escalated default in
# effect it nags only via the advisory tier, so a broken 0.80 default would
# be silent here, while the typoed-override test below (override 0.80) must
# stay silent.
POSTDEFAULT='{"type":"assistant","uuid":"a3","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"cache_read_input_tokens":45000,"cache_creation_input_tokens":0,"output_tokens":50},"content":[{"type":"text","text":"post"}]}}'

run_gate() {  # $1 = transcript file
  printf '{"transcript_path":"%s","session_id":"cbtest"}' "$1" | "$GATE" 2>/dev/null
}

run_gate_session() {  # $1 = transcript file, $2 = session id
  printf '{"transcript_path":"%s","session_id":"%s"}' "$1" "$2" | "$GATE" 2>/dev/null
}

echo "test: compact summary is the newest entry -> no nag (stale pre-compact usage ignored)"
TF="$TMP/t_compact_last.jsonl"
printf '%s\n%s\n' "$PRECOMPACT" "$COMPACT" > "$TF"
out=$(run_gate "$TF")
check "  output {}"  "$out"  "{}"

echo "test: system compact_boundary is the newest entry -> no nag"
TF="$TMP/t_compact_sys_last.jsonl"
printf '%s\n%s\n' "$PRECOMPACT" "$COMPACT_SYS" > "$TF"
out=$(run_gate "$TF")
check "  output {}"  "$out"  "{}"

echo "test: small assistant turn AFTER compact -> no nag (fill from post-compact turn)"
TF="$TMP/t_post_small.jsonl"
printf '%s\n%s\n%s\n' "$PRECOMPACT" "$COMPACT" "$POSTSMALL" > "$TF"
out=$(run_gate "$TF")
check "  output {}"  "$out"  "{}"

# The pair below is the regression test for the system-row branch's reset of
# the UUID tracking state (`assistantUuids` / `lastAssistantUuid`), not just
# `lastUsage`. Cooldown is keyed on finding the last-fired assistant UUID in
# `assistantUuids` (worker line ~237): if the boundary does not clear that
# list, a pre-boundary fire keeps suppressing post-boundary advisories for
# `cooldownTurns` turns — a silently muted nag right when context is growing
# again. Asserting only "a small post-boundary turn does not nag" cannot see
# this, because fill always reads off the last turn's own usage; that test was
# removed in favor of these two.
#
# Arm A is the control: it proves cooldown suppression is live, so arm B's nag
# is attributable to the reset and not to cooldown being inert.
export CONTEXT_LOOP_STATE_DIR="$TMP/cooldown-state"
mkdir -p "$CONTEXT_LOOP_STATE_DIR"
printf '{"lastFiredUuid":"a1","lastFiredFill":0.8,"lastFiredAt":"2026-01-01T00:00:00Z"}' \
  > "$CONTEXT_LOOP_STATE_DIR/cbcool.json"

echo "test: (control) mid-fill turn within cooldown of a prior fire -> no nag"
TF="$TMP/t_cooldown_control.jsonl"
printf '%s\n%s\n' "$PRECOMPACT" "$POSTMID" > "$TF"
out=$(run_gate_session "$TF" "cbcool")
check "  output {}"  "$out"  "{}"

# Pin the DEFAULT cooldown length (15), not just "some suppression": the
# last-fired uuid (a1) sits 14 turns behind the final turn, so a default of
# 14 would let this advisory through while the real default of 15 must not.
# A recent fire (state lastFiredUuid=a1) is the precondition the issue asks
# for: the suppression is attributed to cooldown, not to fill or tier.
echo "test: advisory within the default 15-turn cooldown of a recent fire -> no nag"
{
  printf '%s\n' "$PRECOMPACT"
  for i in $(seq 1 14); do printf '{"type":"assistant","uuid":"z%s","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"cache_read_input_tokens":40000,"cache_creation_input_tokens":0,"output_tokens":50},"content":[{"type":"text","text":"p"}]}}\n' "$i"; done
} > "$TMP/t_cooldown_15.jsonl"
out=$(run_gate_session "$TMP/t_cooldown_15.jsonl" "cbcool")
check "  output {}"  "$out"  "{}"

# Counterfactual: the very same 15-turn transcript passes a 14-turn cooldown
# (a recent fire 15 turns back is >= 14 turns old), proving the suppression
# above comes from the default being 15 rather than some smaller number.
export CONTEXT_LOOP_COOLDOWN_TURNS=14
out=$(run_gate_session "$TMP/t_cooldown_15.jsonl" "cbcool")
nag="no"; case "$out" in *"context at"*) nag="yes";; esac
check "  same transcript nags under an explicit 14-turn cooldown" "$nag" "yes"
unset CONTEXT_LOOP_COOLDOWN_TURNS

# Re-seed: a firing run rewrites the state file.
printf '{"lastFiredUuid":"a1","lastFiredFill":0.8,"lastFiredAt":"2026-01-01T00:00:00Z"}' \
  > "$CONTEXT_LOOP_STATE_DIR/cbcool.json"

echo "test: non-user compact flag without compact_boundary does not reset cooldown state"
TF="$TMP/t_non_user_compact_flag.jsonl"
printf '%s\n%s\n%s\n' "$PRECOMPACT" "$NON_USER_COMPACT_FLAG" "$POSTMID" > "$TF"
out=$(run_gate_session "$TF" "cbcool")
check "  output {}"  "$out"  "{}"

# Re-seed: a firing run rewrites the state file.
printf '{"lastFiredUuid":"a1","lastFiredFill":0.8,"lastFiredAt":"2026-01-01T00:00:00Z"}' \
  > "$CONTEXT_LOOP_STATE_DIR/cbcool.json"

echo "test: system compact_boundary resets UUID cooldown state -> mid-fill turn nags"
TF="$TMP/t_cooldown_reset.jsonl"
printf '%s\n%s\n%s\n' "$PRECOMPACT" "$COMPACT_SYS" "$POSTMID" > "$TF"
out=$(run_gate_session "$TF" "cbcool")
nag="no"; case "$out" in *"context at"*) nag="yes";; esac
check "  nags"  "$nag"  "yes"

unset CONTEXT_LOOP_STATE_DIR

echo "test: large turn with NO compact summary -> still nags (normal escalation intact)"
TF="$TMP/t_no_compact.jsonl"
printf '%s\n' "$PRECOMPACT" > "$TF"
out=$(run_gate "$TF")
nag="no"; case "$out" in *"context at"*) nag="yes";; esac
check "  nags"  "$nag"  "yes"

echo "test: usage above the window reports 100.0%, never more"
OVERWINDOW='{"type":"assistant","uuid":"a1","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"cache_read_input_tokens":125000,"cache_creation_input_tokens":0,"output_tokens":100},"content":[{"type":"text","text":"big"}]}}'
TF="$TMP/t_overwindow.jsonl"
printf '%s\n' "$OVERWINDOW" > "$TF"
out=$(run_gate "$TF")
capped="no"; case "$out" in *"context at 100.0%"*) capped="yes";; esac
check "  reports 100.0%"  "$capped"  "yes"
over="no"; case "$out" in *"125."*) over="yes";; esac
check "  does not report 125%"  "$over"  "no"

unset CONTEXT_LOOP_WINDOW

echo "test: typoed CONTEXT_LOOP_ADVISORY_AT logs breadcrumb and falls back to default"
export CONTEXT_LOOP_WINDOW=100000
export CONTEXT_LOOP_ADVISORY_AT="x0.45"
TF="$TMP/t_advisory_typo.jsonl"
printf '%s\n' "$POSTMID" > "$TF"
out=$(run_gate "$TF")
nag="no"; case "$out" in *"context at"*) nag="yes";; esac
check "  nags using default 0.35" "$nag" "yes"
logged="no"; if grep -q "parseThreshold ignoring CONTEXT_LOOP_ADVISORY_AT=x0.45" "$CONTEXT_LOOP_ERROR_LOG" 2>/dev/null; then logged="yes"; fi
check "  logs rejection breadcrumb" "$logged" "yes"
unset CONTEXT_LOOP_ADVISORY_AT
unset CONTEXT_LOOP_WINDOW

echo "test: typoed CONTEXT_LOOP_ESCALATED_AT logs breadcrumb and falls back to default"
export CONTEXT_LOOP_WINDOW=100000
# Typoed (invalid) override -> must log a rejection and fall back to 0.50.
export CONTEXT_LOOP_ESCALATED_AT="bad"
TF="$TMP/t_escalated_typo.jsonl"
printf '%s\n' "$POSTDEFAULT" > "$TF"
out=$(run_gate "$TF")
nag="no"; case "$out" in *"context at"*) nag="yes";; esac
check "  nags using default 0.50" "$nag" "yes"
logged="no"; if grep -q "parseThreshold ignoring CONTEXT_LOOP_ESCALATED_AT=bad" "$CONTEXT_LOOP_ERROR_LOG" 2>/dev/null; then logged="yes"; fi
check "  logs rejection breadcrumb" "$logged" "yes"
# Pin the fallback VALUE, not just that it nags: a VALID 0.80 override stays
# silent at this fill while the 0.50 default must fire the advisory tier.
export CONTEXT_LOOP_ESCALATED_AT="0.80"
TF="$TMP/t_escalated_override_silent.jsonl"
printf '%s\n' "$POSTDEFAULT" > "$TF"
out=$(run_gate "$TF")
check "  valid 0.80 override stays silent" "$out" "{}"
unset CONTEXT_LOOP_ESCALATED_AT
unset CONTEXT_LOOP_WINDOW

echo "test: typoed CONTEXT_LOOP_COOLDOWN_TURNS logs breadcrumb and falls back to default"
export CONTEXT_LOOP_WINDOW=100000
export CONTEXT_LOOP_COOLDOWN_TURNS="15turns"
TF="$TMP/t_cooldown_typo.jsonl"
printf '%s\n' "$PRECOMPACT" > "$TF"
out=$(run_gate "$TF")
logged="no"; if grep -q "parseCooldownTurns ignoring CONTEXT_LOOP_COOLDOWN_TURNS=15turns" "$CONTEXT_LOOP_ERROR_LOG" 2>/dev/null; then logged="yes"; fi
check "  logs rejection breadcrumb" "$logged" "yes"
# Pin the fallback VALUE, not just the breadcrumb: "15turns" is a typo of 15,
# so use 14 for the counterfactual. The same fill sits 14 turns past its last
# fire: the default-15 fallback must still suppress the advisory, while a
# valid 14-turn override must let it through.
{
  printf '%s\n' "$PRECOMPACT"
  for i in $(seq 1 14); do printf '{"type":"assistant","uuid":"c%s","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"cache_read_input_tokens":40000,"cache_creation_input_tokens":0,"output_tokens":50},"content":[{"type":"text","text":"p"}]}}\n' "$i"; done
} > "$TMP/t_cooldown_typo_pin.jsonl"
export CONTEXT_LOOP_STATE_DIR="$TMP/cooldown-state"
mkdir -p "$CONTEXT_LOOP_STATE_DIR"
printf '{"lastFiredUuid":"a1","lastFiredFill":0.8,"lastFiredAt":"2026-01-01T00:00:00Z"}' \
  > "$CONTEXT_LOOP_STATE_DIR/pin.json"
out=$(run_gate_session "$TMP/t_cooldown_typo_pin.jsonl" "pin")
check "  typo falls back to 15: advisory still suppressed" "$out" "{}"
export CONTEXT_LOOP_COOLDOWN_TURNS=14
printf '{"lastFiredUuid":"a1","lastFiredFill":0.8,"lastFiredAt":"2026-01-01T00:00:00Z"}' \
  > "$CONTEXT_LOOP_STATE_DIR/pin.json"
out=$(run_gate_session "$TMP/t_cooldown_typo_pin.jsonl" "pin")
nag="no"; case "$out" in *"context at"*) nag="yes";; esac
check "  valid 14-turn override lets the advisory through" "$nag" "yes"
unset CONTEXT_LOOP_STATE_DIR
unset CONTEXT_LOOP_COOLDOWN_TURNS
unset CONTEXT_LOOP_WINDOW

echo "test: typoed legacy CONTEXT_LOOP_BLOCK_AT is logged under its own name"
export CONTEXT_LOOP_WINDOW=100000
export CONTEXT_LOOP_BLOCK_AT="bad"
TF="$TMP/t_block_at_typo.jsonl"
printf '%s\n' "$PRECOMPACT" > "$TF"
out=$(run_gate "$TF")
logged="no"; if grep -q "parseThreshold ignoring CONTEXT_LOOP_BLOCK_AT=bad" "$CONTEXT_LOOP_ERROR_LOG" 2>/dev/null; then logged="yes"; fi
check "  logs legacy variable name" "$logged" "yes"
unset CONTEXT_LOOP_BLOCK_AT
unset CONTEXT_LOOP_WINDOW

echo
echo "passed: $PASS  failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
