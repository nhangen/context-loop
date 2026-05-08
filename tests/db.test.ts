import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initSchema, recordFire, recordOutcome, detectOutcomes, unresolvedFires,
  assertSchemaCompatible, SCHEMA_VERSION,
  type FireRow, type PostFireSnapshot, type OutcomeRow,
} from "../hooks/context-loop-db";

function freshDb(): Database {
  const db = new Database(":memory:");
  initSchema(db);
  return db;
}

const baseFire: FireRow = {
  sessionId: "S1",
  cwd: "/proj",
  firedAt: 1_000,
  level: "advisory",
  fillPct: 0.45,
  inputTokens: 5_000,
  cacheRead: 80_000,
  cacheCreate: 5_000,    // pre-total = 90_000
  windowSize: 200_000,
  model: "claude-opus-4-7",
  assistantUuid: "uuid-A",
  thresholdAdvisory: 0.35,
  thresholdEscalated: 0.5,
};

describe("recordFire", () => {
  it("inserts a row and returns id", () => {
    const db = freshDb();
    const id = recordFire(db, baseFire);
    expect(id).toBeNumber();
    const row = db.query<{ session_id: string; level: string }, []>(
      "SELECT session_id, level FROM fire_events"
    ).get();
    expect(row?.session_id).toBe("S1");
  });

  it("is idempotent on (session_id, assistant_uuid) — repeat insert returns null", () => {
    const db = freshDb();
    const first = recordFire(db, baseFire);
    const second = recordFire(db, baseFire);
    expect(first).toBeNumber();
    expect(second).toBeNull();
    const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM fire_events").get();
    expect(count?.n).toBe(1);
  });
});

describe("detectOutcomes — UUID-lost (compaction rewrote transcript)", () => {
  it("records acted=1, method=uuid_lost when fire's uuid is gone", () => {
    const db = freshDb();
    const id = recordFire(db, baseFire);
    expect(id).toBeNumber();

    const snap: PostFireSnapshot = {
      assistantUuids: ["uuid-NEW-1", "uuid-NEW-2"],   // uuid-A is missing
      lastTotalTokens: 30_000,
      lastFillPct: 0.15,
      windowSize: 200_000,
      hasCompactSummary: true,
    };
    const outcomes = detectOutcomes(db, "S1", snap, 2_000);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.acted).toBe(1);
    expect(outcomes[0]!.detectionMethod).toBe("uuid_lost");
    expect(outcomes[0]!.tokensReclaimed).toBe(60_000);  // 90_000 − 30_000
  });
});

describe("detectOutcomes — uuid_lost gated by compact summary", () => {
  it("does NOT record uuid_lost when fire's uuid is gone but transcript has no isCompactSummary", () => {
    const db = freshDb();
    recordFire(db, baseFire);
    const snap: PostFireSnapshot = {
      assistantUuids: ["uuid-NEW-1", "uuid-NEW-2"],   // uuid-A wiped (e.g., /clear)
      lastTotalTokens: 30_000,
      lastFillPct: 0.15,
      windowSize: 200_000,
      hasCompactSummary: false,
    };
    const outcomes = detectOutcomes(db, "S1", snap, 2_000);
    expect(outcomes).toHaveLength(0);
    expect(unresolvedFires(db, "S1")).toHaveLength(1);
  });
});

describe("detectOutcomes — fill-drop corroboration", () => {
  it("records acted=1 when uuid still present but fill dropped >=40pp", () => {
    const db = freshDb();
    recordFire(db, baseFire);
    const snap: PostFireSnapshot = {
      assistantUuids: ["uuid-A", "uuid-B"],
      lastTotalTokens: 8_000,
      lastFillPct: 0.04,                     // 0.45 − 0.04 = 0.41 drop
      windowSize: 200_000,
      hasCompactSummary: false,
    };
    const outcomes = detectOutcomes(db, "S1", snap, 2_000);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.detectionMethod).toBe("fill_drop_corroborated");
    expect(outcomes[0]!.turnsUntilAction).toBe(1);
  });

  it("does not record when fill drop is below threshold and not yet timed out", () => {
    const db = freshDb();
    recordFire(db, baseFire);
    const snap: PostFireSnapshot = {
      assistantUuids: ["uuid-A", "uuid-B"],
      lastTotalTokens: 80_000,
      lastFillPct: 0.40,                     // only 5pp drop
      windowSize: 200_000,
      hasCompactSummary: false,
    };
    const outcomes = detectOutcomes(db, "S1", snap, 2_000);
    expect(outcomes).toHaveLength(0);
    expect(unresolvedFires(db, "S1")).toHaveLength(1);
  });
});

describe("detectOutcomes — timeout", () => {
  it("records acted=0, method=timeout when no action within timeoutTurns", () => {
    const db = freshDb();
    recordFire(db, baseFire);
    const uuids = ["uuid-A"];
    for (let i = 0; i < 30; i++) uuids.push(`later-${i}`);
    const snap: PostFireSnapshot = {
      assistantUuids: uuids,
      lastTotalTokens: 95_000,
      lastFillPct: 0.475,                    // ~no drop
      windowSize: 200_000,
      hasCompactSummary: false,
    };
    const outcomes = detectOutcomes(db, "S1", snap, 2_000, 30);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.acted).toBe(0);
    expect(outcomes[0]!.detectionMethod).toBe("timeout");
    expect(outcomes[0]!.tokensReclaimed).toBeNull();
  });
});

describe("detectOutcomes — idempotency", () => {
  it("does not re-record outcome on subsequent runs", () => {
    const db = freshDb();
    recordFire(db, baseFire);
    const snap: PostFireSnapshot = {
      assistantUuids: ["uuid-NEW"],
      lastTotalTokens: 30_000,
      lastFillPct: 0.15,
      windowSize: 200_000,
      hasCompactSummary: true,
    };
    const first = detectOutcomes(db, "S1", snap, 2_000);
    const second = detectOutcomes(db, "S1", snap, 3_000);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    const count = db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM compaction_outcomes"
    ).get();
    expect(count?.n).toBe(1);
  });
});

describe("schema versioning", () => {
  it("writes schema_version into meta table", () => {
    const db = freshDb();
    const row = db.query<{ value: string }, []>(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    ).get();
    expect(row?.value).toBe("1");
  });

  it("refuses to open a db whose schema_version is newer than this binary", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.query("INSERT INTO meta(key, value) VALUES (?, ?)").run(
      "schema_version", String(SCHEMA_VERSION + 1),
    );
    expect(() => assertSchemaCompatible(db)).toThrow(/newer than this binary/);
  });

  it("re-running initSchema preserves the original schema_version row (no downgrade)", () => {
    const db = freshDb();
    initSchema(db);
    const rows = db.query<{ value: string }, []>(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    ).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(String(SCHEMA_VERSION));
  });
});

describe("schema constraints", () => {
  it("rejects fire_events.level outside the allowed enum", () => {
    const db = freshDb();
    const bogus: FireRow = { ...baseFire, level: "warning" as FireRow["level"] };
    expect(() => recordFire(db, bogus)).toThrow();
  });

  it("rejects compaction_outcomes.detection_method outside the allowed enum", () => {
    const db = freshDb();
    const id = recordFire(db, baseFire)!;
    const bogus: OutcomeRow = {
      fireEventId: id,
      acted: 1,
      detectedAt: 2_000,
      preFillPct: 0.45,
      postFillPct: 0.10,
      tokensReclaimed: 60_000,
      turnsUntilAction: null,
      detectionMethod: "guessed" as OutcomeRow["detectionMethod"],
    };
    expect(() => recordOutcome(db, bogus)).toThrow();
  });

  it("rejects negative tokens_reclaimed at the storage layer", () => {
    const db = freshDb();
    const id = recordFire(db, baseFire)!;
    expect(() => recordOutcome(db, {
      fireEventId: id,
      acted: 1,
      detectedAt: 2_000,
      preFillPct: 0.45,
      postFillPct: 0.50,
      tokensReclaimed: -100 as unknown as number,
      turnsUntilAction: null,
      detectionMethod: "uuid_lost",
    })).toThrow();
  });
});

describe("recordOutcome — surfaces double-detect", () => {
  it("throws on duplicate insert rather than silently overwriting", () => {
    const db = freshDb();
    const id = recordFire(db, baseFire)!;
    const first: OutcomeRow = {
      fireEventId: id, acted: 1, detectedAt: 2_000,
      preFillPct: 0.45, postFillPct: 0.10, tokensReclaimed: 60_000,
      turnsUntilAction: null, detectionMethod: "uuid_lost",
    };
    recordOutcome(db, first);
    expect(() => recordOutcome(db, { ...first, acted: 0, detectionMethod: "timeout", tokensReclaimed: null })).toThrow();
  });
});

describe("detectOutcomes — negative tokensReclaimed coerced to null", () => {
  it("does not write a negative reclaimed value (post > pre cache-warm case)", () => {
    const db = freshDb();
    recordFire(db, baseFire);
    const snap: PostFireSnapshot = {
      assistantUuids: ["uuid-NEW"],
      lastTotalTokens: 120_000,
      lastFillPct: 0.10,
      windowSize: 200_000,
      hasCompactSummary: true,
    };
    const outcomes = detectOutcomes(db, "S1", snap, 2_000);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.tokensReclaimed).toBeNull();
  });
});
