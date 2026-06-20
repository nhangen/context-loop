# context-loop

**Nudge `/compact` on your Claude Code session before context fill kills response quality.**

Once a Claude Code conversation crosses ~35–40% of the model's context window, response quality, tool-call accuracy, and per-token cost all degrade. `context-loop` watches the live transcript on every assistant `Stop`, computes fill % from the last `usage` block, and when fill crosses a threshold injects an advisory `additionalContext` line nudging the agent to run `/compact` on its next turn. Every fire and the compaction that follows are recorded to a local SQLite DB for savings analytics.

That's the whole mechanism: a fill-aware, cooldown-gated, mid-chain-safe reminder to compact. It is **advisory only** — a Stop hook cannot force the agent to act (see `~/.claude/rules/claude-code-hook-output-semantics.md`). Durable state across the compaction boundary is left to the tools that already do it well — claude-mem (cross-session observations) and the Obsidian plugin (session notes) — which `context-loop` does not write to; it only keeps the *live* conversation under the cliff.

## Why

Claude Code has built-in auto-compact at ~95% fill, but by then quality is already wrecked. There is no "keep me below 40% perpetually" mechanism. Manual `/compact` works but you have to remember to run it, and you have to trust the summary to preserve the file paths, branches, and error strings you were actually working on.

`context-loop` makes the *timing* automatic — it reminds you to compact at the right moment instead of at 95% when quality is already gone. It sits alongside the durable layer you (probably) already have, without writing to it:

- **claude-mem** stores cross-session observations (its own Stop summarizer).
- **Obsidian** stores session notes and daily logs (its own session-end save).
- **context-loop** keeps the *live* conversation under the cliff by nudging `/compact`; the other two independently capture the long arc.

## How it works

```
              ┌────────────── Stop event ──────────────┐
Claude Code ──┤                                        │
              │  ~/.claude/hooks/context-loop-gate.sh  │
              │      │                                 │
              │      ▼                                 │
              │  bun worker reads transcript JSONL,    │
              │  computes fill % from last `usage`     │
              │  block, applies cooldown + mid-chain   │
              │  safety, writes state + records the    │
              │  fire to SQLite.                       │
              │      │                                 │
              │      ▼ (if threshold crossed)          │
              │  emit additionalContext:               │
              │  "context at N% — run /compact"        │
              └────────────────────────────────────────┘
                                │
                                ▼
              agent runs /compact on its next turn;
              the next Stop detects the token drop and
              records the compaction outcome.
```

### Trigger: Stop hook, not PostToolUse

PostToolUse fires dozens of times per turn — too chatty, and tool chains are unsafe compaction boundaries. Stop fires exactly once per assistant yield, which is the only moment compaction is safe.

### Threshold: hybrid, two-tier

- **Advisory** at 35% fill — the agent is encouraged to checkpoint between major tasks.
- **Escalated advisory** at 50% fill — louder copy; cooldown is bypassed.

Both tiers emit `hookSpecificOutput.additionalContext` — purely advisory text injection. The harness cannot force the agent to act; it can only make the next-turn context include the nudge. (See `~/.claude/rules/claude-code-hook-output-semantics.md` if you're tempted to dress this as "blocking" — it isn't.)

A 15-turn cooldown after a fire prevents thrash. Cooldown is keyed on the **assistant message UUID** at fire time, not turn count — when `/compact` rewrites the transcript and the marker UUID disappears, cooldown resets automatically.

### Mid-chain safety

If the final assistant turn emitted `tool_use` blocks without matching `tool_result`, the gate exits silently — never advise mid-chain.

### Window detection

The divisor is a **dynamic variable**. `CONTEXT_LOOP_WINDOW`, if set to a positive integer, is used verbatim — this is the authoritative override for sessions whose real window the hook can't infer (1M-beta `[1m]`, fast-mode, model aliases, future models). With no override, it falls back to a model-name heuristic: `opus` → 1,000,000, everything else → 200,000.

The heuristic is a guess, not ground truth — the transcript's `model` field carries no window size, and a misjudged divisor produces nonsense fill (e.g. a too-small divisor reporting >100%). When in doubt, set `CONTEXT_LOOP_WINDOW` explicitly.

### `/compact` is best-effort

Claude Code's `/compact` summarizes the transcript; it is not verbatim preservation, and `context-loop` does not try to make it one. If you need the active task's file paths, branches, and error strings to survive verbatim, capture them durably (claude-mem / an Obsidian session note) before compacting — `context-loop`'s job is the *timing* of the nudge, not the summary's fidelity.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1.0 (for the worker)
- `jq` (for the gate's transcript-path extraction)
- A Claude Code installation
- Optional but recommended: [`obsidian` plugin](https://github.com/nhangen/claude-obsidian-plugin) and [`claude-mem`](https://github.com/thedotmack/claude-mem) for durable storage

## Install

### Via marketplace (recommended)

If you've already added the `nhangen-tools` marketplace:

```bash
/plugin install context-loop@nhangen-tools
```

If not, add the marketplace first:

```bash
/plugin marketplace add nhangen/claude-plugins
/plugin install context-loop@nhangen-tools
```

The installer drops the plugin under `~/.claude/plugins/cache/nhangen-tools/context-loop/<version>/` and you'll need to add the Stop hook to `~/.claude/settings.json` manually (next section).

### Manual

```bash
git clone git@github.com:nhangen/context-loop.git ~/ML-AI/claude/context-loop
cd ~/ML-AI/claude/context-loop
bun install
```

Then symlink into the plugin cache so the version-resilient delegator finds it:

```bash
mkdir -p ~/.claude/plugins/cache/nhangen-tools/context-loop
ln -s ~/ML-AI/claude/context-loop ~/.claude/plugins/cache/nhangen-tools/context-loop/0.1.2
```

### Wire up the Stop hook

Add a delegator at `~/.claude/hooks/context-loop-gate.sh` (mirrors the `cost-alert.sh` pattern — version-resilient resolver):

```bash
#!/bin/bash
set -euo pipefail
PLUGIN_BASE="$HOME/.claude/plugins/cache/nhangen-tools/context-loop"
PLUGIN_DIR=""
[ -d "$PLUGIN_BASE" ] && PLUGIN_DIR=$(ls -1d "$PLUGIN_BASE"/*/ 2>/dev/null | sort -V | tail -1)
if [ -z "$PLUGIN_DIR" ] || [ ! -f "${PLUGIN_DIR}hooks/context-loop-gate.sh" ]; then
  echo '{}'; exit 0
fi
exec bash "${PLUGIN_DIR}hooks/context-loop-gate.sh"
```

`chmod +x` it, then add to the `Stop` array in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash \"/Users/<you>/.claude/hooks/context-loop-gate.sh\"",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

## Configuration

All via env vars on the hook command. Defaults are conservative for a 1M-window opus user.

| Variable | Default | What it does |
|---|---|---|
| `CONTEXT_LOOP_ADVISORY_AT` | `0.35` | Fill % at which the advisory tier fires (subject to cooldown). |
| `CONTEXT_LOOP_ESCALATED_AT` | `0.50` | Fill % at which the escalated tier fires (ignores cooldown). |
| `CONTEXT_LOOP_COOLDOWN_TURNS` | `15` | Assistant turns of cooldown after a fire (advisory tier only). |
| `CONTEXT_LOOP_WINDOW` | unset | Context-window size (tokens) used as the fill divisor. Overrides the model-name heuristic when set. |
| `CONTEXT_LOOP_STATE_DIR` | `<plugin>/state` | Where per-session state JSON is persisted. |
| `CONTEXT_LOOP_DB` | `<state>/context-loop.db` | SQLite path for fires + outcomes analytics. |
| `BUN_PATH` | autodetect | Path to `bun` binary if not on `$PATH`. |
| `CONTEXT_LOOP_FORCE` | unset | Set to `1` to bypass mid-chain safety (testing only). |

The gate also honors the legacy `CONTEXT_LOOP_BLOCK_AT` for backwards compat — it's read as `CONTEXT_LOOP_ESCALATED_AT` if the new var is unset.

## The `checkpoint` skill

Lives at `skills/checkpoint/SKILL.md`. It is deliberately a one-liner: **run `/compact`**. `/compact` handles state preservation on its own, so the skill exists only to give the advisory a concrete action and a manual entry point — invoke `/checkpoint` any time you want to compact without waiting for a fire.

> Earlier versions dispatched a summarizer subagent and wrote a structured brief to Obsidian + a checkpoint file. That was stripped to `/compact`-only (commit `f874757`) — the subagent/brief machinery added complexity for marginal gain over `/compact` plus the durable layer that claude-mem and Obsidian already provide.

## Savings analytics

Every fire and every post-fire outcome is recorded to a local SQLite DB at `state/context-loop.db` (override with `CONTEXT_LOOP_DB`). Rows include session id, fill %, tier, token counts, and whether a compaction was detected on subsequent turns.

| Table | What's in it |
|---|---|
| `fire_events` | One row per advisory/escalated fire: timestamp, level, fill %, input/cache tokens, assistant UUID. |
| `compaction_outcomes` | Post-fire detection: whether `/compact` ran (observed token drop) on the turns after a fire, keyed to the fire event. |

Read-only; the plugin never reports upstream. Inspect with any sqlite client; schema lives in `hooks/context-loop-db.ts`.

## Composition with claude-mem and Obsidian

`context-loop` is the **mid-session compaction-timing layer**. It does not write to the other two — they capture durable state on their own schedule:

- **claude-mem** — runs its own Stop summarizer that captures observations into a cross-session DB.
- **Obsidian** — the session-end save (via the [obsidian plugin](https://github.com/nhangen/claude-obsidian-plugin)) captures the full session arc.

Three independent layers, no overlap: claude-mem for the long arc, Obsidian for the session note, context-loop for keeping the live conversation under the degradation cliff.

## Caveats

- **Advisory only.** Stop-hook `additionalContext` cannot prevent the agent from continuing. The plugin nudges; it doesn't enforce. Copy reflects this.
- **`/compact` is best-effort.** It summarizes, it doesn't pin verbatim. `context-loop` controls *when* you compact, not what survives — capture anything load-bearing durably before the boundary.
- **Bun required.** The worker is TypeScript executed via `bun`. No Node.js fallback — adds dependencies the user (probably) doesn't want.
- **Single-machine state.** State files are local. Run on multiple machines and each maintains its own cooldown.
- **No mid-chain firing.** The gate is silent inside any unresolved tool chain. If your turns are huge multi-tool chains, the threshold may be exceeded for one or two long turns before the next clean Stop boundary.

## Development

```bash
cd ~/ML-AI/claude/context-loop
bun install
bun run typecheck    # tsc --noEmit
bun test             # bun test + tests/gate.test.sh
```

Symlink the plugin cache to your source for live iteration:

```bash
ln -sfn ~/ML-AI/claude/context-loop \
  ~/.claude/plugins/cache/nhangen-tools/context-loop/0.1.2
```

Test the worker against a real transcript:

```bash
JSONL=~/.claude/projects/<proj>/<session_id>.jsonl
CONTEXT_LOOP_FORCE=1 bun hooks/context-loop-worker.ts \
  "$JSONL" /tmp/ctxloop-test "test-session" 0.05 0.50 15
```

`CONTEXT_LOOP_FORCE=1` bypasses the mid-chain safety so you can fire even when the live session has unresolved `tool_use` blocks.

## License

MIT.
