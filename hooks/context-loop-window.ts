import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export function errorLogPath(): string {
  const env = process.env["CONTEXT_LOOP_ERROR_LOG"];
  if (env) return env;
  const home = process.env["HOME"] || homedir();
  return home ? join(home, ".claude", "context-loop-errors.log") : "";
}

export function breadcrumb(msg: string): void {
  const p = errorLogPath();
  if (!p) return;
  try {
    mkdirSync(join(p, ".."), { recursive: true });
    appendFileSync(p, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* best-effort */ }
}

// Known 200K generations: expected, so the fallback breadcrumb skips them.
const KNOWN_200K = ["sonnet-4-5", "haiku-4-5", "3-5-haiku"];

// Context-window size lookup by model id, with an env override.
//
// Model ids embed their generation precisely (e.g. "claude-sonnet-5",
// "claude-sonnet-4-6", "claude-sonnet-4-5-20250929"), so matching on the
// version-tagged substring — not a bare family name — tells a 1M-context
// Sonnet apart from a 200K one without guessing.
export function windowFor(model: string, envOverride?: string): number {
  // Strict digits-only parse. parseInt accepted "1m" as 1, silently pinning
  // fill at 100% every turn. Any rejected non-empty override gets a
  // breadcrumb so the log blames the override, not the model fallback.
  const raw = envOverride ?? "";
  if (/^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (parsed > 0) return parsed;
  }
  if (raw !== "") {
    breadcrumb("windowFor ignoring CONTEXT_LOOP_WINDOW=" + raw);
  }
  const m = (model || "").toLowerCase();
  // 1M-context families: Opus (4.5+), Fable 5, Mythos 5, Sonnet 5 (and
  // later 5.x), Sonnet 4.6, and Haiku 5 (see #13). Haiku 4.5 and Sonnet 4.5
  // (both 200K) fall through to the default.
  //
  // Add new 1M generations here (e.g. haiku-6, sonnet-6) — the version-tagged
  // pin is deliberate so a 200K generation of the same family stays 200K.
  if (m.includes("opus") || m.includes("fable") || m.includes("mythos")) return 1_000_000;
  if (m.includes("sonnet-5") || m.includes("sonnet-4-6")) return 1_000_000;
  if (m.includes("haiku-5")) return 1_000_000;
  if (KNOWN_200K.some((id) => m.includes(id))) return 200_000;
  breadcrumb("windowFor fallback model=" + (model || "unknown") + " window=200000");
  return 200_000;
}

// Usage can exceed the assumed window (misdetected window, provider figure
// above our assumption, unrecognized compaction shape). Fill that gets
// displayed or thresholded goes through here; raw token sums stay available
// for anything that compares usage over time.
export function clampFill(fraction: number): number {
  if (Number.isNaN(fraction) || fraction < 0) return 0;
  return Math.min(1, fraction);
}
