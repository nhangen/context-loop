import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync, appendFileSync } from "fs";
import { homedir } from "os";

export const SCHEMA_VERSION = 1;

function errorLogPath(): string {
  const home = homedir();
  return home ? join(home, ".claude", "context-loop-errors.log") : "";
}

function breadcrumb(msg: string): void {
  const p = errorLogPath();
  if (!p) return;
  try {
    mkdirSync(join(p, ".."), { recursive: true });
    appendFileSync(p, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* best-effort */ }
}

export interface FireRow {
  sessionId: string;
  cwd: string | null;
  firedAt: number;
  level: "advisory" | "escalated";
  fillPct: number;
  inputTokens: number;
  cacheRead: number;
  cacheCreate: number;
  windowSize: number;
  model: string | null;
  assistantUuid: string;
  thresholdAdvisory: number;
  thresholdEscalated: number;
}

export interface OutcomeRow {
  fireEventId: number;
  acted: 0 | 1;
  detectedAt: number | null;
  preFillPct: number;
  postFillPct: number | null;
  tokensReclaimed: number | null;
  turnsUntilAction: number | null;
  detectionMethod: "uuid_lost" | "fill_drop_corroborated" | "timeout";
}

export interface UnresolvedFire {
  id: number;
  assistantUuid: string;
  firedAt: number;
  fillPct: number;
  inputTokens: number;
  cacheRead: number;
  cacheCreate: number;
  windowSize: number;
}

export interface PostFireSnapshot {
  assistantUuids: string[];
  lastTotalTokens: number;
  lastFillPct: number;
  windowSize: number;
}

const DEFAULT_TIMEOUT_TURNS = 30;

export function defaultDbPath(): string {
  const home = homedir();
  if (!home) {
    throw new Error("context-loop: HOME is empty; refusing to compute default db path");
  }
  return join(home, ".claude", "context-loop.db");
}

export function openWriterDb(path: string): Database {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  initSchema(db);
  return db;
}

export function assertSchemaCompatible(db: Database): void {
  const row = db.query<{ value: string }, []>(
    "SELECT value FROM meta WHERE key = 'schema_version'",
  ).get();
  if (!row) return;
  const found = parseInt(row.value, 10);
  if (Number.isNaN(found)) {
    throw new Error("context-loop: meta.schema_version is not numeric: " + row.value);
  }
  if (found > SCHEMA_VERSION) {
    throw new Error(
      "context-loop: db schema_version=" + found +
      " is newer than this binary (" + SCHEMA_VERSION + "); refusing to write",
    );
  }
}

export function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fire_events (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      cwd TEXT,
      fired_at INTEGER NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('advisory','escalated')),
      fill_pct REAL NOT NULL,
      input_tokens INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      cache_create INTEGER NOT NULL,
      window_size INTEGER NOT NULL,
      model TEXT,
      assistant_uuid TEXT NOT NULL,
      threshold_advisory REAL NOT NULL,
      threshold_escalated REAL NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS fire_events_session_uuid
      ON fire_events(session_id, assistant_uuid);
    CREATE INDEX IF NOT EXISTS fire_events_session
      ON fire_events(session_id, fired_at);
    CREATE TABLE IF NOT EXISTS compaction_outcomes (
      fire_event_id INTEGER PRIMARY KEY REFERENCES fire_events(id),
      acted INTEGER NOT NULL,
      detected_at INTEGER,
      pre_fill_pct REAL NOT NULL,
      post_fill_pct REAL,
      tokens_reclaimed INTEGER CHECK (tokens_reclaimed IS NULL OR tokens_reclaimed >= 0),
      turns_until_action INTEGER,
      detection_method TEXT NOT NULL
        CHECK (detection_method IN ('uuid_lost','fill_drop_corroborated','timeout'))
    );
  `);
  assertSchemaCompatible(db);
  db.query("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)")
    .run("schema_version", String(SCHEMA_VERSION));
}

const ALLOWED_LEVELS = new Set<FireRow["level"]>(["advisory", "escalated"]);
const ALLOWED_METHODS = new Set<OutcomeRow["detectionMethod"]>([
  "uuid_lost", "fill_drop_corroborated", "timeout",
]);

export function recordFire(db: Database, row: FireRow): number | null {
  if (!ALLOWED_LEVELS.has(row.level)) {
    throw new Error("context-loop: refusing to record fire with unknown level: " + row.level);
  }
  const stmt = db.query<{ id: number }, [
    string, string | null, number, string, number,
    number, number, number, number, string | null, string, number, number,
  ]>(`
    INSERT OR IGNORE INTO fire_events (
      session_id, cwd, fired_at, level, fill_pct,
      input_tokens, cache_read, cache_create, window_size, model,
      assistant_uuid, threshold_advisory, threshold_escalated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `);
  const result = stmt.get(
    row.sessionId, row.cwd, row.firedAt, row.level, row.fillPct,
    row.inputTokens, row.cacheRead, row.cacheCreate, row.windowSize, row.model,
    row.assistantUuid, row.thresholdAdvisory, row.thresholdEscalated,
  );
  return result?.id ?? null;
}

export function recordOutcome(db: Database, row: OutcomeRow): void {
  if (!ALLOWED_METHODS.has(row.detectionMethod)) {
    throw new Error("context-loop: refusing to record outcome with unknown detection_method: " + row.detectionMethod);
  }
  db.query(`
    INSERT INTO compaction_outcomes (
      fire_event_id, acted, detected_at, pre_fill_pct, post_fill_pct,
      tokens_reclaimed, turns_until_action, detection_method
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.fireEventId, row.acted, row.detectedAt, row.preFillPct, row.postFillPct,
    row.tokensReclaimed, row.turnsUntilAction, row.detectionMethod,
  );
}

export function unresolvedFires(db: Database, sessionId: string): UnresolvedFire[] {
  return db.query<UnresolvedFire, [string]>(`
    SELECT f.id, f.assistant_uuid AS assistantUuid, f.fired_at AS firedAt,
      f.fill_pct AS fillPct, f.input_tokens AS inputTokens,
      f.cache_read AS cacheRead, f.cache_create AS cacheCreate,
      f.window_size AS windowSize
    FROM fire_events f
    LEFT JOIN compaction_outcomes o ON o.fire_event_id = f.id
    WHERE f.session_id = ? AND o.fire_event_id IS NULL
    ORDER BY f.fired_at ASC
  `).all(sessionId);
}

export function detectOutcomes(
  db: Database,
  sessionId: string,
  snap: PostFireSnapshot,
  now: number,
  timeoutTurns: number = DEFAULT_TIMEOUT_TURNS,
): OutcomeRow[] {
  const fires = unresolvedFires(db, sessionId);
  if (fires.length === 0) return [];

  const recorded: OutcomeRow[] = [];
  const uuidIndex = new Map<string, number>();
  snap.assistantUuids.forEach((u, i) => uuidIndex.set(u, i));

  for (const fire of fires) {
    try {
      const fireUuidIdx = uuidIndex.get(fire.assistantUuid);
      const transcriptHasFireUuid = fireUuidIdx !== undefined;

      const preTokens = fire.inputTokens + fire.cacheRead + fire.cacheCreate;
      const postTokens = snap.lastTotalTokens;
      const rawReclaimed = preTokens - postTokens;
      const tokensReclaimed = rawReclaimed >= 0 ? rawReclaimed : null;
      const fillDrop = fire.fillPct - snap.lastFillPct;

      let outcome: OutcomeRow | null = null;

      if (!transcriptHasFireUuid) {
        outcome = {
          fireEventId: fire.id,
          acted: 1,
          detectedAt: now,
          preFillPct: fire.fillPct,
          postFillPct: snap.lastFillPct,
          tokensReclaimed,
          turnsUntilAction: null,
          detectionMethod: "uuid_lost",
        };
      } else {
        const turnsSinceFire = snap.assistantUuids.length - 1 - fireUuidIdx;
        const corroborated = fillDrop >= 0.4;
        if (corroborated) {
          outcome = {
            fireEventId: fire.id,
            acted: 1,
            detectedAt: now,
            preFillPct: fire.fillPct,
            postFillPct: snap.lastFillPct,
            tokensReclaimed,
            turnsUntilAction: turnsSinceFire,
            detectionMethod: "fill_drop_corroborated",
          };
        } else if (turnsSinceFire >= timeoutTurns) {
          outcome = {
            fireEventId: fire.id,
            acted: 0,
            detectedAt: now,
            preFillPct: fire.fillPct,
            postFillPct: snap.lastFillPct,
            tokensReclaimed: null,
            turnsUntilAction: null,
            detectionMethod: "timeout",
          };
        }
      }

      if (outcome) {
        recordOutcome(db, outcome);
        recorded.push(outcome);
      }
    } catch (err) {
      breadcrumb(
        "detectOutcomes: fire_event_id=" + fire.id +
        " session=" + sessionId + " err=" + (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  return recorded;
}
