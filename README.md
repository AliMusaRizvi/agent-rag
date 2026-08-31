# Enterprise Knowledge Agent

An agentic RAG system built on LangGraph over GitLab's real public Handbook
(~5,000 markdown pages, `gitlab-com/content-sites/handbook`), with hybrid
retrieval (dense + BM25, fused), LLM-based reranking, a query-rewrite loop,
a groundedness/hallucination-check loop, verified per-claim citations, and
human-approved tool calling against the live GitHub API. Built as a
portfolio project targeting production-RAG Upwork roles.

**Runs entirely on free, self-hosted models by default** — Ollama serving
a real Llama chat model (`llama3.2`) and a dedicated embedding model
(`nomic-embed-text`; there's no Meta-released "Llama embedding" model, so
this pairs a real Llama chat model with the standard high-quality choice
for local RAG embeddings). No API key, no billing account, and no rate
limit required to run the whole thing end to end. Every cloud provider
(Gemini, Groq, Anthropic, OpenAI) stays fully wired in behind the same
interface (`src/server/providers.js`) and is picked up automatically the
moment its API key is set — this is a config change, not a code change.

This is a **Node.js / Express / LangGraph.js** application — a single
backend and one React/TypeScript frontend, not the Python/FastAPI split
described in earlier drafts of this document. Every architectural decision
is documented and defended in `docs/DESIGN_DOC.md`; where the actual
implementation differs from that document (LLM-as-reranker instead of a
self-hosted cross-encoder; a native eval harness instead of Python RAGAS),
it's called out there and below, with the reasoning.

## Architecture

```
router ─┬─ chat (casual conversation, no retrieval)
         │
         ├─ retrieve → rerank → grade ─┬─ generate (structured citations)
         │        ↑                    │      │
         │        └── rewrite ─────────┘      ▼
         │            (capped, 2x)     verify citations → check groundedness
         │                                                   │        │
         │                                              grounded   not grounded
         │                                                   │    (capped, 1x)
         │                                                   ▼        │
         │                                                  END  ← regenerate
         │
         └─ tool ─→ prepareTool → [human approval — interrupt()] → executeTool → END
```

Every node appends to a `trace`, which drives both the UI's "reasoning
process" panel and an append-only audit log (Postgres) recording every
retrieval, grader verdict, rewrite, refusal, tool call, and approval
decision — the accountability layer a RAG system needs before anyone lets
it touch a real API.

## Quickstart

1. Copy `.env.example` to `.env`. Generate `API_KEY` and `SESSION_SECRET`
   with `node -e "console.log(require('crypto').randomUUID())"`. Nothing
   else is required — the default provider is Ollama, which needs no key.
   (Optional: set any cloud provider's API key if you want it available as
   a fallback or as a model-picker option — see `.env.example`.)

2. Start the stack:
   ```bash
   docker compose up --build
   ```
   This runs the app, Postgres (checkpointer + audit log), Qdrant (vector
   store), and Ollama (chat + embeddings) — the first run also pulls
   `llama3.2:3b`, `llama3.2:1b`, and `nomic-embed-text` (~3.5GB total)
   before the app starts, which takes a few minutes depending on your
   connection; every run after that is instant since the models persist in
   a volume. Without Docker: install Ollama yourself
   (https://ollama.com/download), `ollama pull` the same three models, run
   Postgres and Qdrant, point `.env` at all three, then
   `npm install && npm run build && npm start` — the server falls back to
   an in-memory store/checkpointer if Postgres/Qdrant are unreachable, with
   a loud warning, which is fine for a quick local check but not for
   anything you'd call "running."

3. Ingest the knowledge base (run once — takes ~2 minutes, fetches and
   chunks several hundred real handbook pages):
   ```bash
   curl -X POST http://localhost:3000/ingest -H "x-api-key: $API_KEY"
   ```
   Or from the host: `npm run ingest`.

4. Open http://localhost:3000 and chat, or hit the API directly:
   ```bash
   curl -X POST http://localhost:3000/chat \
     -H "Content-Type: application/json" \
     -d '{"message": "What are GitLab'"'"'s operating principles?"}'
   ```

5. Try the human-in-the-loop path:
   ```bash
   curl -c cookies.txt -b cookies.txt -X POST http://localhost:3000/chat \
     -H "Content-Type: application/json" \
     -d '{"message": "File a bug: the onboarding docs link is broken."}'
   # -> returns requires_approval: true and pending_tool_args
   curl -c cookies.txt -b cookies.txt -X POST http://localhost:3000/approve-tool \
     -H "Content-Type: application/json" \
     -d '{"thread_id": "<thread_id from previous response>", "approved": true}'
   ```
   Requires `GITHUB_TOKEN` + `GITHUB_REPO` in `.env` to actually create the
   issue; without them it approves honestly and reports that the tool
   isn't configured, rather than pretending to have done something.

## Local development

```bash
npm install
npm run dev     # Express on :3000 + Vite on :5173 with HMR, proxied to the API
```

`npm run build` produces the static SPA into `dist/`, which `npm start`
serves directly from Express — that's the production path.

## Inspecting Postgres and Qdrant via MCP

For poking around the audit log, the checkpointer's state, or the vector
collection directly from Claude Code / Claude Desktop, rather than writing
one-off scripts. Both servers below talk to whatever's in `docker-compose.yml`
by default (`localhost:5432` / `localhost:6333`, no auth) — adjust the
connection string / URL if you're pointing at something else.

**Postgres** — [`@henkey/postgres-mcp-server`](https://github.com/HenkDz/postgresql-mcp-server), run via `npx` (no separate install):
```bash
claude mcp add --transport stdio postgres -- npx -y @henkey/postgres-mcp-server \
  --connection-string "postgresql://postgres:postgres@localhost:5432/agent_memory"
```

**Qdrant** — [Qdrant's own official MCP server](https://github.com/qdrant/mcp-server-qdrant), run via `uvx` (needs [uv](https://docs.astral.sh/uv/getting-started/installation/) installed). `--env` flags (repeatable) go before the server name, `--` separates Claude Code's own flags from the command being wrapped:
```bash
claude mcp add --env QDRANT_URL=http://localhost:6333 \
  --env COLLECTION_NAME=enterprise_handbook \
  --env EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2 \
  --transport stdio qdrant -- uvx mcp-server-qdrant
```
Note the Qdrant MCP server does its own query embedding independently of
this app (it defaults to a `sentence-transformers` model, not
`nomic-embed-text`) — it's for *browsing and searching* the collection
ad hoc, not for anything that needs to match this app's actual retrieval
scoring.

Run `claude mcp list` to confirm both are connected. These are dev/inspection
tools only — nothing in the app itself depends on either being configured.

## Deploying to Render / Railway (free tier)

Local Docker Compose runs Ollama for a fully offline, unlimited-free demo —
but Render's and Railway's free tiers give roughly 512MB-1GB RAM, which
cannot run even the 1B Llama model. The deployed instance uses free-tier
*cloud* APIs instead — same codebase, different environment variables,
because every provider sits behind the same interface
(`src/server/providers.js` / `embeddings.js`).

1. **LLM + embeddings**: `LLM_PROVIDER=Groq` (real, free, no card —
   [console.groq.com/keys](https://console.groq.com/keys)) and
   `EMBEDDING_PROVIDER=gemini` (Groq has no embeddings endpoint at all —
   verified against their live API; Gemini's free tier is the only $0
   embedding option — [aistudio.google.com/apikey](https://aistudio.google.com/apikey)).
   Set `EMBEDDING_MODEL=models/gemini-embedding-001` and
   `EMBEDDING_DIM=3072` to match.
2. **Vector store**: [Qdrant Cloud](https://cloud.qdrant.io) has a free
   1GB cluster — plenty for this corpus. Set `QDRANT_URL`/`QDRANT_API_KEY`
   to it and leave `VECTOR_BACKEND=qdrant`.
3. **Postgres**: [Neon](https://neon.tech) or [Supabase](https://supabase.com)
   both have a free tier. Set `POSTGRES_URL` to it.
4. **Everything else** (`API_KEY`, `SESSION_SECRET`, `ALLOWED_ORIGINS`,
   `GITHUB_TOKEN`/`GITHUB_REPO` if you want the tool live) — same as local.

**Render**: `render.yaml` in this repo already declares the service, health
check, and which env vars need a value (`sync: false` — set the actual
values in the dashboard's Environment tab, never commit them). Connect the
repo, Render reads the blueprint automatically.

**Railway**: `railway.json` declares the Dockerfile build and health
check. Railway doesn't read env vars from a committed file — connect the
repo, then set the same variables listed above via the dashboard or
`railway variables set KEY=value`.

Either way: run ingestion once against the deployed instance after the
first deploy (`curl -X POST https://<your-app>/ingest -H "x-api-key: $API_KEY"`)
— it's the same idempotent step as local, just pointed at the cloud
Qdrant/Postgres instead of the Docker Compose ones.

## Evaluation

```bash
npm run eval
```

A native Node harness (not RAGAS — this is a Node stack top to bottom, and
pulling in Python for one script wasn't a trade worth making). It measures
the same failure modes RAGAS targets — retrieval recall against an
expected source, keyword recall in the final answer, and refusal accuracy
on two adversarial questions the corpus genuinely doesn't cover — using
signals the graph already produces, no extra LLM-judge calls required.
Writes a full report to `src/server/eval/eval-report.json`.

`src/server/eval/gold-set.json` ships with 10 questions as a **starter
set**. Expand it to 30-50 before treating the output as a reportable
result — the two adversarial "should refuse" questions are worth keeping
and adding more of, since a demonstrated refusal is the single most
convincing thing this kind of system can show a technical reviewer.

## Project layout

```
server.js                  # thin bootstrap: middleware, routes, graceful shutdown
src/server/
  config.js                 # zod-validated env config, one place, fails loudly at boot
  logger.js                 # structured (pino) logging with request correlation ids
  security.js                # helmet, CORS allowlist, rate limits, session cookie, zod schemas
  db.js                      # Postgres pool, LangGraph checkpointer, audit log, session budget
  embeddings.js               # Ollama (default) or Gemini embeddings, pluggable, with backoff
  bm25.js                    # sparse retrieval (Okapi BM25) + Reciprocal Rank Fusion
  vectorstore.js              # hybrid retrieval; Qdrant or in-memory, tenant-scoped
  rerank.js                  # LLM-as-reranker over the fused candidate set
  providers.js                # Ollama/Gemini/Groq/Anthropic/OpenAI behind one interface, with fallback
  guardrails.js               # PII redaction, injection screening, relevance floor, citation verification
  graph.js                   # the LangGraph state machine described above
  tools/github.js             # the one real tool — issue creation, repo pinned server-side
  ingest.js                  # real handbook crawl + header-aware chunking
  cache.js                   # tenant/model/persona-scoped answer cache
  eval/                      # gold set + harness
  routes/                    # one file per endpoint
  __tests__/                 # node:test unit tests
src/                         # React/TypeScript frontend (Vite)
docs/
  DESIGN_DOC.md               # full reasoning for every architectural decision
  UI_SPEC.md                  # frontend spec (see its header for what shipped vs. what it originally asked for)
  LEARNING_GUIDE.md            # what to study, in what order, and why
```

## Security posture

No user-account system is in scope here (single-tenant portfolio
deployment), so the security model is: an anonymous, signed session
cookie scopes rate limits, uploads, and the daily token budget per
browser; a shared `API_KEY` gates the two admin-only routes (`/ingest`,
`/api/audit`) that a browser SPA has no business calling; every
write-capable route (`/approve-tool`) verifies the approver's session
actually originated the pending action, not just that they know a
`thread_id`. See `docs/DESIGN_DOC.md` and the audit history for the full
threat-model reasoning, including what would need to change for real
multi-tenant, multi-user auth.

## Known limitations

Said plainly, because stating them is the senior-engineer signal, not
hiding them:

- **Eval gold set is a 10-question starter**, not a statistically
  meaningful sample. Expand before citing numbers.
- **Reranking is LLM-based**, not a self-hosted cross-encoder — cheaper to
  run and good enough at this corpus size, but a dedicated reranker would
  win at larger scale. Swapping one in is isolated to `rerank.js`.
- **Cloud free-tier rate limits are real, if you opt into a cloud
  provider.** The default (Ollama) has none of this — it's the whole
  reason it's the default. If you switch `EMBEDDING_PROVIDER` to
  `gemini`, its free tier is 100 embedContent requests/minute;
  `embeddings.js` backs off and retries, but a large ingestion run or a
  burst of uploads can still take a while, and this project's own
  extensive testing hit sustained exhaustion that a few minutes of
  backoff couldn't clear (a daily cap, not just per-minute). Groq's chat
  model catalog also turns over faster than most providers' — it dropped
  Llama entirely at one point — the configured model ids were verified
  live at build time; re-verify before deploying if it's been a while.
- **Local inference is slower than a cloud API**, especially CPU-only.
  Each chat turn makes several LLM calls (router, grader, generator,
  groundedness check), so expect noticeably higher latency than the cloud
  providers. A GPU (see the commented-out block in the `ollama` service in
  `docker-compose.yml`) or swapping in a cloud provider's API key closes
  the gap.
- **Prompt-injection and PII screening are heuristic** (pattern/regex
  based), not trained classifiers — they catch the common, unsubtle cases.
  Upgrading either is a drop-in replacement for one function in
  `guardrails.js`.
- **Rate limiting and the answer cache are in-process**, fine for one
  instance; a multi-instance deployment needs a shared store (Redis) for
  both.
