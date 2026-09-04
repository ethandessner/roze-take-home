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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','stalled')),
      participants TEXT NOT NULL DEFAULT '[]',
      last_activity_at TEXT,
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
      owner TEXT,
      related_people TEXT NOT NULL DEFAULT '[]',
      related_project_id INTEGER REFERENCES projects(id),
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
}
