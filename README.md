# Enterprise Knowledge Agent

An agentic RAG system built on LangGraph over GitLab's public Handbook, with
hybrid retrieval, reranking, verified source citations, a query-rewrite loop,
a hallucination-check loop, and human-approved tool calling against a live
GitHub API. Built as a portfolio project targeting production-RAG Upwork
roles — every architectural decision is documented and defended in
`docs/DESIGN_DOC.md`.

## Why this exists

See `docs/DESIGN_DOC.md` for the full reasoning behind every choice
(dataset, LLM provider, vector DB, chunking strategy, framework, evaluation).
This README is just the "how to run it" half.

## Architecture

```
router -> [retrieve -> grade -> (rewrite loop)] -> generate -> hallucination_check -> (regenerate loop) -> finalize
       -> chat -> END
       -> prepare_tool_call -> [HUMAN APPROVAL GATE] -> execute_tool -> END
```

## Quickstart

1. Copy `.env.example` to `.env` and fill in `GOOGLE_API_KEY` (free at
   https://aistudio.google.com/apikey) and `GROQ_API_KEY` (free at
   https://console.groq.com/keys) at minimum. Everything else has a
   working default for local Docker Compose.

2. Start the stack:
   ```bash
   docker compose up --build
   ```

3. Ingest the knowledge base (run once):
   ```bash
   curl -X POST http://localhost:8000/ingest
   ```

4. Chat:
   ```bash
   curl -X POST http://localhost:8000/chat \
     -H "Content-Type: application/json" \
     -d '{"message": "What is GitLab'\''s remote work policy?"}'
   ```

5. Try the human-in-the-loop path:
   ```bash
   curl -X POST http://localhost:8000/chat \
     -H "Content-Type: application/json" \
     -d '{"message": "File an issue: the onboarding docs link is broken"}'
   # -> returns requires_approval: true and pending_tool_args
   curl -X POST http://localhost:8000/approve-tool \
     -H "Content-Type: application/json" \
     -d '{"thread_id": "<thread_id from previous response>", "approved": true}'
   ```

## Evaluation

```bash
python -m app.eval.ragas_eval
```

Expand `app/eval/gold_set_sample.json` past its 3-question starter set to
30-50 questions before treating the output as a real reportable result.

## Project layout

```
app/
  config.py              # all settings, one place
  schemas.py              # structured-output Pydantic models
  llm_providers.py         # Gemini primary + Groq fallback + OpenAI/Claude swap-ins
  ingestion/               # scrape -> chunk -> embed -> index
  retrieval/               # hybrid search + reranker
  graph/                   # LangGraph state, nodes, wiring
  tools/                   # GitHub issue tool
  memory/                  # checkpointer notes
  api/                     # FastAPI app
  eval/                    # RAGAS harness + gold set
docs/
  DESIGN_DOC.md            # full reasoning for every decision
  UI_SPEC.md               # spec for the React/TS frontend
  LEARNING_GUIDE.md         # what to study, in what order, and why
```

## Frontend

This repo is backend-only by design (see design doc §12 — a thin UI is a
demo aid, not the point of this job). Build the frontend separately in
Loveable or Google AI Studio using `docs/UI_SPEC.md` as the spec — it talks
to the two endpoints above (`/chat`, `/approve-tool`) and nothing else.
