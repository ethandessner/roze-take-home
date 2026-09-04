import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * All local application state (OAuth tokens, sqlite db, caches) lives under
 * ~/.roze/ and is never written into the repo/checkout.
 */
export const ROZE_DIR = join(homedir(), ".roze");

export function ensureRozeDir(): string {
  mkdirSync(ROZE_DIR, { recursive: true, mode: 0o700 });
  return ROZE_DIR;
}

export const CREDENTIALS_PATH = join(ROZE_DIR, "credentials.json");
export const BRAIN_DB_PATH = join(ROZE_DIR, "brain.db");
export const GMAIL_CACHE_PATH = join(ROZE_DIR, "gmail-cache.json");
