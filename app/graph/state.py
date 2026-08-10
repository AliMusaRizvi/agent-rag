"""
The single state object that flows through every node in the graph.

Why a TypedDict, and why everything relevant to the conversation lives
here: LangGraph nodes are pure functions of (state) -> partial state update.
Keeping every piece of intermediate work (retrieved chunks, grades, rewrite
count, generated answer, hallucination verdict, pending tool call) visible
in one state object is what makes the graph's execution fully inspectable
in LangSmith — you can look at any point in a trace and see exactly what
the agent knew at that step. That's the debuggability payoff of choosing
LangGraph's explicit-state model over an implicit agent loop.
"""
import operator
from typing import Annotated, Literal, TypedDict

from app.retrieval.hybrid_retriever import RetrievedChunk
from app.schemas import CitedAnswer, GitHubIssueArgs


class GraphState(TypedDict, total=False):
    # conversation
    messages: Annotated[list, operator.add]
    user_query: str

    # routing
    route: Literal["retrieve", "tool_call", "chat"]

    # retrieval
    retrieved_chunks: list[RetrievedChunk]
    reranked_chunks: list[RetrievedChunk]
    grading_sufficient: bool
    rewrite_count: int

    # generation
    cited_answer: CitedAnswer | None
    hallucination_ok: bool
    hallucination_retry_count: int

    # tool calling / human-in-the-loop
    pending_tool_args: GitHubIssueArgs | None
    tool_approved: bool | None
    tool_result_url: str | None

    # final
    final_response: str
