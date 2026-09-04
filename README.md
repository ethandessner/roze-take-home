# Roze — Personal Memory System

A CLI that connects to your Gmail account and turns your email history into a lightweight, queryable "brain" for a personal AI assistant. The brain tracks four kinds of durable memory extracted from your inbox:

- **People** — durable context about who you communicate with
- **Projects** — outcome-oriented efforts with an endpoint
- **Interests** — recurring topics, organizations, tools, hobbies, and subjects
- **Open loops** — unresolved commitments, follow-ups, decisions, or actions

The CLI exposes exactly three commands: `auth`, `generate`, and `prompt <query>`.

## Prerequisites

- Node.js 20+
- A Google Cloud project with:
  - The Gmail API enabled
  - An OAuth consent screen in **Testing** mode, with scope `https://www.googleapis.com/auth/gmail.readonly`, and `agent@roze.ai` added as a test user
  - An OAuth Client ID (type **Desktop app** is simplest; if using **Web application**, add `http://localhost:4321/callback` as an authorized redirect URI)
- An OpenAI API key (used to extract the brain and to answer `prompt` queries)

## Setup

```bash
git clone <this-repo-url>
cd roze
npm install
cp .env.example .env
# then edit .env and fill in:
#   GOOGLE_CLIENT_ID=
#   GOOGLE_CLIENT_SECRET=
#   OPENAI_API_KEY=
npm run build
npm link   # optional: makes the `roze` command available globally
```

Without `npm link`, you can run every command via `npm run start -- <command>` (e.g. `npm run start -- auth`) or directly with `node dist/cli.js <command>`.

## Usage

```bash
roze auth                       # 1. Sign in with Google, grant Gmail readonly access
roze generate                   # 2. Read your email history and build the brain
roze prompt "Who is Alex and what are we working on together?"
roze prompt "What's still open with the Acme contract renewal?"
roze prompt "What tools or topics have I been reading about lately?"
```

For large mailboxes, `roze generate --limit 300` only processes the 300 most recent messages, which is useful for a quick end-to-end test before committing to a full run. `generate` self-throttles its Gmail API calls (default 8 req/sec, override with `ROZE_GMAIL_RPS`) and automatically backs off and retries on 429/quota errors, so a full run on a large mailbox will simply take longer rather than fail — it also caches fetched messages in `~/.roze/gmail-cache.json` so re-running `generate` after an interruption doesn't re-fetch messages already downloaded.

- `auth` opens your browser to the Google consent screen and stores tokens locally.
- `generate` fetches your Gmail history (with a progress bar), extracts People/Projects/Interests/Open Loops in batches via OpenAI, and persists the result to a local SQLite database.
- `prompt <query>` is a single-trip command: it loads the full brain, injects it as context, and asks OpenAI to answer your question. It is not an interactive chatbot.

## Where local state lives

All local state — OAuth tokens, the SQLite brain database, and a small Gmail response cache — lives under `~/.roze/` and is never written into the repo:

- `~/.roze/credentials.json` — OAuth tokens from `auth`
- `~/.roze/brain.db` — the generated brain (SQLite)
- `~/.roze/gmail-cache.json` — cached raw Gmail message fetches (speeds up re-running `generate`)

To fully reset local state:

```bash
rm -rf ~/.roze
```

## Design decisions and tradeoffs

- **SQLite over a vector DB**: the brain stores condensed, structured summaries (people/projects/interests/open loops), not raw email chunks. That data is small enough to store relationally and to pass *in full* to the model at query time, so a vector store and embedding search would add complexity without a real benefit at this scale.
- **Single-shot context injection over RAG**: because the whole brain fits in one prompt, `prompt <query>` just formats the entire brain as text and asks the model once — no retrieval step, no multi-turn chat loop, matching the "single-trip command" requirement directly.
- **Batch extraction over per-email extraction**: emails are grouped into threads and batched (~15 threads per call) before being sent to the model, to control API cost/latency while still giving the model enough surrounding context (a whole thread) to judge things like open loops correctly.
- **Simple text/name-based merge over embeddings-based entity resolution**: people are deduped by email (or name), projects by name, interests by topic — all case-insensitive exact/near matches. This is intentionally simple; a production system would want fuzzier entity resolution.
- **What was cut** (per the assignment's explicit non-goals): no web UI, no production Google verification (Testing mode + test user only), no multi-user support, no processing of new messages after the initial `generate` run (no incremental sync/watch), no integrations beyond Gmail, and only light unit tests around pure logic (Gmail MIME parsing, brain merge logic) rather than exhaustive coverage or end-to-end tests against live Google/OpenAI APIs.
