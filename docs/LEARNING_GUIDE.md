# Learning Guide — Enterprise Knowledge Agent

This codebase touches a lot of concepts at once. This guide orders them so
you can learn them in a sequence that builds on itself, ties each one to
the exact file in this repo where it's used, and gives one small exercise
per topic so the learning isn't passive. Work through it top to bottom;
each phase assumes the previous one.

---

## Phase 1 — Foundations you need before any of this makes sense

### 1.1 Pydantic v2 (data validation)
**Where it's used:** `app/schemas.py`, `app/config.py` — every structured
LLM output and every setting is a Pydantic model.
**Why it matters here:** structured output (Phase 6) only works because the
model can be told "fill in this exact schema." If you're not comfortable
with `BaseModel`, `Field`, and nested models, start here.
**Learn:** the official Pydantic docs' "Models" and "Validators" pages
(docs.pydantic.dev) — you need maybe 2 hours, not the whole reference.
**Exercise:** add a new field `severity: Literal["low","medium","high"]`
to `GitHubIssueArgs` in `schemas.py`, then update `prepare_tool_call_node`
in `nodes.py` to ask the model to fill it in.

### 1.2 Async Python basics
**Where it's used:** FastAPI (`app/api/main.py`) is built for async, even
though this codebase currently calls things synchronously for simplicity.
**Learn:** RealPython's "Async IO in Python" is the best single primer.
**Exercise:** convert the `/chat` endpoint in `main.py` to `async def` and
use `await compiled_graph.ainvoke(...)` instead of `.invoke(...)` — this
is genuinely worth doing before you deploy, not just an exercise.

### 1.3 REST API design with FastAPI
**Where it's used:** `app/api/main.py`.
**Learn:** FastAPI's own tutorial (fastapi.tiangolo.com/tutorial) — it's
unusually good and you only need the first ~6 sections (path operations,
request bodies, response models, error handling).
**Exercise:** add a `/history/{thread_id}` endpoint that returns the full
message history for a thread using the checkpointer's `get_state()` method.

---

## Phase 2 — Embeddings and vector search

### 2.1 What an embedding actually is
**Where it's used:** `app/llm_providers.py::get_embeddings`,
`app/ingestion/embed_index.py`.
**Concept:** a piece of text becomes a fixed-length vector of numbers such
that "similar meaning" texts end up as vectors that are close together
(measured by cosine similarity). This is the entire basis of semantic
search.
**Learn:** Google's own "Embeddings" guide at ai.google.dev — read it
alongside the code in `hybrid_retriever.py` so the `task_type` parameter
(`RETRIEVAL_DOCUMENT` vs `RETRIEVAL_QUERY`) makes sense — Gemini tunes
embeddings differently depending on which side of the search they're on,
which is a detail most tutorials skip.
**Exercise:** write a 10-line script that embeds two similar sentences and
two unrelated ones with `get_embeddings()`, then prints cosine similarity
between each pair — you should see the similar pair score much higher.

### 2.2 Vector databases and why they exist
**Where it's used:** `app/ingestion/embed_index.py`,
`app/retrieval/hybrid_retriever.py`.
**Concept:** brute-force comparing a query vector against millions of
stored vectors doesn't scale — vector DBs use approximate-nearest-neighbor
indexes (HNSW is the one Qdrant, Weaviate, and pgvector all use) to make
this fast at scale.
**Learn:** Qdrant's own "Concepts" docs (qdrant.tech/documentation) —
specifically the pages on collections, points, and filtering.
**Exercise:** open Qdrant's local dashboard (`http://localhost:6333/dashboard`
once Docker Compose is running) after ingestion and browse the indexed
points — seeing the actual stored payload makes the abstraction concrete.

### 2.3 Sparse retrieval / BM25
**Where it's used:** `app/ingestion/embed_index.py::_build_bm25_sparse_vectors`.
**Concept:** BM25 is a decades-old keyword-ranking algorithm (term
frequency weighted by how rare/distinctive the term is across the corpus)
— it's what powers "exact match" search and is what dense embeddings
alone tend to miss.
**Learn:** the original BM25 explanation on Elastic's blog ("Practical BM25")
is the clearest walkthrough available.
**Exercise:** search for a specific policy name (e.g. an exact phrase from
the Handbook) using only `hybrid_search` with the sparse vector removed —
compare results with and without it to see the effect directly.

### 2.4 Hybrid search and fusion (RRF)
**Where it's used:** `app/retrieval/hybrid_retriever.py::hybrid_search`.
**Concept:** Reciprocal Rank Fusion combines two independently ranked
result lists (dense and sparse) into one, weighting by rank position
rather than raw score — this avoids the problem of dense and sparse
scores not being on comparable scales.
**Learn:** Qdrant's "Hybrid Queries" docs page walks through exactly the
`Prefetch` + `FusionQuery` pattern used in this repo.

### 2.5 Reranking / cross-encoders
**Where it's used:** `app/retrieval/reranker.py`.
**Concept:** embeddings (bi-encoders) score query and document
independently, which is fast but less accurate. A cross-encoder scores
the (query, document) pair *together*, which is slower but much more
accurate — the standard pattern is: retrieve broadly and cheaply with a
bi-encoder, then rerank the top candidates with a cross-encoder.
**Learn:** the Sentence-Transformers docs page on Cross-Encoders
(sbert.net) explains the bi-encoder vs cross-encoder distinction clearly.
**Exercise:** print the fusion score vs. the reranker score for the same
chunks side by side — you'll usually see the reranker reorder the top
results, which is the whole point of the step.

---

## Phase 3 — LangChain fundamentals

### 3.1 Chat models and the provider abstraction
**Where it's used:** `app/llm_providers.py`.
**Concept:** LangChain wraps every provider (Gemini, Groq, OpenAI, Claude)
behind the same `BaseChatModel` interface (`.invoke()`, `.stream()`), so
code written against the interface doesn't care which provider is behind
it.
**Learn:** LangChain's "Chat models" conceptual docs (python.langchain.com).
**Exercise:** add a `get_openai_llm()`-style function for a fifth provider
of your choice (e.g. Mistral) and confirm it slots into
`invoke_with_fallback` with zero changes elsewhere.

### 3.2 Structured output
**Where it's used:** every node in `app/graph/nodes.py` that passes a
`schema=` argument to `invoke_with_fallback`.
**Concept:** `llm.with_structured_output(SomeModel)` makes the model
return JSON matching your Pydantic schema (via native JSON mode or
function-calling under the hood, depending on the provider) instead of
free text you'd have to parse yourself.
**Learn:** LangChain's "Structured output" how-to guide.
**Exercise:** deliberately break a schema (e.g. make a field required that
the model can't infer from context) and observe what error you get — this
teaches you how to debug it when it happens for real.

### 3.3 Tool calling
**Where it's used:** `app/tools/github_tool.py`,
`app/graph/nodes.py::prepare_tool_call_node`.
**Concept:** giving the model a schema for "here's an action you can
request" and having it produce structured arguments for that action —
this project deliberately separates "the model decides to call a tool"
from "the tool actually executes" with a human approval step in between.
**Learn:** LangChain's "Tool calling" conceptual docs.

---

## Phase 4 — LangGraph and agentic patterns

### 4.1 Why a graph instead of a chain
**Where it's used:** the whole `app/graph/` directory.
**Concept:** a chain is a straight line (A then B then C). Real agent
behavior needs branches (the router), loops (grader→rewrite,
hallucination→regenerate), and pauses (human approval) — a graph with
conditional edges expresses all three; a chain can't.
**Learn:** the official LangGraph tutorial (langchain-ai.github.io/langgraph)
— specifically "Graph API basics" and "Add conditional edges."
**Exercise:** draw the graph in `build_graph.py` on paper from the edge
definitions alone, before looking at the diagram in the design doc — then
compare. This is the single best exercise for actually understanding
LangGraph's model.

### 4.2 State and reducers
**Where it's used:** `app/graph/state.py`.
**Concept:** `GraphState` is a `TypedDict` — each node returns a *partial*
update, and LangGraph merges it into the running state. The
`Annotated[list, operator.add]` on `messages` is a reducer telling
LangGraph to append rather than overwrite for that field specifically.
**Learn:** LangGraph's "State management" docs page — pay close attention
to the difference between default (overwrite) and reducer-based merging.

### 4.3 Conditional edges and loops
**Where it's used:** `should_rewrite` and `should_regenerate` in
`nodes.py`, wired in `build_graph.py`.
**Concept:** a conditional edge is a function of state that returns which
node to go to next — this is how the grader's verdict actually controls
whether the graph loops back to `rewrite` or moves on to `generate`.
**Exercise:** temporarily set `max_rewrite_loops` to 0 in `config.py` and
observe the graph always skip straight to generation regardless of grade
— confirms you understand exactly where that cap is enforced.

### 4.4 Checkpointing and persistence
**Where it's used:** `app/graph/build_graph.py` (`PostgresSaver`),
`app/memory/checkpointer.py`.
**Concept:** every step's state is saved keyed by `thread_id`, which is
what makes multi-turn conversations survive process restarts and — more
importantly for this project — is what makes the human-in-the-loop
interrupt actually resumable later, possibly from a completely different
process/request.
**Learn:** LangGraph's "Persistence" docs page.

### 4.5 Human-in-the-loop (`interrupt_before`)
**Where it's used:** `build_graph.py`'s `.compile(interrupt_before=[...])`,
and the two-step `/chat` → `/approve-tool` flow in `api/main.py`.
**Concept:** the graph literally stops executing before the named node and
returns control to your code. Nothing resumes it except your code calling
`.invoke(None, config=...)` again on the same thread — which is exactly
why this is a *real* safety gate and not just a UI confirmation dialog
that a determined script could skip.
**Learn:** LangGraph's "Human-in-the-loop" docs page — read this one
carefully, it's the concept in this project most worth deeply
understanding, since it's also the most commonly *faked* in portfolio
projects (a UI "Are you sure?" dialog with no actual execution pause
behind it is not the same thing).

---

## Phase 5 — Evaluation and observability

### 5.1 Why RAG needs its own evaluation metrics
**Where it's used:** `app/eval/ragas_eval.py`.
**Concept:** generic LLM eval (did it answer correctly) misses two things
specific to RAG: whether the answer is actually grounded in what was
retrieved (faithfulness) and whether retrieval itself did its job
(context precision/recall) — a good answer can come from bad retrieval by
luck, and RAGAS's metrics are designed to catch that.
**Learn:** the RAGAS documentation's "Core Concepts" page (docs.ragas.io)
— read the metric definitions before running the eval script, so the
numbers mean something when you see them.
**Exercise:** manually write 10 more gold-set questions, run the eval, and
for any question that scores low on `context_recall`, go look at why —
usually it's a chunking or retrieval gap, and tracing a specific bad score
back to a specific pipeline stage is the actual skill here.

### 5.2 Tracing agent execution
**Where it's used:** implied by `LANGCHAIN_TRACING_V2` in `config.py` —
set the env var and every graph run automatically traces to LangSmith.
**Concept:** with a multi-node, looping graph, "why did it answer that"
is not answerable by reading final output alone — a trace shows the exact
state at every node, every LLM call's prompt/response, and every
conditional edge decision.
**Learn:** LangSmith's "Tracing" quickstart — it requires zero code
changes beyond env vars for a LangGraph app, so this is a 10-minute setup
with a large debugging payoff.

---

## Phase 6 — Production concerns

### 6.1 Retries and fallback chains
**Where it's used:** `app/llm_providers.py::invoke_with_fallback`.
**Concept:** distinguishing *transient* failures (worth retrying, like a
429) from *permanent* ones (worth failing fast on, like a malformed
request) is the core skill in `tenacity`-based retry logic — retrying a
permanent error just wastes time and hides the real bug.
**Learn:** the `tenacity` library's own README — it's short and the
`retry_if_exception_type` pattern used in this repo is close to the
simplest real-world case.

### 6.2 Containerization
**Where it's used:** `Dockerfile`, `docker-compose.yml`.
**Learn:** Docker's official "Get Started" tutorial if you haven't built
a multi-service Compose file before — you need the concepts of services,
volumes, and inter-container networking (note how the app connects to
`qdrant:6333` and `postgres:5432` by service name, not `localhost`).

---

## Suggested order to actually work through this repo

1. Get Docker Compose running, run `/ingest`, and query `/chat` — see it
   work end-to-end before reading any more code.
2. Read `app/graph/state.py` then `app/graph/nodes.py` then
   `app/graph/build_graph.py`, in that order — state, then what mutates
   it, then how it's wired.
3. Trace one full request in LangSmith once you've set that up — this
   makes the graph concrete in a way reading code alone doesn't.
4. Do the Phase 4.3 and 4.5 exercises — they're the two concepts most
   worth deeply internalizing before you claim "agentic RAG" experience
   in an interview.
5. Extend the eval gold set and actually look at where scores are weak —
   this is what turns "I used RAGAS" into "I can tell you exactly where
   my retrieval was weak and why."

## Where to go next (past this project)

- **Knowledge graphs / GraphRAG** — for multi-hop questions ("which team
  owns the policy that references X") that pure vector retrieval handles
  poorly. Start with Neo4j's own GraphRAG documentation.
- **MCP (Model Context Protocol)** — exposing this repo's retriever as an
  MCP server would let it plug directly into Claude Desktop or Claude
  Code. Anthropic's MCP docs (modelcontextprotocol.io) are the primary
  source; this is explicitly listed as a "plus" in the target job post and
  is a strong differentiator for 2026 given how fast MCP adoption is
  moving.
- **pgvector** — build the alternate ingestion path mentioned in the
  design doc (§4) to be able to speak concretely to "I evaluated Qdrant vs
  pgvector for this" in an interview, not just cite the tradeoff secondhand.
