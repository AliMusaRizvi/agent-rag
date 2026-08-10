"""
Node functions. Each is a pure function: (GraphState) -> partial state update.

Read alongside design doc §8 ("Agent graph — node-by-node reasoning") for
the *why* behind each node's existence; comments here focus on the *how*.
"""
import logging

from app.config import settings
from app.llm_providers import invoke_with_fallback
from app.retrieval.hybrid_retriever import hybrid_search
from app.retrieval.reranker import rerank
from app.schemas import (
    CitedAnswer,
    GitHubIssueArgs,
    GradingResult,
    HallucinationCheck,
    QueryRewrite,
    RouteDecision,
)
from app.graph.state import GraphState

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------
# 1. Router — avoids spending a retrieval+generation cycle on small talk.
# --------------------------------------------------------------------------
def router_node(state: GraphState) -> dict:
    prompt = (
        "Classify this user message.\n\n"
        f"Message: {state['user_query']}\n\n"
        "Return 'retrieve' if it needs looking something up in the knowledge base, "
        "'tool_call' if the user explicitly wants an action taken (e.g. file a "
        "ticket/issue), or 'chat' for greetings/small talk."
    )
    decision: RouteDecision = invoke_with_fallback(prompt, schema=RouteDecision)
    logger.info("Router -> %s (%s)", decision.route, decision.reasoning)
    return {"route": decision.route}


# --------------------------------------------------------------------------
# 2. Hybrid retrieval + reranking
# --------------------------------------------------------------------------
def retrieve_node(state: GraphState) -> dict:
    query = state.get("rewritten_query") or state["user_query"]
    candidates = hybrid_search(query, top_k=settings.retrieval_top_k)
    top = rerank(query, candidates, top_n=settings.rerank_top_n)
    return {"retrieved_chunks": candidates, "reranked_chunks": top}


# --------------------------------------------------------------------------
# 3. Grader — scores each reranked chunk; decides if a rewrite is needed
# --------------------------------------------------------------------------
def grade_node(state: GraphState) -> dict:
    chunks = state["reranked_chunks"]
    chunk_text = "\n\n".join(f"[{c.chunk_id}] {c.text[:500]}" for c in chunks)
    prompt = (
        f"User question: {state['user_query']}\n\n"
        f"Candidate chunks:\n{chunk_text}\n\n"
        "For each chunk, decide if it is relevant to answering the question. "
        "Then decide overall_sufficient: true only if, together, the relevant "
        "chunks contain enough information to answer the question fully."
    )
    result: GradingResult = invoke_with_fallback(prompt, schema=GradingResult)

    relevant_ids = {g.chunk_id for g in result.grades if g.is_relevant}
    filtered = [c for c in chunks if c.chunk_id in relevant_ids] or chunks

    return {"reranked_chunks": filtered, "grading_sufficient": result.overall_sufficient}


def should_rewrite(state: GraphState) -> str:
    """Conditional edge: loop back to rewrite, or move on to generation."""
    if state.get("grading_sufficient"):
        return "generate"
    if state.get("rewrite_count", 0) >= settings.max_rewrite_loops:
        # Cap hit — proceed with what we have rather than loop forever.
        # This bound is what keeps cost/latency predictable (design doc §8).
        return "generate"
    return "rewrite"


# --------------------------------------------------------------------------
# 4. Query rewrite — triggered when the grader finds the retrieved set weak
# --------------------------------------------------------------------------
def rewrite_node(state: GraphState) -> dict:
    prompt = (
        f"The original search query '{state['user_query']}' did not retrieve "
        "sufficient relevant results from the knowledge base. Rewrite it to be "
        "more specific or to use different terminology that might match the "
        "source documents better."
    )
    rewrite: QueryRewrite = invoke_with_fallback(prompt, schema=QueryRewrite)
    logger.info("Query rewritten: %s -> %s", state["user_query"], rewrite.rewritten_query)
    return {
        "rewritten_query": rewrite.rewritten_query,
        "rewrite_count": state.get("rewrite_count", 0) + 1,
    }


# --------------------------------------------------------------------------
# 5. Generator — structured, cited answer (see schemas.CitedAnswer)
# --------------------------------------------------------------------------
def generate_node(state: GraphState) -> dict:
    chunks = state["reranked_chunks"]
    context = "\n\n".join(
        f"[chunk_id: {c.chunk_id} | source: {c.source_url}]\n{c.text}" for c in chunks
    )
    prompt = (
        f"Answer the user's question using ONLY the context below. "
        f"Every claim must cite the chunk_id(s) it came from.\n\n"
        f"Question: {state['user_query']}\n\nContext:\n{context}"
    )
    answer: CitedAnswer = invoke_with_fallback(prompt, schema=CitedAnswer)
    return {"cited_answer": answer}


# --------------------------------------------------------------------------
# 6. Hallucination check — verifies the answer against the *actual* chunk text
# --------------------------------------------------------------------------
def hallucination_check_node(state: GraphState) -> dict:
    answer = state["cited_answer"]
    cited_ids = {c.chunk_id for c in answer.citations}
    cited_chunks = [c for c in state["reranked_chunks"] if c.chunk_id in cited_ids]
    source_text = "\n\n".join(f"[{c.chunk_id}] {c.text}" for c in cited_chunks)

    prompt = (
        f"Answer to verify: {answer.answer}\n\n"
        f"Source chunks it claims to be grounded in:\n{source_text}\n\n"
        "Is every claim in the answer directly supported by these chunks? "
        "List any sentence that is NOT supported."
    )
    check: HallucinationCheck = invoke_with_fallback(prompt, schema=HallucinationCheck)
    return {"hallucination_ok": check.is_grounded}


def should_regenerate(state: GraphState) -> str:
    if state.get("hallucination_ok"):
        return "finalize"
    if state.get("hallucination_retry_count", 0) >= settings.max_hallucination_retries:
        return "finalize"  # proceed but the final response should flag low confidence
    return "regenerate"


def prepare_regenerate_node(state: GraphState) -> dict:
    return {"hallucination_retry_count": state.get("hallucination_retry_count", 0) + 1}


# --------------------------------------------------------------------------
# 7. Tool-arg construction (runs before the human-in-the-loop interrupt)
# --------------------------------------------------------------------------
def prepare_tool_call_node(state: GraphState) -> dict:
    prompt = (
        f"The user wants to file a GitHub issue based on this request: "
        f"{state['user_query']}\n\n"
        "Draft a clear title and body for the issue."
    )
    args: GitHubIssueArgs = invoke_with_fallback(prompt, schema=GitHubIssueArgs)
    return {"pending_tool_args": args}


def execute_tool_node(state: GraphState) -> dict:
    """
    Only reached after the graph resumes past the interrupt with
    tool_approved=True (see graph/build_graph.py and api/main.py for how the
    approval is collected from the human and fed back in).
    """
    from app.tools.github_tool import create_github_issue

    if not state.get("tool_approved"):
        return {"final_response": "Tool call was not approved — no action taken."}

    url = create_github_issue(state["pending_tool_args"])
    return {"tool_result_url": url, "final_response": f"Created issue: {url}"}


# --------------------------------------------------------------------------
# 8. Finalize — assembles the response actually shown to the user
# --------------------------------------------------------------------------
def finalize_node(state: GraphState) -> dict:
    answer = state["cited_answer"]
    sources = "\n".join(f"- {c.source_url}" for c in answer.citations)
    grounded_note = "" if state.get("hallucination_ok") else "\n\n_Note: this answer could not be fully verified against sources — treat with extra caution._"
    response = f"{answer.answer}\n\nSources:\n{sources}{grounded_note}"
    return {"final_response": response}


def chat_node(state: GraphState) -> dict:
    """Handles the 'chat' route — no retrieval needed."""
    response = invoke_with_fallback(state["user_query"])
    return {"final_response": response.content if hasattr(response, "content") else str(response)}
