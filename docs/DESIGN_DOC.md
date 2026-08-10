# Enterprise Knowledge Agent — Full Design Document
### A production-style RAG + LangGraph portfolio project, with reasoning for every decision

---

## 1. Purpose of this document

This is the complete build spec for the portfolio project: what to build, which tools to use for
each piece, and — for every choice — why that option and not the alternatives. It also answers two
direct questions: whether Gemini's free tier is viable for this, and whether the project needs a UI.

**One-line pitch for your Upwork proposal:** *"An agentic RAG system over GitLab's public handbook
(2,000+ pages) with hybrid retrieval, source-cited answers, a query-rewrite/hallucination-check
loop, human-approved tool calling against a live API, and RAGAS-measured evaluation — built to
mirror the exact architecture an internal knowledge agent needs."*

---

## 2. Why this project, specifically

You need a project that proves three things a client posting that job actually cares about, in
order:

1. **You understand agentic RAG is not "stuff chunks into a prompt."** The job explicitly lists
   hybrid retrieval, reranking, structured output, memory, and human-in-the-loop — that's a
   checklist of "have you actually shipped one of these, or only tutorials." A linear
   retrieve-then-generate chain fails this test even if the answers look fine.
2. **You can point at a real deliverable**, not a description. Clients on this kind of job get
   pitched the same three sentences ("I have experience with RAG and LangChain") by fifty
   applicants. A repo + live demo + a results table with real numbers is what separates a reply
   that gets read from one that doesn't.
3. **You can reason about production concerns** — evaluation, logging, fallback, cost — because
   "6+ months, 30+ hrs/week" signals they want someone who will own this past the demo stage, not
   someone who prototypes and disappears.

The GitLab Handbook + GitHub Issues combination is deliberate: it's the closest public analogue to
"internal knowledge search + document Q&A + business workflows" that exists. A generic PDF-QA demo
over Wikipedia or arXiv doesn't demonstrate the same thing — those corpora aren't heterogeneous,
un-curated, and cross-linked the way a real company knowledge base is.

---

## 3. LLM provider decision — is Gemini's free tier viable?

**Short answer: yes for building and demoing, with two caveats you should design around from day
one — do not treat this as an afterthought fallback.**

### 3.1 What the Gemini free tier actually gives you

As of mid-2026, Google AI Studio's free tier (no credit card required) breaks down roughly like
this — **note: multiple secondary sources report conflicting exact numbers for this, which is
itself useful information (see 3.3), so treat the figures below as directional and verify the
current numbers at `ai.google.dev` before you build**:

| Model | Typical free-tier RPM | Typical free-tier RPD | Notes |
|---|---|---|---|
| Gemini 2.5 / 3 Flash-Lite | ~15 | several hundred–1,500 | Best throughput, weakest reasoning |
| Gemini 2.5 / 3 Flash | ~10 | ~250–1,500 | Best default for this project |
| Gemini 2.5 Pro | ~5 | ~25–50 | Trial-only, not usable as a primary model |

All Flash-tier models currently ship with a 1M-token context window and a shared ~250K TPM budget,
even on the free tier — that's genuinely generous compared to OpenAI's or Anthropic's free
offerings (neither has a comparable no-cost API tier at all; both require a paid key from request
one).

### 3.2 Why Gemini Flash is the right default for THIS project

- **It's genuinely free with no card**, which matters because you'll be making hundreds of calls
  during development (ingestion re-runs, eval sweeps, debugging the grader/rewrite loop). OpenAI
  and Claude have no free API tier — every call costs money from the start, which either limits
  how much you iterate or costs you real dollars during a portfolio build.
  Groq is the other genuinely free option (fast open-weight models — Llama, Kimi, GPT-OSS — at
  very high tokens/sec) and is worth having as your *second* provider for the reasons in 3.4.
- **Function calling and structured output are both supported** via `langchain-google-genai`,
  which is what you need for the tool-calling node and the citation-schema generator. There's a
  known LangChain-side quirk where `with_structured_output` on Gemini sometimes routes through the
  tool-calling path instead of Gemini's native `responseSchema` — it works, but test it directly
  against `responseMimeType: application/json` + `responseSchema` if you hit inconsistent output.
- **Gemini's own embedding model (`gemini-embedding-2-preview` / `gemini-embedding-001`) is
  available on the same free key**, with selectable output dimensionality (768/1536/3072) and
  `task_type` parameters (`RETRIEVAL_DOCUMENT` vs `RETRIEVAL_QUERY`) that are specifically designed
  for RAG — this is a real advantage over OpenAI, where you'd pay per embedding call from the
  first token.

### 3.3 Where Gemini is NOT suitable, and what to do about it

Be upfront about these in your write-up — reasoning about limitations *is* the senior-engineer
signal:

1. **RPD caps will not survive a live demo plus an eval run plus normal iteration in the same
   day**, especially if you reach for Pro. A 30–50 question RAGAS eval, each question touching the
   grader + generator + hallucination-check nodes (3+ LLM calls per question), can burn 100–150
   calls in one run alone. **Design decision: use Flash (not Pro) for every node, and add Groq
   (Llama 3.3 70B or GPT-OSS-120B, also free, much higher daily caps) as an automatic fallback
   when Gemini returns a 429.** This fallback chain is itself a deliverable worth highlighting —
   it's exactly the "error handling" bullet in the job post, demonstrated with a real failure mode
   instead of a try/except that never triggers.
2. **Free-tier prompts and responses may be used by Google to improve their products** (this
   flips off once you attach billing, even at $0 spend). For a public-handbook demo this is a
   non-issue, but say so explicitly if a prospective client asks — don't let them discover it.
3. **No SLA, and free-tier traffic is deprioritized under load** — fine for a portfolio piece,
   not something you'd ship as-is for a paying client's production traffic. Your write-up should
   frame Gemini-free as "what I used to build and demonstrate the system" and note that swapping
   in a paid key (Gemini, OpenAI, or Claude) is a one-line config change, since you're not hard-
   coding to one provider's SDK quirks (see 3.4).

### 3.4 Why not build on OpenAI or Claude instead, and why not lock in to only Gemini

- **OpenAI**: best-in-class function calling and structured output support, and the job post lists
  it first — worth having as an *option* — but zero free tier means every debug cycle costs money.
  Use it as your documented "swap this in for production" path, not your build-time default.
- **Claude**: the job explicitly lists Claude as an acceptable target model, and Claude's tool-use
  and long-context handling are strong for the agentic-loop and citation-grounding nodes
  specifically — this is worth wiring in as your second real option (not just a mention) precisely
  because a client scanning your proposal for "Claude API" experience will see it actually used, not
  namedropped. No free tier, same cost caveat as OpenAI.
- **Groq**: free, extremely fast (LPU inference, often 10x+ tokens/sec vs comparable GPU-hosted
  APIs), good daily quotas — genuinely competitive with Gemini for a free-tier build. The tradeoff
  is model quality: you get open-weight models (Llama, GPT-OSS, Kimi), which are good but not
  frontier-tier for nuanced grading/hallucination-detection tasks. **This is why the design uses
  Gemini Flash as primary reasoning model and Groq as the fallback, not the reverse** — you want
  your best available model doing the judgment calls (grading, hallucination-checking) and your
  fastest/most-available model absorbing overflow.
- **Local models (Ollama)**: zero cost, zero rate limits, but weaker quality and it removes the
  "I called a real hosted LLM API" signal the job is explicitly testing for. Mention it in your
  write-up as an offline fallback option, don't build the demo around it.

**Net recommendation:** Gemini 2.5/3 Flash as primary (generation, grading, hallucination-check,
tool-arg construction), Gemini's own embedding model for indexing, Groq as automatic fallback on
429s, and both OpenAI and Claude wired in behind a single `LLMProvider` interface so swapping the
default is a config change — this directly demonstrates the job's "OpenAI or Claude API" line
without forcing you to pay to build the demo.

---

## 4. Vector database — why Qdrant, not Pinecone/Weaviate/pgvector

| Option | Verdict | Reasoning |
|---|---|---|
| **Qdrant (chosen)** | ✅ | Free, self-hosted via one Docker container; native hybrid search (dense + sparse vectors in one query, one round trip); payload filtering (metadata like source URL, section, last-updated) is first-class, not bolted on; Rust core means low-latency at small-to-mid scale without tuning. Also has a free managed cloud tier if you want a hosted demo without running your own box. |
| Pinecone | ❌ for this build | Best-known name, listed first in the job post, but it's managed-only — no free self-host — and its free tier is usage-capped in a way that's easy to blow through during iterative eval runs. Fine to mention you *can* target it (LangChain's vector store interface makes swapping trivial), not ideal to build the demo on. |
| Weaviate | ⚠️ viable alternative | Also supports hybrid search natively and has a generous free-tier sandbox; reasonable second choice. Slightly heavier to self-host than Qdrant and its GraphQL-first query API adds a learning curve that doesn't pay for itself at this project's scale. |
| pgvector | ⚠️ worth mentioning, not primary | The job explicitly lists PostgreSQL as a plus, and pgvector lets you keep vectors + your LangGraph checkpoint state + your relational metadata in one database — genuinely elegant for a smaller, simpler deployment. **Recommendation: mention and lightly demonstrate pgvector as an alternate ingestion target in the repo (a second `--backend pgvector` flag), since "I evaluated both and here's the tradeoff" is a stronger signal than picking one and not knowing why.** At GitLab-handbook scale (tens of thousands of chunks), pgvector's HNSW indexing is genuinely competitive with a dedicated vector DB — the gap only opens up at much larger scale or when you need Qdrant's more advanced filtering/quantization features.

**Bottom line on defending this in an interview:** *"I used Qdrant for hybrid search and payload
filtering out of the box, but I also stood up a pgvector path since the client's stack already had
Postgres — that's a one-flag swap because I kept the vector store behind LangChain's interface."*
That sentence alone answers three job-post bullets at once.

---

## 5. Chunking strategy — why header-aware semantic chunking, not fixed-size

- **Fixed-size chunking (e.g. every 500 tokens)** is the default in every tutorial and is exactly
  what breaks on real documents: it slices a policy mid-sentence, separates a heading from its
  content, and produces chunks with no coherent topic — which is why naive RAG demos hallucinate
  so often. It's fast to implement, which is the only argument for it.
- **Chosen approach: markdown header-aware chunking** (split on `##`/`###` boundaries first, then
  sub-split any section that's still too long, with a small overlap at sub-split boundaries only).
  This keeps each chunk topically coherent — critical for two things this project cares about:
  reranking quality (a reranker scores a chunk against a query far more accurately when the chunk
  is a complete idea) and citation accuracy (you're citing "the Remote Work Policy section," not
  an arbitrary character span).
- **Why not fully agentic/LLM-based chunking** (having an LLM decide chunk boundaries): more
  accurate on messy prose, but it costs an LLM call per document at ingestion time for a corpus
  this structured (the Handbook is already well-organized markdown) — the accuracy gain doesn't
  justify the cost or the added ingestion latency. Worth a one-paragraph mention in your write-up
  as "considered and rejected, here's why" — that's a stronger signal than not mentioning it.

---

## 6. Hybrid retrieval + reranking — why not dense-only

- **Dense-only retrieval** (what most portfolio projects stop at) misses exact-match cases badly —
  policy names, ticket IDs, acronyms, specific tool names. Embedding models are good at semantic
  similarity, bad at "the user typed the exact string I need to find."
- **Chosen: hybrid (dense + BM25 sparse), fused, then reranked.** BM25 catches the exact-match
  cases dense retrieval misses; dense catches the semantic-paraphrase cases BM25 misses. Fusing
  both (Qdrant supports this natively in one query) and then reranking the combined candidate set
  is standard in every serious production RAG system as of 2026 — this is table stakes for the
  "hybrid retrieval and reranking" bullet in the job post, not an optional enhancement.
- **Reranker choice: `bge-reranker-v2-m3` (open-weight, self-hosted, free) over Cohere Rerank.**
  Cohere's reranker is excellent but its free trial tier is call-limited in a way that (like
  Pinecone) is easy to exhaust during eval sweeps. BGE-reranker runs locally (CPU-fine at this
  corpus size, faster on a free Colab/Kaggle GPU if you want to batch it), costs nothing per call,
  and its quality is close enough to Cohere's for this scale that the cost/latency tradeoff clearly
  favors self-hosting. Mention Cohere as the "swap-in for scale" option in your write-up.

---

## 7. Orchestration framework — why LangGraph over LlamaIndex or CrewAI

- **LlamaIndex**: excellent for retrieval-heavy pipelines and has strong built-in evaluation
  tooling, but its agent orchestration model is less explicit about state and control flow than
  LangGraph's graph abstraction — harder to show a client "here is exactly where the human-in-
  the-loop gate sits and here is exactly what state persists across it," which is precisely what
  this job wants demonstrated.
- **CrewAI**: role-based multi-agent framework, good for a "team of agents debating" pattern, but
  this job describes a single coherent workflow (search → cite → maybe act) not a multi-agent
  crew — CrewAI would be solving a problem this project doesn't have, and would read as
  over-engineering relative to the actual ask.
- **Chosen: LangGraph**, explicitly named in the job post, reached a stable v1.0 API in October
  2025, and its core primitive — a typed state object moving through nodes and conditional edges,
  with built-in checkpointing — is exactly the right shape for the grader→rewrite loop,
  hallucination→regenerate loop, and the `interrupt_before` human-approval gate. It's also simply
  the framework the client asked for by name.

---

## 8. Agent graph — node-by-node reasoning

Referencing the diagram from the previous message:

1. **Query router** — cheap classification (casual chat vs retrieval-needed vs direct tool
   request) before spending a retrieval + generation cycle on "hey, thanks!" Skipping this and
   always retrieving is the single most common naive-RAG mistake and it's trivial to avoid.
2. **Hybrid retrieval → reranker → grader** — the grader is an LLM call that scores each reranked
   chunk's relevance and, if the whole set is weak, triggers a query rewrite and one retry (capped
   at 2 iterations to bound cost/latency). This loop is what separates "agentic RAG" from "RAG" —
   it's the system correcting for a bad initial query instead of confidently answering from
   garbage context.
3. **Generator with structured citations** — a Pydantic schema forces the model to attach a
   `source_chunk_id` to every claim, not just append a "sources:" list at the end (which models
   frequently hallucinate independent of the actual retrieved content). Structured output makes
   citation-checking mechanical instead of another LLM judgment call.
4. **Hallucination/groundedness check** — a second, cheaper LLM call comparing the generated answer
   against the actual retrieved chunks (not the query). If unsupported, regenerate once with a
   stricter "only state what's directly in the sources" instruction. This is the node that most
   directly answers "add source citations" as a *verified* property, not just a formatting choice.
5. **Tool call, gated by `interrupt_before`** — the graph pauses before executing any write action
   (e.g., filing a GitHub issue from a detected complaint/request in the conversation) and waits
   for explicit approval. This is the single clearest way to demonstrate "human-in-the-loop" as an
   architectural property rather than a slide bullet.
6. **Response + logging** — stream the final answer; log the full trace (which chunks retrieved,
   grader scores, rewrite count, hallucination-check result, tool calls) to LangSmith for
   after-the-fact debugging and to your RAGAS eval harness.

---

## 9. Memory — why a Postgres-backed LangGraph checkpointer

- **In-memory state (the default)** disappears on restart and can't support the eval harness
  replaying past conversations or a real multi-session user. Fine for a first prototype, not for
  the deliverable.
- **Chosen: LangGraph's Postgres checkpointer.** It gives you both short-term memory (conversation
  state within a session, survives process restarts) and a natural place to store long-term user
  preferences, at no added infrastructure cost since you likely already have Postgres running for
  pgvector/metadata. This also directly serves the job's explicit "Memory" bullet and the
  "PostgreSQL is a plus" line simultaneously.

---

## 10. Evaluation — why RAGAS over building your own metrics or skipping eval

- **Skipping formal evaluation** (eyeballing a handful of answers) is the default on most portfolio
  projects and is exactly why "implement evaluation" is called out explicitly in the job post —
  clients have been burned by RAG systems that look fine in a five-question demo and fall apart on
  question six.
- **Chosen: RAGAS**, an open-source framework purpose-built for RAG evaluation with four metrics
  that map directly onto the pipeline's actual failure modes: **faithfulness** (does the answer
  match the retrieved context — catches hallucination), **answer relevancy** (does the answer
  address the question), **context precision** (are the top-ranked chunks actually relevant —
  measures your reranker), **context recall** (did retrieval find everything needed — measures your
  retriever, independent of reranking). Build a 30–50 question gold set by hand from the Handbook
  (question, expected answer, expected source page) — this is real work, and it's exactly the kind
  of artifact a client can look at and trust.
- **Why not a custom eval script**: possible, but RAGAS's metrics are the ones the field has
  converged on for RAG specifically, and citing "faithfulness: 0.91, context precision: 0.86" in
  your case study is immediately legible to anyone who's evaluated a RAG system before — a
  homemade metric requires you to first explain what it measures before the number means anything.

---

## 11. Observability — why LangSmith over building your own logging

LangSmith is built by the LangChain team specifically for LangGraph traces, has a free tier
sufficient for a portfolio project's traffic, and gives you per-node latency/token/cost breakdowns
and full state snapshots at every step with zero instrumentation code beyond setting an env var.
Building equivalent tracing yourself (structured logs + a viewer) is a reasonable production
concern to *mention* you'd do at scale (cost, data residency), but it's not where your limited
build time should go for a demo project — use LangSmith, note the tradeoff in your write-up.

---

## 12. Does this project need a UI / web interface?

**Yes — but a thin one, and here's the reasoning, since this is worth deciding deliberately rather
than defaulting either way:**

- **The job itself is backend-first.** The scope is FastAPI + agent architecture; nothing in the
  post asks for a polished front end, and over-investing in UI at the expense of the agent logic
  would be optimizing the wrong thing.
- **But a portfolio project is judged by whether someone can *see* it work in under a minute**,
  and a client (or anyone reviewing your GitHub) skimming a repo will engage with a live chat demo
  far more readily than with `curl` commands in a README. The UI's job here is entirely
  demonstration, not product.
- **Recommendation: a single-page Streamlit app**, not a custom React/Next build. Reasoning:
  - It's a thin client over your FastAPI backend (or calls the graph directly) — maybe 100–150
    lines — so it doesn't compete for build time with the parts that actually matter for this job.
  - It can show exactly the things worth showing: the streamed answer, the cited source chunks
    with links back to the actual Handbook pages, and — critically — a visible moment where the
    agent pauses for your human-in-the-loop approval before filing a GitHub issue. That one
    interaction, visible in a 30-second screen recording, is worth more than a paragraph of README
    explaining the same thing.
  - A custom React chat UI would look more "product-like" but the job doesn't need that
    impression — it needs "this person ships reliable agent backends" — and the extra build time
    is better spent on the eval harness or the fallback chain, both of which map directly to job-post
    bullets. Don't let UI polish become a way to avoid the harder backend work.
- **What NOT to build:** a multi-page dashboard, user auth, or anything suggesting this is a
  finished product — that would misrepresent scope and invite questions about parts you didn't
  actually build. Keep it to one chat view plus a small "sources" panel.

---

## 13. Deployment

- **Local/dev:** Docker Compose — one container each for FastAPI, Qdrant, Postgres, and (if you
  batch it) the BGE reranker service.
- **Public demo:** deploy the FastAPI + Streamlit combo to a free tier (Render, Fly.io, or
  Hugging Face Spaces for the Streamlit front end specifically — Spaces is free, simple, and a
  familiar link format for anyone reviewing AI portfolios). Qdrant can run on its own free managed
  cloud cluster so you're not paying to host a database for a demo.
- **AWS/Azure (bonus points, don't over-build):** since the job lists these as a plus, it's enough
  to document — not necessarily deploy — a production target: FastAPI on ECS/Container Apps,
  Qdrant or pgvector managed, Postgres on RDS/Azure Database, secrets in Secrets Manager/Key Vault.
  A one-page "how this would move to AWS" section in your README demonstrates the knowledge without
  spending your limited build time standing up infrastructure nobody will look at for a demo.

---

## 14. Cost summary (build + demo phase)

| Component | Cost |
|---|---|
| Gemini Flash (LLM) | $0 (free tier) |
| Gemini embeddings | $0 (free tier) |
| Groq (fallback LLM) | $0 (free tier) |
| Qdrant (self-hosted or free cloud tier) | $0 |
| Postgres (local Docker, or free tier on Neon/Supabase) | $0 |
| BGE reranker (self-hosted) | $0 |
| LangSmith (free tier) | $0 |
| RAGAS | $0 (open source) |
| Hosting (Render/Fly/HF Spaces free tiers) | $0 |
| **Total** | **$0** |

The only place you might spend anything is if you exceed a free hosting tier's sleep/uptime limits
for a sustained public demo — worth a small buffer, not a real cost.

---

## 15. Risks specific to building on free tiers, and how the design mitigates each

| Risk | Mitigation already in the design |
|---|---|
| Gemini 429s during eval runs or live demo | Groq fallback on every LLM call, wired at the provider-interface level, not per-node |
| Free-tier "prompts may be used for training" | Fine for public Handbook data; disclose explicitly in the README so it's never a surprise |
| Free hosting tiers sleep/cold-start | Note expected cold-start latency in the README; not worth paying to avoid for a demo |
| Qdrant free cloud tier storage cap | Corpus is ~2,000 pages — comfortably under any free-tier vector count limit; document the number so it's visibly not a concern |
| Reviewer runs eval and hits Gemini RPD mid-run | Batch eval with rate-limit-aware backoff (`tenacity`) and document the expected run time in the README |

---

## 16. Build roadmap

1. **Week 1** — ingestion pipeline (scrape, header-aware chunk, embed with Gemini embeddings,
   index in Qdrant with BM25 sparse vectors alongside dense).
2. **Week 1–2** — core graph: router → hybrid retrieve → rerank → generate with citations. Get
   this working end-to-end before adding any loop.
3. **Week 2** — grader + query-rewrite loop, hallucination-check + regenerate loop.
4. **Week 2–3** — GitHub tool + `interrupt_before` human approval gate; Postgres checkpointer for
   memory.
5. **Week 3** — Groq fallback chain, structured logging, LangSmith tracing.
6. **Week 3** — RAGAS eval harness + hand-built 30–50 question gold set; run and record results.
7. **Week 3–4** — Streamlit demo UI, Docker Compose, deploy public demo, write the README/case
   study, record the demo video.

---

## 17. Portfolio packaging checklist

- [ ] Public GitHub repo, README with the architecture diagram and a "why these choices" section
      (you can lift most of the reasoning straight from this document)
- [ ] Results table: faithfulness, answer relevancy, context precision/recall, avg latency,
      rewrite-loop trigger rate, hallucination-check catch rate
- [ ] 2–3 minute demo video: one query that triggers the rewrite loop, one that triggers the
      human-in-the-loop tool-call approval — these two moments are the whole pitch
- [ ] Live demo link (Streamlit on HF Spaces or similar)
- [ ] Short written case study: problem → architecture → results → what changes for a real
      client's private data (auth, access control per document, incremental re-ingestion)
- [ ] Upwork proposal paragraph referencing this exact project with the eval numbers included
