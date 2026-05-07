---
name: context-loop:checkpoint
description: Checkpoint the current task into a structured Live State brief, write it to claude-mem + Obsidian, then run /compact with the brief pinned. Invoke when context-loop fires an advisory or block, or any time you proactively want to drop below 35% context fill without losing task state.
---

# context-loop:checkpoint

You were nudged here because context fill crossed the threshold. The live conversation is already degrading. Get out fast and clean.

## Run order

1. **Dispatch the summarizer subagent (clean context).** Use the `general-purpose` Agent tool. Pass the full prompt from `subagent-prompt.md` (in this skill directory) plus the transcript path Claude Code provided in the most recent Stop hook payload. The subagent reads the JSONL directly — do NOT paste transcript contents into its prompt.

2. **Receive the brief.** The subagent returns a single Markdown document with these sections, in this order:
   - `## Goal` — one sentence
   - `## Live State` — verbatim file paths, branches, PR numbers, error messages, tool outputs being acted on. Extraction, not paraphrase.
   - `## Decisions` — what was chosen and why, since session start or last checkpoint
   - `## Loose ends` — open questions, deferred items, things flagged for follow-up
   - `## Next step` — the single next action

3. **Write to durable storage in parallel:**
   - Append the brief to today's Obsidian daily note under a `## Checkpoint <HH:MM>` heading. Use the `obsidian:daily` skill or write directly to `~/Documents/Obsidian/Daily/<YYYY-MM-DD>.md`.
   - Save the brief as a checkpoint file at `~/.claude/plugins/cache/nhangen-tools/context-loop/0.1.0/state/checkpoints/<session_id>-<ISO>.md`. claude-mem's existing Stop summarizer will pick this up at session end.

4. **Run `/compact` with the brief as the guiding instruction.** Wrap the brief in `<pinned-context>...</pinned-context>` tags and tell `/compact` to preserve the pinned block verbatim and drop everything else aggressively (old tool outputs, exploratory dead ends, resolved sub-tasks). Example invocation: `/compact preserve the following pinned context verbatim and drop all other tool output and exploratory turns: <pinned-context>...</pinned-context>`.

5. **Verify.** After compact, the next assistant turn should be able to read its own context and find the Live State block intact. If the block is missing, re-inject it as a single message before yielding.

## Rules

- Do NOT have the main agent write the summary — it is by definition above 35% fill and degraded.
- Do NOT skip the durable writes (Obsidian + checkpoint file). The whole point is that compaction is safe because nothing is lost.
- Do NOT paraphrase identifiers in Live State. File paths, branch names, PR numbers, and error strings are extracted character-for-character.
- If the subagent fails, write a minimal hand-rolled brief from your own memory of the session and proceed — partial compaction beats no compaction at 50%+.
