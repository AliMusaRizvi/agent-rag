"""
LLM provider layer.

Design decision (see design doc section 3): Gemini's free tier is the build-
time default because it's genuinely free with no card, but its free-tier
RPD caps *will* be hit during eval sweeps or a busy demo. Rather than let
that show up as a raw 429 crashing a request, every call in this module
goes through `invoke_with_fallback`, which retries on the primary model with
backoff and then transparently falls over to Groq (also free, higher daily
quota, open-weight models) if the primary is still rate-limited.

This is also *the* concrete artifact for the job post's "error handling"
requirement — a fallback chain that actually triggers under load, not a
try/except that never fires.

Every provider is instantiated behind the same LangChain `BaseChatModel`
interface, so nodes in the graph never import a provider SDK directly —
they call `get_primary_llm()` / `get_fallback_llm()`. That's what makes
"swap Gemini for OpenAI or Claude" a one-line change instead of a rewrite.
"""
import logging

from langchain_core.language_models import BaseChatModel
from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings
from langchain_groq import ChatGroq
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from app.config import settings

logger = logging.getLogger(__name__)


class RateLimitError(Exception):
    """Raised (and caught) to trigger the fallback path."""


def get_primary_llm(temperature: float = 0.0) -> BaseChatModel:
    """Gemini Flash — used for generation, grading, hallucination-check, tool args."""
    return ChatGoogleGenerativeAI(
        model=settings.primary_llm_model,
        google_api_key=settings.google_api_key,
        temperature=temperature,
    )


def get_fallback_llm(temperature: float = 0.0) -> BaseChatModel:
    """Groq — open-weight model, much higher free-tier daily quota, used on overflow."""
    return ChatGroq(
        model=settings.fallback_llm_model,
        groq_api_key=settings.groq_api_key,
        temperature=temperature,
    )


def get_openai_llm(temperature: float = 0.0) -> BaseChatModel:
    """Swap-in option — directly answers the job post's 'OpenAI API' line."""
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(model="gpt-4o-mini", api_key=settings.openai_api_key, temperature=temperature)


def get_claude_llm(temperature: float = 0.0) -> BaseChatModel:
    """Swap-in option — directly answers the job post's 'Claude API' line."""
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(
        model="claude-sonnet-4-5", api_key=settings.anthropic_api_key, temperature=temperature
    )


def get_embeddings() -> GoogleGenerativeAIEmbeddings:
    """
    Gemini's own embedding model, free on the same key as the chat model.
    task_type is set per-call at index vs. query time (see hybrid_retriever.py)
    because Gemini's embeddings are tuned differently for each — using the
    same embedding for both is a common accuracy mistake worth avoiding.
    """
    return GoogleGenerativeAIEmbeddings(
        model=settings.embedding_model,
        google_api_key=settings.google_api_key,
        output_dimensionality=settings.embedding_dim,
    )


def _is_rate_limit(exc: Exception) -> bool:
    msg = str(exc).lower()
    return "429" in msg or "rate limit" in msg or "quota" in msg or "resource_exhausted" in msg


@retry(
    retry=retry_if_exception_type(RateLimitError),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    reraise=True,
)
def _invoke_primary(llm: BaseChatModel, *args, **kwargs):
    try:
        return llm.invoke(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001 - deliberately broad, classified below
        if _is_rate_limit(exc):
            raise RateLimitError(str(exc)) from exc
        raise


def invoke_with_fallback(prompt_or_messages, schema=None, temperature: float = 0.0):
    """
    The single entry point every graph node should call for an LLM turn.

    1. Try Gemini (with short exponential-backoff retries for transient 429s).
    2. If Gemini is still rate-limited after retries, fall over to Groq.
    3. Apply `schema` via `with_structured_output` on whichever model succeeds,
       so callers get a validated Pydantic object either way.
    """
    primary = get_primary_llm(temperature)
    target_primary = primary.with_structured_output(schema) if schema else primary

    try:
        return _invoke_primary(target_primary, prompt_or_messages)
    except RateLimitError:
        logger.warning("Gemini rate-limited after retries — falling back to Groq.")
        fallback = get_fallback_llm(temperature)
        target_fallback = fallback.with_structured_output(schema) if schema else fallback
        return target_fallback.invoke(prompt_or_messages)
