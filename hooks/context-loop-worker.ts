#!/usr/bin/env bun
// context-loop worker — decides whether to nudge a checkpoint+compact.
//
// Reads the live transcript, computes context fill % from the most recent
// assistant `usage` block, applies cooldown + mid-chain safety, and emits
// a Claude Code hookSpecificOutput.additionalContext payload when the
// advisory or escalated-advisory threshold is crossed.
//
// `additionalContext` is advisory only — it cannot prevent tool use. Copy
// reflects that. The two tiers (advisory / escalated) differ in urgency,
// not enforcement.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  openWriterDb, recordFire, detectOutcomes, defaultDbPath,
  type FireRow, type PostFireSnapshot,
} from "./context-loop-db";

function breadcrumb(msg: string): void {
  const home = homedir();
  if (!home) return;
  const path = join(home, ".claude", "context-loop-errors.log");
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    appendFileSync(path, new Date().toISOString() + " " + msg + "\n");
  } catch { /* best-effort */ }
}

const [
  , , transcriptPath, stateDir, sessionId,
  advisoryAtRaw, escalatedAtRaw, cooldownTurnsRaw,
  cwdArg, dbPathArg,
] = process.argv;

if (!transcriptPath || !stateDir) {
  console.log("{}");
  process.exit(0);
}

const advisoryAt = parseFloat(advisoryAtRaw ?? "0.35");
const escalatedAt = parseFloat(escalatedAtRaw ?? "0.50");
const cooldownTurns = parseInt(cooldownTurnsRaw ?? "15");

// stop_hook_active is supplied by Claude Code on Stop payloads when the
// hook itself is causing the agent to continue. We never want to fire on
// our own re-entry. Read from STDIN-derived env var if the gate exposed it.
const stopHookActive = process.env["CONTEXT_LOOP_STOP_HOOK_ACTIVE"] === "1";
if (stopHookActive) {
  console.log("{}");
  process.exit(0);
}

// Window resolution: prefer the per-message model field if it carries the
// 1M marker (future-proof); fall back to settings.json since the current
// transcript records bare model names without the suffix.
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
let lastAssistantUuid = "";
let lastAssistantHadToolUse = false;
let lastToolUseIds: Set<string> = new Set();
const toolResultIds: Set<string> = new Set();
const assistantUuids: string[] = [];

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
  const uuid = String(obj["uuid"] ?? "");
  if (usage && (usage["output_tokens"] ?? 0) > 0) {
    assistantTurns++;
    lastUsage = usage;
    if (model) lastModel = model;
    if (uuid) {
      lastAssistantUuid = uuid;
      assistantUuids.push(uuid);
    }
  }

  // Track tool_use blocks on the *final* assistant turn to detect mid-chain.
  // Earlier turns are intentionally not tracked — the matched tool_results
  // accumulator covers them at the transcript level.
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

const dbPath = dbPathArg || defaultDbPath();
const cwd = cwdArg || null;
let analyticsDb: ReturnType<typeof openWriterDb> | null = null;
try {
  analyticsDb = openWriterDb(dbPath);
} catch (err) {
  breadcrumb("openWriterDb failed path=" + dbPath + " err=" + (err instanceof Error ? err.message : String(err)));
  analyticsDb = null;
}

if (analyticsDb && sessionId) {
  const inp = lastUsage["input_tokens"] ?? 0;
  const cr = lastUsage["cache_read_input_tokens"] ?? 0;
  const cw = lastUsage["cache_creation_input_tokens"] ?? 0;
  const w = windowFor(lastModel);
  const snap: PostFireSnapshot = {
    assistantUuids,
    lastTotalTokens: inp + cr + cw,
    lastFillPct: (inp + cr + cw) / w,
    windowSize: w,
  };
  try {
    detectOutcomes(analyticsDb, sessionId, snap, Math.floor(Date.now() / 1000));
  } catch (err) {
    breadcrumb("detectOutcomes threw session=" + sessionId + " err=" + (err instanceof Error ? err.message : String(err)));
  }
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

// State persists by last-fired assistant UUID, not turn count. Turn counts
// reset after `/compact` rewrites the transcript; UUIDs survive (or, if
// they don't, that's the signal that compaction happened and cooldown
// should reset).
const stateFile = join(stateDir, `${sessionId || "default"}.json`);
type State = {
  lastFiredUuid: string;
  lastFiredFill: number;
  lastFiredAt: string;
};
let state: State = {
  lastFiredUuid: "",
  lastFiredFill: 0,
  lastFiredAt: "",
};
if (existsSync(stateFile)) {
  try {
    state = { ...state, ...JSON.parse(readFileSync(stateFile, "utf8")) };
  } catch {
    /* keep defaults */
  }
}

// Cooldown: count assistant turns AFTER the last-fired UUID. If the UUID
// is gone (post-compaction), treat as "no cooldown" — fresh start.
let inCooldown = false;
if (state.lastFiredUuid) {
  const idx = assistantUuids.indexOf(state.lastFiredUuid);
  if (idx >= 0) {
    const turnsSinceFire = assistantUuids.length - 1 - idx;
    inCooldown = turnsSinceFire < cooldownTurns;
  }
  // idx < 0 means compaction rewrote the transcript and dropped the marker.
  // Fall through with inCooldown = false.
}

let level: "none" | "advisory" | "escalated" = "none";
if (fill >= escalatedAt) level = "escalated";
else if (fill >= advisoryAt && !inCooldown) level = "advisory";
// At escalated tier we ignore cooldown — if fill is still that high after
// a recent fire, the agent didn't act on the advisory and needs a louder one.

if (level === "none") {
  if (analyticsDb) try { analyticsDb.close(); } catch { /* ignore */ }
  console.log("{}");
  process.exit(0);
}

if (analyticsDb && sessionId && lastAssistantUuid) {
  const fireRow: FireRow = {
    sessionId,
    cwd,
    firedAt: Math.floor(Date.now() / 1000),
    level,
    fillPct: fill,
    inputTokens,
    cacheRead,
    cacheCreate,
    windowSize: window,
    model: lastModel || null,
    assistantUuid: lastAssistantUuid,
    thresholdAdvisory: advisoryAt,
    thresholdEscalated: escalatedAt,
  };
  try {
    const fireId = recordFire(analyticsDb, fireRow);
    if (fireId === null) {
      breadcrumb("fires_duplicate session=" + sessionId + " uuid=" + lastAssistantUuid);
    }
  } catch (err) {
    breadcrumb("recordFire threw session=" + sessionId + " err=" + (err instanceof Error ? err.message : String(err)));
  }
}
if (analyticsDb) {
  try {
    analyticsDb.close();
  } catch (err) {
    breadcrumb("db.close threw err=" + (err instanceof Error ? err.message : String(err)));
  }
}

const pct = (fill * 100).toFixed(1);
const head =
  level === "escalated"
    ? `⚠️⚠️ context-loop: ESCALATED advisory at ${pct}% fill (${(escalatedAt * 100).toFixed(0)}% threshold). Effectiveness is degraded; checkpoint + compact before continuing.`
    : `⚠️ context-loop: advisory at ${pct}% fill (${(advisoryAt * 100).toFixed(0)}% threshold). Checkpoint + compact recommended before next major task.`;

const body = [
  head,
  "",
  "**Action:** invoke the `checkpoint` skill from the context-loop plugin. It will:",
  "1. Dispatch a clean-context subagent that produces a verbatim Live State brief from the transcript.",
  "2. Append the brief to today's Obsidian daily note and to `state/checkpoints/` for durable recall.",
  "3. Run `/compact` so the live conversation sheds noise; the brief is then re-stated as a user message so the post-compact agent sees it intact.",
  "",
  level === "escalated"
    ? "Do this now. claude-mem and Obsidian preserve everything; the live conversation does not need to."
    : "Skip only if you're mid-task and finishing in 1–2 turns; otherwise act now.",
].join("\n");

const out = {
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext: body,
  },
};

console.log(JSON.stringify(out));

// Persist cooldown state AFTER emitting the advisory. State write is
// best-effort bookkeeping; a failure here must never swallow the user-visible nudge.
try {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify(
      {
        lastFiredUuid: lastAssistantUuid,
        lastFiredFill: fill,
        lastFiredAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
} catch (err) {
  breadcrumb("stateFile write failed path=" + stateFile + " err=" + (err instanceof Error ? err.message : String(err)));
}
