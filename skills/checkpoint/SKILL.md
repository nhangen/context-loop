---
name: checkpoint
description: Checkpoint the current task into a structured Live State brief, write it to claude-mem + Obsidian, then run /compact and re-state the brief so the post-compact agent sees it intact. Invoke when context-loop fires an advisory, or any time you proactively want to drop below 35% context fill without losing task state.
---

# checkpoint

Triggered when context fill crossed the threshold. The live conversation is already degrading. Get out fast and clean.

## Run order

1. **Dispatch the summarizer subagent (clean context).** Use the `general-purpose` Agent tool. Pass the prompt from `subagent-prompt.md` (in this skill directory) plus the absolute path of the live transcript JSONL (from the most recent Stop payload's `transcript_path`, or resolve via `~/.claude/projects/<proj>/<session_id>.jsonl`). The subagent will use `jq` to project the transcript into a compact form — do NOT have it `Read` the raw JSONL (rule: `~/.claude/rules/no-cat-subagent-jsonl.md`).

2. **Receive the brief.** The subagent returns a single Markdown document with these sections, in this order:
   - `## Goal` — one sentence
   - `## Live State` — verbatim file paths, branches, PR numbers, error messages, tool outputs being acted on. Extraction, not paraphrase.
   - `## Decisions` — what was chosen and why, since session start or last checkpoint
   - `## Loose ends` — open questions, deferred items, things flagged for follow-up
   - `## Next step` — the single next action

3. **Write to durable storage in parallel:**
   - Append the brief to today's Obsidian daily note under a `## Checkpoint <HH:MM>` heading. Write directly to `~/Documents/Obsidian/Daily/<YYYY-MM-DD>.md`.
   - Save the brief as a checkpoint file at `~/.claude/plugins/cache/nhangen-tools/context-loop/0.1.0/state/checkpoints/<session_id>-<ISO>.md`. claude-mem's existing Stop summarizer will pick this up at session end.

4. **Run `/compact` then re-state the brief as a user message.** Claude Code's `/compact` summarizes per its own rules; passing a "preserve this verbatim" instruction is not reliable. The robust pattern is two steps:
   - Invoke `/compact` (no arg, or with a brief steering hint like "drop old tool output and exploratory turns aggressively").
   - Immediately after the compaction completes, post the Live State brief as a single text message in the conversation. It then lives in the post-compact transcript and is visible to the next assistant turn.

5. **Verify.** The next turn should be able to find the Live State block. If it's missing, re-post it.

## Rules

- Do NOT have the main agent write the summary — it is by definition above the threshold and degraded.
- Do NOT skip the durable writes (Obsidian + checkpoint file). Compaction is only safe because nothing important is lost.
- Do NOT paraphrase identifiers in Live State. File paths, branch names, PR numbers, and error strings are extracted character-for-character.
- If the subagent fails, write a minimal hand-rolled brief from your own memory of the session and proceed — partial compaction beats no compaction at 50%+.
