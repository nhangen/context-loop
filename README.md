# context-loop

**Auto-checkpoint and `/compact` your Claude Code session before context fill kills response quality.**

Once a Claude Code conversation crosses ~35–40% of the model's context window, response quality, tool-call accuracy, and per-token cost all degrade. `context-loop` watches the live transcript on every assistant turn and, when fill crosses a threshold, nudges the agent to:

1. dispatch a clean-context summarizer subagent that produces a structured **Live State** brief,
2. write the brief to durable storage (Obsidian + a checkpoint file claude-mem can pick up),
3. run `/compact`, and
4. re-post the brief as a user message so the post-compact agent sees it intact.

The live conversation stays under the degradation cliff. Nothing important is lost — claude-mem and Obsidian hold the long arc; the brief carries the active task across compaction.

## Why

Claude Code has built-in auto-compact at ~95% fill, but by then quality is already wrecked. There is no "keep me below 40% perpetually" mechanism. Manual `/compact` works but you have to remember to run it, and you have to trust the summary to preserve the file paths, branches, and error strings you were actually working on.

`context-loop` makes the boundary automatic and the summary structured. It composes with the durable layer you (probably) already have:

- **claude-mem** stores cross-session observations.
- **Obsidian** stores session notes and daily logs.
- **context-loop** keeps the *live* conversation under the cliff by handing off cleanly to those two.

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
              │  safety, writes state.                 │
              │      │                                 │
              │      ▼ (if threshold crossed)          │
              │  emit additionalContext nudging the    │
              │  agent to invoke the `checkpoint`      │
              │  skill on its next turn.               │
              └────────────────────────────────────────┘
                                │
                                ▼
              ┌─────────── checkpoint skill ───────────┐
              │  1. dispatch clean-context subagent    │
              │  2. subagent runs `jq` projection on   │
              │     the transcript, writes Live State  │
              │  3. main agent appends brief to        │
              │     today's Obsidian daily note +      │
              │     state/checkpoints/ for claude-mem  │
              │  4. /compact (with optional steering)  │
              │  5. re-post the brief as a user        │
              │     message so it survives compaction  │
              └────────────────────────────────────────┘
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

Reads the per-message `model` field for a `[1m]` marker first, then falls back to `~/.claude/settings.json` for the user's configured model. Multi-session safe: a 200K-window session won't be evaluated against a 1M divisor.

### The subagent doesn't `Read` the JSONL

A late-session transcript is megabytes of mostly tool_result blobs. The subagent prompt mandates a `jq` projection that strips usage metadata and truncates inputs/results to ≤300 chars before any read — see `~/.claude/rules/no-cat-subagent-jsonl.md`.

### `/compact` is best-effort

Claude Code's `/compact` accepts a steering hint, but the hint is fed to the summarizer as guidance — it is not verbatim preservation. The brief is therefore **also re-posted as a user message after compact**, so it lives in the post-compact transcript regardless of how the summarizer handled the steering text.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1.0 (for the worker)
- `jq` (for the gate's transcript-path extraction and the subagent's projection)
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
ln -s ~/ML-AI/claude/context-loop ~/.claude/plugins/cache/nhangen-tools/context-loop/0.1.0
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
| `CONTEXT_LOOP_STATE_DIR` | `<plugin>/state` | Where per-session state JSON is persisted. |
| `BUN_PATH` | autodetect | Path to `bun` binary if not on `$PATH`. |
| `CONTEXT_LOOP_FORCE` | unset | Set to `1` to bypass mid-chain safety (testing only). |

The gate also honors the legacy `CONTEXT_LOOP_BLOCK_AT` for backwards compat — it's read as `CONTEXT_LOOP_ESCALATED_AT` if the new var is unset.

## The `checkpoint` skill

Triggered by the advisory or invoked manually. Lives at `skills/checkpoint/SKILL.md`. Run order:

1. **Dispatch summarizer subagent** — `general-purpose`, with the prompt from `subagent-prompt.md` and the absolute path of the live transcript.
2. **Receive the structured brief** — `## Goal`, `## Live State` (verbatim file paths / branches / PRs / errors), `## Decisions`, `## Loose ends`, `## Next step`.
3. **Write to durable storage** — append to today's Obsidian daily note under a `## Checkpoint <HH:MM>` heading; save a copy at `state/checkpoints/<session_id>-<ISO>.md`.
4. **Run `/compact`** with an optional steering hint.
5. **Re-post the brief as a user message** — guarantees it lives in the post-compact transcript regardless of how the summarizer handled the steering hint.

You can also invoke `/checkpoint` manually any time you want to drop below 35% without losing state.

## Composition with claude-mem and Obsidian

`context-loop` is the **mid-session compaction layer**. The other two layers are:

- **claude-mem** — runs its own Stop summarizer that captures observations into a cross-session DB. `context-loop` writes checkpoint files to a path claude-mem already scans, so its observations include each compaction boundary.
- **Obsidian** — receives the brief as an appended section on the daily note. The session-end save (via the [obsidian plugin](https://github.com/nhangen/claude-obsidian-plugin)) then captures the full session arc on top.

Three layers, no overlap: claude-mem for long arc, Obsidian for the session note, context-loop for the active task across compactions.

## Caveats

- **Advisory only.** Stop-hook `additionalContext` cannot prevent the agent from continuing. The plugin nudges; it doesn't enforce. Copy reflects this.
- **`/compact` is best-effort.** Steering hints guide the summarizer; they don't pin verbatim. The post-compact user-message re-post is the actual guarantee.
- **Bun required.** The worker is TypeScript executed via `bun`. No Node.js fallback — adds dependencies the user (probably) doesn't want.
- **Single-machine state.** State files are local. Run on multiple machines and each maintains its own cooldown.
- **No mid-chain firing.** The gate is silent inside any unresolved tool chain. If your turns are huge multi-tool chains, the threshold may be exceeded for one or two long turns before the next clean Stop boundary.

## Development

```bash
cd ~/ML-AI/claude/context-loop
bun install
bun run typecheck    # tsc --noEmit
```

Symlink the plugin cache to your source for live iteration:

```bash
ln -sfn ~/ML-AI/claude/context-loop \
  ~/.claude/plugins/cache/nhangen-tools/context-loop/0.1.0
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
