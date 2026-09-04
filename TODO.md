# Roadmap

Two kinds of items below, kept deliberately separate: **hardening** (make
what already exists more production-grade) and **new capability** (extend
what the system can do). The cross-domain section at the bottom is the
answer to a specific question worth stating up front: *this project
answers questions from GitLab's handbook, but nothing about the
architecture is GitLab-specific.* Every item below the corpus/tool layer —
hybrid retrieval, the grader/rewrite loop, grounded generation with
verified citations, the groundedness re-check, human-approved tool calls —
is domain-agnostic. Swapping the target market is a corpus + tool-config
change, not a rewrite, and that reusability is itself the strongest thing
to demonstrate to a prospective client outside the original demo's domain.

## Hardening (make what exists more solid)

These are mostly already called out honestly in the README's "Known
limitations" — this is the actionable version of that list.

- [ ] **Expand the eval gold set** from 10 questions to 30–50, covering
      easy/hard/adversarial/out-of-scope cases. `src/server/eval/` has the
      harness already; it just needs more real questions with known-good
      answers to run against.
- [ ] **CI pipeline** (GitHub Actions): lint + typecheck + `npm run build`
      on every PR, and ideally the eval harness as a regression gate once
      the gold set above exists. Nothing currently blocks a broken commit
      from merging except manual testing.
- [ ] **Real cross-encoder reranker** as an alternative to the current
      LLM-as-reranker (`rerank.js`) — cheaper and faster at scale, once
      self-hosting a small cross-encoder (e.g. a `bge-reranker` ONNX
      model) is in scope. The current approach is a documented, deliberate
      substitute, not a placeholder, but it's the first thing a senior
      reviewer will ask "why not X" about.
- [ ] **Shared store for rate limiting and the answer cache** (Redis) —
      both are in-process today, correct for one instance, silently wrong
      the moment there's more than one (each instance would enforce its
      own separate rate limit and cache, not a shared one).
- [ ] **Semantic (near-duplicate) caching** — `cache.js` only matches on
      an exact query string today. "What's GitLab's remote policy?" and
      "what is gitlab's remote work policy" are cache misses against each
      other despite being the same question.
- [ ] **Trained classifiers for guardrails** — `screenForInjection()` and
      `redactPII()` in `guardrails.js` are regex heuristics, documented as
      such. A real prompt-injection classifier and a real PII/NER model
      are both drop-in replacements for one function each.
- [ ] **OCR for scanned PDFs** — `upload.js`'s PDF path extracts an
      existing text layer; a scanned image-only PDF (no text layer) yields
      nothing today. Tesseract or a cloud OCR API would close this.
- [ ] **Resolve the `bun.lock` / `package-lock.json` duplication** at the
      repo root — two lockfiles for two different package managers can
      silently drift apart depending which one someone runs. Pick one.
- [ ] **`OpenRouter` free-tier reliability** — verified live at
      integration time: the obvious model picks (Google's Gemma releases)
      hit a real `429 temporarily rate-limited upstream` from the shared
      free pool on every attempt, and a second candidate (MiniMax M3)
      returned malformed non-JSON output on a structured call after
      minutes of latency. The current default (NVIDIA Nemotron) answered
      reliably in testing, but this is a shared, uncontrolled free pool —
      worth an occasional live re-check (`config.js` has the exact curl
      command used to verify it).

## New capability

- [ ] **Streaming responses (SSE or WebSocket)** — the UI currently waits
      for the full graph run before showing anything but a spinner. Token-
      level streaming from `generateNode` would cut perceived latency
      substantially, especially on Ollama.
- [ ] **Admin analytics dashboard** — the data already exists and is
      unused visually: `audit_log` (every route/refusal/citation/latency)
      and `message_feedback` (thumbs up/down) are both real Postgres
      tables with nothing querying them for trends yet. A small dashboard
      (query volume over time, refusal rate, top questions, feedback
      ratio) would be a genuinely impressive "we take this seriously"
      artifact for a client demo.
- [ ] **Multi-language support** — detect the query's language and either
      retrieve/answer in it directly or translate at the edges. The corpus
      is English-only right now; the pipeline itself has no language
      assumption baked in.
- [ ] **Per-user accounts** — today's "tenant" is an anonymous signed
      session cookie (real isolation, but no login, no cross-device
      history, no admin-assigned roles). Real auth (even a simple
      email+magic-link) would unlock per-user history sync and role-based
      document access.
- [ ] **A public embeddable widget** — a small `<script>` snippet a client
      could drop into their own website, talking to the same `/chat`
      endpoint. Currently the only "product" is this standalone SPA.
- [ ] **Export conversation to PDF**, not just Markdown
      (`lib/utils.ts`'s `exportToMarkdown` today) — a nicer deliverable
      for a non-technical stakeholder to forward internally.
- [ ] **Table-aware chunking** — `ingest.js`'s chunker treats a markdown
      table as regular text; a dedicated table extraction path (row-aware,
      queryable) would meaningfully improve answers over tabular sources
      (pricing tables, comparison matrices, org charts).

## Cross-domain playbook

The point of this section: for each vertical below, the **retrieval,
grading, grounding, citation-verification, and human-approval machinery
carries over unchanged.** What changes is (1) the ingested corpus and (2)
which real-world action, if any, sits behind the human-approval gate that
`prepareTool`/`executeTool` already implements for GitHub issues.

| Domain | Swap the corpus for... | Swap the tool for... |
|---|---|---|
| **Legal** | Contract templates, case law, firm policy manuals | Draft a redline comment / flag a clause for review |
| **Healthcare** | Clinical guidelines, formulary/drug-interaction references | File a formulary exception request |
| **Finance / Compliance** | SEC filings, internal compliance policy, expense policy (the handbook already has a real "budget" section — a natural pilot) | File an expense exception or compliance review request |
| **HR / People Ops** | Employee handbook (already the case here), benefits guides | File a PTO/HR ticket — nearly identical shape to the existing GitHub-issue tool |
| **Customer Support** | A SaaS company's help center / knowledge base | Create a support ticket (Zendesk/Intercom API instead of GitHub's) |
| **Engineering / DevOps** | Internal runbooks, incident postmortems, architecture docs | File a Jira ticket or open a PagerDuty incident |
| **Real Estate** | Property listings, lease templates | Schedule a viewing / flag a lease clause |
| **Education** | Course catalogs, academic policy, per-course syllabi | Route a question to the right department |
| **Government / Public Sector** | Public policy documents, FOIA-eligible records | File a formal request for escalation |

Positioning this to a prospective client: the demo isn't "a GitLab handbook
chatbot" — it's "point this at your documents and your ticketing system,
and the retrieval/grounding/approval engine underneath is already built,
tested, and hardened against exactly the failure modes (hallucination,
weak-context guessing, prompt injection, unauthorized actions) that make
naive RAG demos fall apart in front of a technical buyer."
