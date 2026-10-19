import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  windowFor, clampFill, errorLogPath, breadcrumb,
  parseThreshold, parseCooldownTurns,
  validateThresholds, DEFAULT_ADVISORY_AT, DEFAULT_ESCALATED_AT,
} from "../hooks/context-loop-window";

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

  it("sanitizes a rejected override so it cannot forge log lines", () => {
    windowFor("claude-haiku-4-5-20251001", "500\nfill over window raw=1.000 window=1000000");
    const content = readFileSync(logFile, "utf8");
    expect(content.split("\n").filter(Boolean).length).toBe(1);
    expect(content).toContain("500 fill over window raw=1.000 window=1000000");
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

  it("collapses newlines in any message so callers cannot forge log lines", () => {
    breadcrumb("db open failed: boom\nforged line");
    const content = readFileSync(logFile, "utf8");
    expect(content.split("\n").filter(Boolean).length).toBe(1);
    expect(content).toContain("boom forged line");
  });

  it("resolves CONTEXT_LOOP_ERROR_LOG from environment", () => {
    expect(errorLogPath()).toBe(logFile);
  });

  it("falls back to process.stderr.write when error log path is unwritable", () => {
    const originalWrite = process.stderr.write;
    let written = "";
    process.stderr.write = ((chunk: any) => {
      written += String(chunk);
      return true;
    }) as any;
    try {
      // /dev/null cannot have child directories, so mkdirSync throws ENOTDIR
      process.env["CONTEXT_LOOP_ERROR_LOG"] = "/dev/null/impossible/path.log";
      breadcrumb("fallback to stderr test");
      expect(written).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ fallback to stderr test\n$/);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it("survives when both appendFileSync and stderr.write fail", () => {
    const originalWrite = process.stderr.write;
    process.stderr.write = (() => {
      throw new Error("EPIPE");
    }) as any;
    try {
      process.env["CONTEXT_LOOP_ERROR_LOG"] = "/dev/null/impossible/path.log";
      expect(() => breadcrumb("best-effort survives")).not.toThrow();
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});

describe("parseThreshold", () => {
  let tmpDir: string;
  let logFile: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env["CONTEXT_LOOP_ERROR_LOG"];
    tmpDir = mkdtempSync(join(tmpdir(), "context-loop-threshold-test-"));
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

  it("accepts valid decimal threshold", () => {
    expect(parseThreshold("0.35", "CONTEXT_LOOP_ADVISORY_AT", 0.35)).toBe(0.35);
    expect(parseThreshold("0.5", "CONTEXT_LOOP_ESCALATED_AT", 0.5)).toBe(0.5);
    expect(existsSync(logFile)).toBe(false);
  });

  it("accepts 1 and 1.0 (100% threshold)", () => {
    expect(parseThreshold("1", "CONTEXT_LOOP_ESCALATED_AT", 0.5)).toBe(1);
    expect(parseThreshold("1.0", "CONTEXT_LOOP_ESCALATED_AT", 0.5)).toBe(1);
    expect(existsSync(logFile)).toBe(false);
  });

  it("accepts leading-dot decimal notation", () => {
    expect(parseThreshold(".45", "CONTEXT_LOOP_ADVISORY_AT", 0.35)).toBe(0.45);
    expect(existsSync(logFile)).toBe(false);
  });

  it("rejects a typoed threshold like 'x0.45' and logs it", () => {
    expect(parseThreshold("x0.45", "CONTEXT_LOOP_ADVISORY_AT", 0.35)).toBe(0.35);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("parseThreshold ignoring CONTEXT_LOOP_ADVISORY_AT=x0.45");
  });

  it("rejects threshold with trailing chars like '0.45abc' and logs it", () => {
    expect(parseThreshold("0.45abc", "CONTEXT_LOOP_ADVISORY_AT", 0.35)).toBe(0.35);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("parseThreshold ignoring CONTEXT_LOOP_ADVISORY_AT=0.45abc");
  });

  it("rejects whitespace-padded threshold and logs it", () => {
    expect(parseThreshold(" 0.35", "CONTEXT_LOOP_ADVISORY_AT", 0.35)).toBe(0.35);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("parseThreshold ignoring CONTEXT_LOOP_ADVISORY_AT= 0.35");
  });

  it("rejects a zero or negative threshold and logs it", () => {
    expect(parseThreshold("0", "CONTEXT_LOOP_ADVISORY_AT", 0.35)).toBe(0.35);
    expect(parseThreshold("-0.5", "CONTEXT_LOOP_ADVISORY_AT", 0.35)).toBe(0.35);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("parseThreshold ignoring CONTEXT_LOOP_ADVISORY_AT=0");
    expect(content).toContain("parseThreshold ignoring CONTEXT_LOOP_ADVISORY_AT=-0.5");
  });

  it("rejects a threshold above 1.0 and logs it", () => {
    expect(parseThreshold("1.5", "CONTEXT_LOOP_ADVISORY_AT", 0.35)).toBe(0.35);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("parseThreshold ignoring CONTEXT_LOOP_ADVISORY_AT=1.5");
  });

  it("rejects string that parses to Infinity and logs it", () => {
    expect(parseThreshold("9".repeat(400), "CONTEXT_LOOP_ADVISORY_AT", 0.35)).toBe(0.35);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("parseThreshold ignoring CONTEXT_LOOP_ADVISORY_AT=");
  });

  it("sanitizes rejected threshold so it cannot forge log lines", () => {
    parseThreshold("0.45\nforged error line", "CONTEXT_LOOP_ADVISORY_AT", 0.35);
    const content = readFileSync(logFile, "utf8");
    expect(content.split("\n").filter(Boolean).length).toBe(1);
    expect(content).toContain("0.45 forged error line");
  });

  it("caps the logged rejected value at 200 characters", () => {
    parseCooldownTurns("x".repeat(500), "CONTEXT_LOOP_COOLDOWN_TURNS", 15);
    const line = readFileSync(logFile, "utf8").trimEnd();
    expect(line.endsWith("=" + "x".repeat(200))).toBe(true);
  });

  it("treats unset or empty override as default without logging", () => {
    expect(parseThreshold("", "CONTEXT_LOOP_ADVISORY_AT", 0.35)).toBe(0.35);
    expect(parseThreshold(undefined, "CONTEXT_LOOP_ADVISORY_AT", 0.35)).toBe(0.35);
    expect(existsSync(logFile)).toBe(false);
  });
});

describe("parseCooldownTurns", () => {
  let tmpDir: string;
  let logFile: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env["CONTEXT_LOOP_ERROR_LOG"];
    tmpDir = mkdtempSync(join(tmpdir(), "context-loop-cooldown-test-"));
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

  it("accepts valid positive integer turns", () => {
    expect(parseCooldownTurns("15", "CONTEXT_LOOP_COOLDOWN_TURNS", 15)).toBe(15);
    expect(parseCooldownTurns("5", "CONTEXT_LOOP_COOLDOWN_TURNS", 15)).toBe(5);
    expect(existsSync(logFile)).toBe(false);
  });

  it("rejects non-numeric override like 'abc' and logs it", () => {
    expect(parseCooldownTurns("abc", "CONTEXT_LOOP_COOLDOWN_TURNS", 15)).toBe(15);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("parseCooldownTurns ignoring CONTEXT_LOOP_COOLDOWN_TURNS=abc");
  });

  it("rejects suffix like '15turns' and logs it", () => {
    expect(parseCooldownTurns("15turns", "CONTEXT_LOOP_COOLDOWN_TURNS", 15)).toBe(15);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("parseCooldownTurns ignoring CONTEXT_LOOP_COOLDOWN_TURNS=15turns");
  });

  it("rejects zero and logs it", () => {
    expect(parseCooldownTurns("0", "CONTEXT_LOOP_COOLDOWN_TURNS", 15)).toBe(15);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("parseCooldownTurns ignoring CONTEXT_LOOP_COOLDOWN_TURNS=0");
  });

  it("rejects negative integer and logs it", () => {
    expect(parseCooldownTurns("-5", "CONTEXT_LOOP_COOLDOWN_TURNS", 15)).toBe(15);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("parseCooldownTurns ignoring CONTEXT_LOOP_COOLDOWN_TURNS=-5");
  });

  it("rejects decimal number and logs it", () => {
    expect(parseCooldownTurns("15.5", "CONTEXT_LOOP_COOLDOWN_TURNS", 15)).toBe(15);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("parseCooldownTurns ignoring CONTEXT_LOOP_COOLDOWN_TURNS=15.5");
  });

  it("rejects whitespace-padded turns and logs it", () => {
    expect(parseCooldownTurns(" 15", "CONTEXT_LOOP_COOLDOWN_TURNS", 15)).toBe(15);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("parseCooldownTurns ignoring CONTEXT_LOOP_COOLDOWN_TURNS= 15");
  });

  it("rejects string that parses to Infinity and logs it", () => {
    expect(parseCooldownTurns("9".repeat(400), "CONTEXT_LOOP_COOLDOWN_TURNS", 15)).toBe(15);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("parseCooldownTurns ignoring CONTEXT_LOOP_COOLDOWN_TURNS=");
  });

  it("sanitizes rejected turns so it cannot forge log lines", () => {
    parseCooldownTurns("15\nforged error line", "CONTEXT_LOOP_COOLDOWN_TURNS", 15);
    const content = readFileSync(logFile, "utf8");
    expect(content.split("\n").filter(Boolean).length).toBe(1);
    expect(content).toContain("15 forged error line");
  });

  it("treats unset or empty override as default without logging", () => {
    expect(parseCooldownTurns("", "CONTEXT_LOOP_COOLDOWN_TURNS", 15)).toBe(15);
    expect(parseCooldownTurns(undefined, "CONTEXT_LOOP_COOLDOWN_TURNS", 15)).toBe(15);
    expect(existsSync(logFile)).toBe(false);
  });
});

describe("validateThresholds", () => {
  let tmpDir: string;
  let logFile: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env["CONTEXT_LOOP_ERROR_LOG"];
    tmpDir = mkdtempSync(join(tmpdir(), "context-loop-validate-test-"));
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

  it("accepts valid thresholds where advisory < escalated without logging", () => {
    expect(validateThresholds(0.35, 0.50)).toEqual([0.35, 0.50]);
    expect(existsSync(logFile)).toBe(false);
  });

  it("rejects advisory > escalated, logs breadcrumb, and falls back both to defaults", () => {
    expect(validateThresholds(0.9, 0.5)).toEqual([DEFAULT_ADVISORY_AT, DEFAULT_ESCALATED_AT]);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("validateThresholds ignoring CONTEXT_LOOP_ADVISORY_AT=0.9 >= CONTEXT_LOOP_ESCALATED_AT=0.5; using defaults advisory=0.35 escalated=0.5");
  });

  it("rejects advisory === escalated (e.g. 0.5 and 0.5), logs breadcrumb, and falls back both to defaults", () => {
    expect(validateThresholds(0.5, 0.5)).toEqual([DEFAULT_ADVISORY_AT, DEFAULT_ESCALATED_AT]);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("validateThresholds ignoring CONTEXT_LOOP_ADVISORY_AT=0.5 >= CONTEXT_LOOP_ESCALATED_AT=0.5; using defaults advisory=0.35 escalated=0.5");
  });

  it("names the variables it was given, so a legacy alias is blamed under its own name", () => {
    expect(validateThresholds(0.35, 0.3, "CONTEXT_LOOP_ADVISORY_AT", "CONTEXT_LOOP_BLOCK_AT"))
      .toEqual([DEFAULT_ADVISORY_AT, DEFAULT_ESCALATED_AT]);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("validateThresholds ignoring CONTEXT_LOOP_ADVISORY_AT=0.35 >= CONTEXT_LOOP_BLOCK_AT=0.3; using defaults advisory=0.35 escalated=0.5");
  });
});
