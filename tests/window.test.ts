import { describe, it, expect } from "bun:test";
import { windowFor } from "../hooks/context-loop-window";

describe("windowFor", () => {
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

  it("treats Haiku as 200K context", () => {
    expect(windowFor("claude-haiku-4-5-20251001")).toBe(200_000);
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

  it("treats an unset override (empty string, as the gate script exports it) as no override", () => {
    expect(windowFor("claude-sonnet-5", "")).toBe(1_000_000);
    expect(windowFor("claude-haiku-4-5-20251001", "")).toBe(200_000);
  });
});
