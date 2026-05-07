#!/usr/bin/env bun
// context-loop worker — decides whether to nudge a checkpoint+compact.
//
// Reads the live transcript, computes context fill % from the most recent
// assistant `usage` block, applies cooldown + mid-chain safety, and emits
// a Claude Code hookSpecificOutput.additionalContext payload when the
// advisory or block threshold is crossed.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const [, , transcriptPath, stateDir, sessionId, advisoryAtRaw, blockAtRaw, cooldownTurnsRaw] =
  process.argv;

if (!transcriptPath || !stateDir) {
  console.log("{}");
  process.exit(0);
}

const advisoryAt = parseFloat(advisoryAtRaw ?? "0.35");
const blockAt = parseFloat(blockAtRaw ?? "0.50");
const cooldownTurns = parseInt(cooldownTurnsRaw ?? "15");

// The transcript records the underlying API model (e.g. `claude-opus-4-7`)
// without the `[1m]` suffix even when the user has opted into the 1M window
// via settings.json. Read that file as the source of truth.
function windowFromSettings(): number {
  try {
    const home = process.env["HOME"] || "";
    const raw = readFileSync(join(home, ".claude/settings.json"), "utf8");
    const cfg = JSON.parse(raw) as { model?: string };
    const m = (cfg.model || "").toLowerCase();
    if (m.includes("[1m]") || m.endsWith("-1m")) return 1_000_000;
  } catch { /* fall through */ }
  return 200_000;
}
const SETTINGS_WINDOW = windowFromSettings();
function windowFor(model: string): number {
  const m = (model || "").toLowerCase();
  if (m.includes("[1m]") || m.includes("-1m")) return 1_000_000;
  return SETTINGS_WINDOW;
}

let raw: string;
try {
  raw = readFileSync(transcriptPath, "utf8");
} catch {
  console.log("{}");
  process.exit(0);
}
const lines = raw.split("\n").filter(Boolean);

let assistantTurns = 0;
let lastUsage: Record<string, number> | null = null;
let lastModel = "";
let lastAssistantHadToolUse = false;
let lastToolUseIds: Set<string> = new Set();
let toolResultIds: Set<string> = new Set();

for (const line of lines) {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }

  if (obj["type"] === "user") {
    const content = (obj["message"] as Record<string, unknown>)?.["content"];
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block["type"] === "tool_result" && block["tool_use_id"]) {
          toolResultIds.add(String(block["tool_use_id"]));
        }
      }
    }
    continue;
  }

  if (obj["type"] !== "assistant") continue;
  const msg = obj["message"] as Record<string, unknown> | undefined;
  if (!msg) continue;

  const usage = msg["usage"] as Record<string, number> | undefined;
  const model = String(msg["model"] ?? "");
  if (usage && (usage["output_tokens"] ?? 0) > 0) {
    assistantTurns++;
    lastUsage = usage;
    if (model) lastModel = model;
  }

  // Track tool_use blocks to detect mid-chain (unmatched) on the final turn.
  lastAssistantHadToolUse = false;
  lastToolUseIds = new Set();
  if (Array.isArray(msg["content"])) {
    for (const block of msg["content"] as Array<Record<string, unknown>>) {
      if (block["type"] === "tool_use" && block["id"]) {
        lastAssistantHadToolUse = true;
        lastToolUseIds.add(String(block["id"]));
      }
    }
  }
}

if (!lastUsage) {
  console.log("{}");
  process.exit(0);
}

// Mid-chain safety: if the final assistant turn emitted tool_use blocks
// without matching tool_result, we're inside a tool chain — bail.
// Bypass with CONTEXT_LOOP_FORCE=1 for testing.
if (lastAssistantHadToolUse && process.env["CONTEXT_LOOP_FORCE"] !== "1") {
  for (const id of lastToolUseIds) {
    if (!toolResultIds.has(id)) {
      console.log("{}");
      process.exit(0);
    }
  }
}

const window = windowFor(lastModel);
const inputTokens = lastUsage["input_tokens"] ?? 0;
const cacheRead = lastUsage["cache_read_input_tokens"] ?? 0;
const cacheCreate = lastUsage["cache_creation_input_tokens"] ?? 0;
const fill = (inputTokens + cacheRead + cacheCreate) / window;

// Read state for cooldown / last-fill tracking.
const stateFile = join(stateDir, `${sessionId || "default"}.json`);
type State = {
  lastFiredTurn: number;
  lastFiredFill: number;
  lastFiredAt: string;
  consecutiveSkips: number;
};
let state: State = {
  lastFiredTurn: -9999,
  lastFiredFill: 0,
  lastFiredAt: "",
  consecutiveSkips: 0,
};
if (existsSync(stateFile)) {
  try {
    state = { ...state, ...JSON.parse(readFileSync(stateFile, "utf8")) };
  } catch {
    /* keep defaults */
  }
}

const turnsSinceLastFire = assistantTurns - state.lastFiredTurn;
const inCooldown = turnsSinceLastFire < cooldownTurns;

let level: "none" | "advisory" | "block" = "none";
if (fill >= blockAt) level = "block";
else if (fill >= advisoryAt && !inCooldown) level = "advisory";

if (level === "none") {
  console.log("{}");
  process.exit(0);
}

// Persist state.
try { mkdirSync(stateDir, { recursive: true }); } catch { /* ok */ }
writeFileSync(
  stateFile,
  JSON.stringify(
    {
      lastFiredTurn: assistantTurns,
      lastFiredFill: fill,
      lastFiredAt: new Date().toISOString(),
      consecutiveSkips: 0,
    },
    null,
    2,
  ),
);

const pct = (fill * 100).toFixed(1);
const head =
  level === "block"
    ? `🛑 context-loop: HARD BLOCK at ${pct}% fill (${(blockAt * 100).toFixed(0)}% threshold). You MUST checkpoint + compact before any further tool use.`
    : `⚠️ context-loop: advisory at ${pct}% fill (${(advisoryAt * 100).toFixed(0)}% threshold). Checkpoint + compact recommended before next major task.`;

const body = [
  head,
  "",
  "**Action:** invoke the `context-loop:checkpoint` skill now. It will:",
  "1. Dispatch a clean-context subagent to write a structured Live State brief from the transcript on disk.",
  "2. Append the brief to claude-mem + the Obsidian daily note for durable recall.",
  "3. Run `/compact <brief>` so the live conversation drops noise but retains the verbatim Live State.",
  "",
  level === "block"
    ? "Do not start new work until compaction completes. claude-mem and Obsidian preserve everything; the live conversation does not need to."
    : "Skip only if you are mid-task and finishing in the next 1–2 turns; otherwise act now.",
].join("\n");

const out = {
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext: body,
  },
};

console.log(JSON.stringify(out));
