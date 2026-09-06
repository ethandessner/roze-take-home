import { getDb } from "./db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Person {
  id: number;
  name: string;
  email: string | null;
  relationshipContext: string | null;
  lastInteractedAt: string | null;
  notes: string | null;
  evidenceSnippet: string | null;
}

export type ProjectStatus = "active" | "completed" | "stalled" | "cancelled";

/** Statuses that mean the effort is over, one way or the other. */
const TERMINAL_PROJECT_STATUSES: ProjectStatus[] = ["completed", "cancelled"];

export interface Project {
  id: number;
  name: string;
  description: string | null;
  status: ProjectStatus;
  participants: string[];
  lastActivityAt: string | null;
  evidenceSnippet: string | null;
  /** How and why the project ended, when it has ended. */
  outcome: string | null;
}

export interface Interest {
  id: number;
  topic: string;
  category: "organization" | "tool" | "hobby" | "subject" | "other";
  evidenceSnippet: string | null;
  frequencyScore: number;
}

export interface OpenLoop {
  id: number;
  description: string;
  status: "open" | "resolved";
  /** Why the loop is no longer outstanding, when it has been resolved. */
  resolutionReason: string | null;
  owner: string | null;
  relatedPeople: string[];
  dueHint: string | null;
  sourceThreadId: string | null;
}

export interface Brain {
  people: Person[];
  projects: Project[];
  interests: Interest[];
  openLoops: OpenLoop[];
  meta: Record<string, string>;
}

// Shapes coming out of the LLM extraction step (see src/commands/generate.ts).
export interface ExtractedPerson {
  name: string;
  email?: string | null;
  relationship_context?: string | null;
  notes?: string | null;
  evidence_snippet?: string | null;
}

export interface ExtractedProject {
  name: string;
  description?: string | null;
  status?: ProjectStatus;
  participants?: string[];
  evidence_snippet?: string | null;
  outcome?: string | null;
}

export interface ExtractedInterest {
  topic: string;
  category?: Interest["category"];
  evidence_snippet?: string | null;
}

export interface ExtractedOpenLoop {
  description: string;
  status?: "open" | "resolved";
  resolution_reason?: string | null;
  owner?: string | null;
  related_people?: string[];
  due_hint?: string | null;
  source_thread_id?: string | null;
}

// ---------------------------------------------------------------------------
// Upsert / merge functions
// ---------------------------------------------------------------------------

/**
 * Returns whichever of the two ISO-ish date strings is chronologically
 * later, tolerating nulls. Used to make "last interacted"/"last activity"
 * timestamps reflect the real most-recent email date rather than the time
 * `generate` happened to run.
 */
function maxDate(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a ?? null;
  return a > b ? a : b;
}

/**
 * Keeps the evidence snippet associated with the most recent date we have.
 * Falls back to whichever snippet is non-null if dates are missing/equal.
 */
function pickEvidence(
  existingSnippet: string | null,
  existingDate: string | null,
  newSnippet: string | null | undefined,
  newDate: string
): string | null {
  if (!newSnippet) return existingSnippet;
  if (!existingDate || newDate >= existingDate) return newSnippet;
  return existingSnippet;
}

export function upsertPerson(
  input: ExtractedPerson,
  /** Real date (ISO string) of the email evidence this came from, if known. */
  interactionDate?: string | null
): void {
  if (!input.name?.trim()) return;
  const db = getDb();
  const email = input.email?.trim().toLowerCase() || null;
  const eventDate = interactionDate ?? new Date().toISOString();

  const existing = email
    ? (db
        .prepare(`SELECT * FROM people WHERE lower(email) = ?`)
        .get(email) as PersonRow | undefined)
    : (db
        .prepare(`SELECT * FROM people WHERE lower(name) = ?`)
        .get(input.name.trim().toLowerCase()) as PersonRow | undefined);

  if (existing) {
    const mergedNotes = mergeText(existing.notes, input.notes);
    const mergedContext = mergeText(
      existing.relationship_context,
      input.relationship_context
    );
    const lastInteractedAt = maxDate(existing.last_interacted_at, eventDate);
    const evidenceSnippet = pickEvidence(
      existing.evidence_snippet,
      existing.last_interacted_at,
      input.evidence_snippet,
      eventDate
    );
    db.prepare(
      `UPDATE people SET relationship_context = ?, notes = ?, last_interacted_at = ?, evidence_snippet = ?, updated_at = datetime('now'), email = coalesce(email, ?) WHERE id = ?`
    ).run(mergedContext, mergedNotes, lastInteractedAt, evidenceSnippet, email, existing.id);
  } else {
    db.prepare(
      `INSERT INTO people (name, email, relationship_context, notes, last_interacted_at, evidence_snippet) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      input.name.trim(),
      email,
      input.relationship_context ?? null,
      input.notes ?? null,
      eventDate,
      input.evidence_snippet ?? null
    );
  }
}

export function upsertProject(
  input: ExtractedProject,
  /** Real date (ISO string) of the email evidence this came from, if known. */
  activityDate?: string | null
): void {
  if (!input.name?.trim()) return;
  const db = getDb();
  const eventDate = activityDate ?? new Date().toISOString();
  const existing = db
    .prepare(`SELECT * FROM projects WHERE lower(name) = ?`)
    .get(input.name.trim().toLowerCase()) as ProjectRow | undefined;

  const incomingParticipants = input.participants ?? [];

  if (existing) {
    const mergedParticipants = Array.from(
      new Set([...JSON.parse(existing.participants), ...incomingParticipants])
    );
    const description =
      (input.description?.length ?? 0) > (existing.description?.length ?? 0)
        ? input.description
        : existing.description;
    const lastActivityAt = maxDate(existing.last_activity_at, eventDate);
    const evidenceSnippet = pickEvidence(
      existing.evidence_snippet,
      existing.last_activity_at,
      input.evidence_snippet,
      eventDate
    );
    // Batches aren't processed in global chronological order, so treat a
    // terminal status as sticky the same way "resolved" is for open loops:
    // once we've seen evidence a project ended, an older batch that still
    // thought it was active must not revive it.
    const incomingStatus = input.status ?? existing.status;
    const status = TERMINAL_PROJECT_STATUSES.includes(existing.status)
      ? existing.status
      : incomingStatus;
    // Keep whichever outcome explains the terminal state we settled on.
    const outcome = TERMINAL_PROJECT_STATUSES.includes(existing.status)
      ? existing.outcome ?? input.outcome ?? null
      : input.outcome ?? existing.outcome ?? null;

    db.prepare(
      `UPDATE projects SET description = ?, status = ?, participants = ?, last_activity_at = ?, evidence_snippet = ?, outcome = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(
      description ?? null,
      status,
      JSON.stringify(mergedParticipants),
      lastActivityAt,
      evidenceSnippet,
      outcome,
      existing.id
    );
  } else {
    db.prepare(
      `INSERT INTO projects (name, description, status, participants, last_activity_at, evidence_snippet, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.name.trim(),
      input.description ?? null,
      input.status ?? "active",
      JSON.stringify(incomingParticipants),
      eventDate,
      input.evidence_snippet ?? null,
      input.outcome ?? null
    );
  }
}

export function upsertInterest(input: ExtractedInterest): void {
  if (!input.topic?.trim()) return;
  const db = getDb();
  const existing = db
    .prepare(`SELECT * FROM interests WHERE lower(topic) = ?`)
    .get(input.topic.trim().toLowerCase()) as InterestRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE interests SET frequency_score = frequency_score + 1, evidence_snippet = coalesce(evidence_snippet, ?), updated_at = datetime('now') WHERE id = ?`
    ).run(input.evidence_snippet ?? null, existing.id);
  } else {
    db.prepare(
      `INSERT INTO interests (topic, category, evidence_snippet, frequency_score) VALUES (?, ?, ?, 1)`
    ).run(
      input.topic.trim(),
      input.category ?? "other",
      input.evidence_snippet ?? null
    );
  }
}

export function upsertOpenLoop(input: ExtractedOpenLoop): void {
  if (!input.description?.trim()) return;
  const db = getDb();
  const incomingStatus = input.status ?? "open";

  const existing = db
    .prepare(`SELECT id, status FROM open_loops WHERE lower(description) = ?`)
    .get(input.description.trim().toLowerCase()) as
    | { id: number; status: OpenLoop["status"] }
    | undefined;

  if (existing) {
    // Batches aren't processed in global chronological order, so treat
    // "resolved" as sticky: a later batch observing this loop as resolved
    // closes it, but an older batch still seeing it as open must not
    // reopen something we already know was resolved.
    if (existing.status === "open" && incomingStatus === "resolved") {
      db.prepare(
        `UPDATE open_loops SET status = 'resolved', resolution_reason = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(input.resolution_reason ?? null, existing.id);
    }
    return;
  }

  db.prepare(
    `INSERT INTO open_loops (description, status, resolution_reason, owner, related_people, due_hint, source_thread_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.description.trim(),
    incomingStatus,
    incomingStatus === "resolved" ? input.resolution_reason ?? null : null,
    input.owner ?? null,
    JSON.stringify(input.related_people ?? []),
    input.due_hint ?? null,
    input.source_thread_id ?? null
  );
}

// ---------------------------------------------------------------------------
// Reconciliation writes (see reconcileBrain in extract.ts)
// ---------------------------------------------------------------------------

/**
 * Closes an open loop that the reconciliation pass found to be settled or
 * moot. Returns true if a still-open loop was actually closed, so callers
 * can report how much the pass changed.
 */
export function resolveOpenLoopById(id: number, reason: string): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE open_loops SET status = 'resolved', resolution_reason = ?, updated_at = datetime('now') WHERE id = ? AND status = 'open'`
    )
    .run(reason, id);
  return result.changes > 0;
}

/**
 * Marks a project as having reached a terminal state, recording how it
 * ended. Won't overwrite a project that is already terminal.
 */
export function closeProjectById(
  id: number,
  status: Exclude<ProjectStatus, "active">,
  outcome: string
): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE projects SET status = ?, outcome = ?, updated_at = datetime('now') WHERE id = ? AND status NOT IN ('completed','cancelled')`
    )
    .run(status, outcome, id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

export function setMeta(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

export function getMeta(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

// ---------------------------------------------------------------------------
// Loading / formatting the full brain
// ---------------------------------------------------------------------------

export function loadFullBrain(): Brain {
  const db = getDb();

  const people = (db.prepare(`SELECT * FROM people ORDER BY name`).all() as PersonRow[]).map(
    (r): Person => ({
      id: r.id,
      name: r.name,
      email: r.email,
      relationshipContext: r.relationship_context,
      lastInteractedAt: r.last_interacted_at,
      notes: r.notes,
      evidenceSnippet: r.evidence_snippet,
    })
  );

  const projects = (
    db.prepare(`SELECT * FROM projects ORDER BY name`).all() as ProjectRow[]
  ).map(
    (r): Project => ({
      id: r.id,
      name: r.name,
      description: r.description,
      status: r.status,
      participants: JSON.parse(r.participants),
      lastActivityAt: r.last_activity_at,
      evidenceSnippet: r.evidence_snippet,
      outcome: r.outcome,
    })
  );

  const interests = (
    db
      .prepare(`SELECT * FROM interests ORDER BY frequency_score DESC, topic`)
      .all() as InterestRow[]
  ).map(
    (r): Interest => ({
      id: r.id,
      topic: r.topic,
      category: r.category,
      evidenceSnippet: r.evidence_snippet,
      frequencyScore: r.frequency_score,
    })
  );

  const openLoops = (
    db
      .prepare(`SELECT * FROM open_loops ORDER BY status, created_at DESC`)
      .all() as OpenLoopRow[]
  ).map(
    (r): OpenLoop => ({
      id: r.id,
      description: r.description,
      status: r.status,
      resolutionReason: r.resolution_reason,
      owner: r.owner,
      relatedPeople: JSON.parse(r.related_people),
      dueHint: r.due_hint,
      sourceThreadId: r.source_thread_id,
    })
  );

  const metaRows = db.prepare(`SELECT key, value FROM meta`).all() as {
    key: string;
    value: string;
  }[];
  const meta = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));

  return { people, projects, interests, openLoops, meta };
}

/**
 * Renders the brain as a compact, well-labeled text block suitable for
 * inclusion in an LLM prompt.
 */
export function formatBrainAsContext(brain: Brain): string {
  const lines: string[] = [];

  lines.push("## People");
  if (brain.people.length === 0) lines.push("(none)");
  for (const p of brain.people) {
    lines.push(
      `- ${p.name}${p.email ? ` <${p.email}>` : ""}: ${p.relationshipContext ?? "no context"}${
        p.notes ? ` | notes: ${p.notes}` : ""
      }${p.evidenceSnippet ? ` | evidence: "${p.evidenceSnippet}"` : ""}${
        p.lastInteractedAt ? ` | last email evidence: ${toDateOnly(p.lastInteractedAt)}` : ""
      }`
    );
  }

  lines.push("\n## Projects");
  if (brain.projects.length === 0) lines.push("(none)");
  for (const p of brain.projects) {
    lines.push(
      `- ${p.name} [${p.status}]: ${p.description ?? "no description"}${
        p.outcome ? ` | outcome: ${p.outcome}` : ""
      }${p.participants.length ? ` | participants: ${p.participants.join(", ")}` : ""}${
        p.evidenceSnippet ? ` | evidence: "${p.evidenceSnippet}"` : ""
      }${p.lastActivityAt ? ` | last email evidence: ${toDateOnly(p.lastActivityAt)}` : ""}`
    );
  }

  lines.push("\n## Interests");
  if (brain.interests.length === 0) lines.push("(none)");
  for (const i of brain.interests) {
    lines.push(
      `- ${i.topic} (${i.category}, mentioned ${i.frequencyScore}x)${
        i.evidenceSnippet ? ` | e.g. "${i.evidenceSnippet}"` : ""
      }`
    );
  }

  lines.push("\n## Open Loops (still outstanding)");
  const openOnly = brain.openLoops.filter((o) => o.status === "open");
  if (openOnly.length === 0) lines.push("(none)");
  for (const o of openOnly) {
    lines.push(
      `- ${o.description}${o.owner ? ` | owner: ${o.owner}` : ""}${
        o.dueHint ? ` | due: ${o.dueHint}` : ""
      }${o.relatedPeople.length ? ` | people: ${o.relatedPeople.join(", ")}` : ""}`
    );
  }

  // Resolved loops are still worth showing: knowing that something was
  // explicitly settled (and why) is what lets an answer say "nothing is
  // outstanding, because X" instead of just omitting it silently.
  const resolved = brain.openLoops.filter((o) => o.status === "resolved");
  if (resolved.length > 0) {
    lines.push("\n## Resolved (NOT outstanding - do not present these as pending)");
    for (const o of resolved) {
      lines.push(
        `- ${o.description}${
          o.resolutionReason ? ` | resolved because: ${o.resolutionReason}` : ""
        }`
      );
    }
  }

  return lines.join("\n");
}

/**
 * Renders the brain for the reconciliation pass. Differs from the query
 * context in two ways: entries carry their database ids (so the model can
 * point at exactly what to change), and open loops are listed alongside
 * every project rather than filtered, since the whole point is to spot
 * contradictions between them.
 */
export function renderBrainForReconciliation(brain: Brain): string {
  const lines: string[] = [];

  lines.push("## Projects");
  if (brain.projects.length === 0) lines.push("(none)");
  for (const p of brain.projects) {
    lines.push(
      `- id=${p.id} [${p.status}] ${p.name}: ${p.description ?? "no description"}${
        p.outcome ? ` | outcome: ${p.outcome}` : ""
      }${p.evidenceSnippet ? ` | evidence: "${p.evidenceSnippet}"` : ""}${
        p.lastActivityAt ? ` | last activity: ${toDateOnly(p.lastActivityAt)}` : ""
      }`
    );
  }

  lines.push("\n## Open loops currently marked OPEN");
  const openOnly = brain.openLoops.filter((o) => o.status === "open");
  if (openOnly.length === 0) lines.push("(none)");
  for (const o of openOnly) {
    lines.push(
      `- id=${o.id} ${o.description}${o.owner ? ` | owner: ${o.owner}` : ""}${
        o.relatedPeople.length ? ` | people: ${o.relatedPeople.join(", ")}` : ""
      }${o.dueHint ? ` | due: ${o.dueHint}` : ""}`
    );
  }

  // People and interests give the model corroborating context (e.g. who a
  // counterparty is) without being things it can modify.
  lines.push("\n## People (context only - not editable)");
  for (const p of brain.people) {
    lines.push(
      `- ${p.name}${p.email ? ` <${p.email}>` : ""}: ${p.relationshipContext ?? "no context"}${
        p.evidenceSnippet ? ` | evidence: "${p.evidenceSnippet}"` : ""
      }${p.lastInteractedAt ? ` | last interaction: ${toDateOnly(p.lastInteractedAt)}` : ""}`
    );
  }

  return lines.join("\n");
}

function toDateOnly(isoOrSqlDate: string): string {
  const t = Date.parse(isoOrSqlDate);
  return Number.isNaN(t) ? isoOrSqlDate : new Date(t).toISOString().slice(0, 10);
}

function mergeText(
  existing: string | null | undefined,
  incoming: string | null | undefined
): string | null {
  if (!incoming?.trim()) return existing ?? null;
  if (!existing?.trim()) return incoming.trim();
  if (existing.toLowerCase().includes(incoming.trim().toLowerCase())) return existing;
  return `${existing}; ${incoming.trim()}`;
}

// ---------------------------------------------------------------------------
// Raw row shapes
// ---------------------------------------------------------------------------

interface PersonRow {
  id: number;
  name: string;
  email: string | null;
  relationship_context: string | null;
  last_interacted_at: string | null;
  notes: string | null;
  evidence_snippet: string | null;
}

interface ProjectRow {
  id: number;
  name: string;
  description: string | null;
  status: Project["status"];
  participants: string;
  last_activity_at: string | null;
  evidence_snippet: string | null;
  outcome: string | null;
}

interface InterestRow {
  id: number;
  topic: string;
  category: Interest["category"];
  evidence_snippet: string | null;
  frequency_score: number;
}

interface OpenLoopRow {
  id: number;
  description: string;
  status: OpenLoop["status"];
  resolution_reason: string | null;
  owner: string | null;
  related_people: string;
  due_hint: string | null;
  source_thread_id: string | null;
}
