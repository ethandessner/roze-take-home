import Database from "better-sqlite3";
import { BRAIN_DB_PATH, ensureRozeDir } from "./paths.js";

let db: Database.Database | null = null;

/**
 * Opens (creating if necessary) the brain SQLite database at
 * ~/.roze/brain.db and ensures the schema is up to date.
 */
export function getDb(): Database.Database {
  if (db) return db;

  ensureRozeDir();
  db = new Database(BRAIN_DB_PATH);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

/**
 * Test-only helper: points subsequent getDb() calls at a fresh in-memory
 * (or given path) database with the schema applied. Not used by the CLI.
 */
export function _resetDbForTests(path = ":memory:"): Database.Database {
  db?.close();
  db = new Database(path);
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      relationship_context TEXT,
      last_interacted_at TEXT,
      notes TEXT,
      evidence_snippet TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','stalled','cancelled')),
      participants TEXT NOT NULL DEFAULT '[]',
      last_activity_at TEXT,
      evidence_snippet TEXT,
      outcome TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name_ci ON projects (name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS interests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('organization','tool','hobby','subject','other')),
      evidence_snippet TEXT,
      frequency_score INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_interests_topic_ci ON interests (topic COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS open_loops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
      resolution_reason TEXT,
      owner TEXT,
      related_people TEXT NOT NULL DEFAULT '[]',
      due_hint TEXT,
      source_thread_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Lightweight migration for DBs created before evidence_snippet existed.
  addColumnIfMissing(database, "people", "evidence_snippet", "TEXT");
  addColumnIfMissing(database, "projects", "evidence_snippet", "TEXT");
  addColumnIfMissing(database, "interests", "evidence_snippet", "TEXT");

  // Added alongside outcome-aware extraction.
  addColumnIfMissing(database, "projects", "outcome", "TEXT");
  addColumnIfMissing(database, "open_loops", "resolution_reason", "TEXT");

  // 'cancelled' was added to the projects status CHECK later. A CHECK
  // constraint can't be altered in place in SQLite, so an older database
  // would reject cancelled projects outright - rebuild the table instead.
  allowCancelledProjectStatus(database);
}

function allowCancelledProjectStatus(database: Database.Database): void {
  const row = database
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'`)
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'cancelled'")) return;

  database.exec(`
    BEGIN;
    CREATE TABLE projects_migrated (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','stalled','cancelled')),
      participants TEXT NOT NULL DEFAULT '[]',
      last_activity_at TEXT,
      evidence_snippet TEXT,
      outcome TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO projects_migrated (id, name, description, status, participants, last_activity_at, evidence_snippet, outcome, created_at, updated_at)
      SELECT id, name, description, status, participants, last_activity_at, evidence_snippet, outcome, created_at, updated_at FROM projects;
    DROP TABLE projects;
    ALTER TABLE projects_migrated RENAME TO projects;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name_ci ON projects (name COLLATE NOCASE);
    COMMIT;
  `);
}

function addColumnIfMissing(
  database: Database.Database,
  table: string,
  column: string,
  type: string
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
