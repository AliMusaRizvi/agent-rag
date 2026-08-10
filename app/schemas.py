"""
Structured-output schemas.

Why: every LLM call in this pipeline that needs to be *checked* by code
(citations, relevance grades, hallucination verdicts, tool arguments) uses
one of these schemas via `llm.with_structured_output(schema)` instead of
asking the model to format free text and regex-parsing it afterwards.
Free-text parsing is the single most common source of "works in the demo,
breaks in production" bugs in RAG systems — structured output pushes the
formatting burden onto the model's function-calling/JSON mode, which is
far more reliable than string parsing.
"""
from typing import Literal
from pydantic import BaseModel, Field


class RouteDecision(BaseModel):
    """Output of the router node: where should this turn go?"""
    route: Literal["retrieve", "tool_call", "chat"] = Field(
        description=(
            "'retrieve' if the user is asking something answerable from the "
            "knowledge base. 'tool_call' if they are explicitly asking to take "
            "an action (e.g. file a ticket). 'chat' for greetings/small talk "
            "that need no retrieval."
        )
    )
    reasoning: str = Field(description="One short sentence explaining the choice.")


class RelevanceGrade(BaseModel):
    """Per-chunk relevance grade produced by the grader node."""
    chunk_id: str
    is_relevant: bool
    reason: str = Field(description="One short sentence justifying the grade.")


class GradingResult(BaseModel):
    grades: list[RelevanceGrade]
    overall_sufficient: bool = Field(
        description="True if enough relevant chunks were found to answer the question."
    )


class QueryRewrite(BaseModel):
    rewritten_query: str = Field(
        description="A reformulated search query, more specific or differently "
        "worded than the original, designed to retrieve better chunks."
    )
    rationale: str


class Citation(BaseModel):
    chunk_id: str = Field(description="ID of the source chunk this claim is grounded in.")
    source_url: str


class CitedAnswer(BaseModel):
    """
    The generator node's output. Every factual sentence in `answer` must be
    traceable to at least one entry in `citations` — this is what turns
    "cite your sources" from a prompt-engineering hope into something the
    hallucination-check node can actually verify against real chunk IDs.
    """
    answer: str
    citations: list[Citation]
    confidence: Literal["high", "medium", "low"] = Field(
        description="Model's own confidence that the retrieved context fully "
        "supports this answer."
    )


class HallucinationCheck(BaseModel):
    is_grounded: bool = Field(
        description="True only if every claim in the answer is directly "
        "supported by the cited chunks' text."
    )
    unsupported_claims: list[str] = Field(
        default_factory=list,
        description="Any sentences in the answer not backed by the cited chunks.",
    )


class GitHubIssueArgs(BaseModel):
    """Structured args for the tool-call node, gated behind human approval."""
    title: str
    body: str
    labels: list[str] = Field(default_factory=list)
