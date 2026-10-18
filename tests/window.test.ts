import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { windowFor, clampFill, errorLogPath, breadcrumb } from "../hooks/context-loop-window";

describe("windowFor", () => {
  let tmpDir: string;
  let logFile: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env["CONTEXT_LOOP_ERROR_LOG"];
    tmpDir = mkdtempSync(join(tmpdir(), "context-loop-window-test-"));
    logFile = join(tmpDir, "context-loop-errors.log");
    process.env["CONTEXT_LOOP_ERROR_LOG"] = logFile;
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env["CONTEXT_LOOP_ERROR_LOG"];
    } else {
      process.env["CONTEXT_LOOP_ERROR_LOG"] = prevEnv;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });
  it("treats Sonnet 5 as 1M context", () => {
    expect(windowFor("claude-sonnet-5")).toBe(1_000_000);
  });

  it("treats Sonnet 4.6 as 1M context", () => {
    expect(windowFor("claude-sonnet-4-6")).toBe(1_000_000);
  });

  it("treats a date-suffixed Sonnet 4.6 id as 1M context", () => {
    expect(windowFor("claude-sonnet-4-6-20260201")).toBe(1_000_000);
  });

  it("treats Sonnet 4.5 as 200K context, not 1M", () => {
    expect(windowFor("claude-sonnet-4-5-20250929")).toBe(200_000);
  });

  it("treats a bare, version-less 'sonnet' id as 200K, not 1M", () => {
    expect(windowFor("sonnet")).toBe(200_000);
  });

  it("treats Opus as 1M context", () => {
    expect(windowFor("claude-opus-4-7")).toBe(1_000_000);
  });

  it("treats Fable as 1M context", () => {
    expect(windowFor("claude-fable-5-1")).toBe(1_000_000);
  });

  it("treats Mythos as 1M context", () => {
    expect(windowFor("claude-mythos-5")).toBe(1_000_000);
  });

  it("treats Haiku 4.5 as 200K context, not 1M", () => {
    expect(windowFor("claude-haiku-4-5-20251001")).toBe(200_000);
  });

  it("treats Haiku 5.5 as 1M context", () => {
    expect(windowFor("claude-haiku-5-5")).toBe(1_000_000);
  });

  it("treats a date-suffixed Haiku 5 id as 1M context", () => {
    expect(windowFor("claude-haiku-5-20261007")).toBe(1_000_000);
  });

  it("keeps a legacy claude-3-5-haiku id at 200K, not 1M", () => {
    expect(windowFor("claude-3-5-haiku-20241022")).toBe(200_000);
  });

  it("keeps a bare, version-less 'haiku' id at 200K, not 1M", () => {
    expect(windowFor("haiku")).toBe(200_000);
  });

  it("defaults unknown/empty model strings to 200K", () => {
    expect(windowFor("")).toBe(200_000);
    expect(windowFor("something-unrecognized")).toBe(200_000);
  });

  it("honors an explicit env override over the model guess", () => {
    expect(windowFor("claude-haiku-4-5-20251001", "500000")).toBe(500_000);
  });

  it("ignores a non-numeric or non-positive override", () => {
    expect(windowFor("claude-sonnet-5", "not-a-number")).toBe(1_000_000);
    expect(windowFor("claude-haiku-4-5-20251001", "0")).toBe(200_000);
  });

  it("rejects a digits-with-suffix override like '1m' and logs it", () => {
    expect(windowFor("claude-haiku-4-5-20251001", "1m")).toBe(200_000);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("windowFor ignoring CONTEXT_LOOP_WINDOW=1m");
  });

  it("rejects a completely non-numeric override like 'abc' and logs it", () => {
    expect(windowFor("claude-haiku-4-5-20251001", "abc")).toBe(200_000);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("windowFor ignoring CONTEXT_LOOP_WINDOW=abc");
  });

  it("rejects a zero override and logs it", () => {
    expect(windowFor("claude-haiku-4-5-20251001", "0")).toBe(200_000);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("windowFor ignoring CONTEXT_LOOP_WINDOW=0");
  });

  it("rejects a digit string long enough to parse as Infinity", () => {
    expect(windowFor("claude-haiku-4-5-20251001", "9".repeat(400))).toBe(200_000);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("windowFor ignoring CONTEXT_LOOP_WINDOW=");
  });

  it("rejects a '1m' override on a 1M model instead of returning 1", () => {
    expect(windowFor("claude-sonnet-5", "1m")).toBe(1_000_000);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("windowFor ignoring CONTEXT_LOOP_WINDOW=1m");
  });

  it("rejects a whitespace-padded override that parseInt used to accept", () => {
    expect(windowFor("claude-haiku-4-5-20251001", " 500000")).toBe(200_000);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("windowFor ignoring CONTEXT_LOOP_WINDOW=");
  });

  it("treats an unset override (empty string, as the gate script exports it) as no override", () => {
    expect(windowFor("claude-sonnet-5", "")).toBe(1_000_000);
    expect(windowFor("claude-haiku-4-5-20251001", "")).toBe(200_000);
    expect(existsSync(logFile)).toBe(false);
  });

  it("logs unmatched model id at fallback to error log", () => {
    windowFor("unrecognized-model-123");
    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("windowFor fallback model=unrecognized-model-123 window=200000");
  });

  it("logs model=unknown when fallback model string is empty", () => {
    windowFor("");
    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("windowFor fallback model=unknown window=200000");
  });

  it("does not log fallback when a 1M model is matched", () => {
    windowFor("claude-sonnet-5");
    windowFor("claude-opus-4-7");
    windowFor("claude-haiku-5-5");
    expect(existsSync(logFile)).toBe(false);
  });

  it("does not log fallback for known 200K generations", () => {
    windowFor("claude-sonnet-4-5-20250929");
    windowFor("claude-haiku-4-5-20251001");
    windowFor("claude-3-5-haiku-20241022");
    expect(existsSync(logFile)).toBe(false);
  });

  it("does not log fallback when an explicit env override is active", () => {
    windowFor("unrecognized-model-123", "500000");
    expect(existsSync(logFile)).toBe(false);
  });
});

describe("clampFill", () => {
  it("caps any finite fraction above 1.0 at 1.0", () => {
    expect(clampFill(1.24)).toBe(1);
    expect(clampFill(99)).toBe(1);
  });

  it("treats +Infinity as over the ceiling", () => {
    expect(clampFill(Infinity)).toBe(1);
  });

  it("passes sub-cap fractions through unchanged", () => {
    expect(clampFill(0)).toBe(0);
    expect(clampFill(0.35)).toBe(0.35);
    expect(clampFill(0.999)).toBe(0.999);
  });

  it("keeps exactly 1.0 at 1.0", () => {
    expect(clampFill(1)).toBe(1);
  });

  it("floors negatives, -Infinity and NaN at 0", () => {
    expect(clampFill(-0.5)).toBe(0);
    expect(clampFill(-Infinity)).toBe(0);
    expect(clampFill(NaN)).toBe(0);
  });
});

describe("breadcrumb", () => {
  let tmpDir: string;
  let logFile: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env["CONTEXT_LOOP_ERROR_LOG"];
    tmpDir = mkdtempSync(join(tmpdir(), "context-loop-breadcrumb-test-"));
    logFile = join(tmpDir, "sub", "test.log");
    process.env["CONTEXT_LOOP_ERROR_LOG"] = logFile;
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env["CONTEXT_LOOP_ERROR_LOG"];
    } else {
      process.env["CONTEXT_LOOP_ERROR_LOG"] = prevEnv;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends timestamped message to the configured error log path", () => {
    breadcrumb("test message");
    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf8");
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T.* test message\n$/);
  });

  it("resolves CONTEXT_LOOP_ERROR_LOG from environment", () => {
    expect(errorLogPath()).toBe(logFile);
  });
});
