"""
Reranks hybrid-search candidates with a self-hosted cross-encoder.

Why bge-reranker-v2-m3 over Cohere Rerank: Cohere's quality is excellent but
its free trial is call-limited in a way that's easy to exhaust during eval
sweeps (identical problem to Pinecone's free tier, see design doc §4/§6).
A self-hosted open-weight cross-encoder costs nothing per call and is close
enough in quality at this project's scale that the cost/latency tradeoff
clearly favors it. Swap in Cohere by replacing this module's `rerank`
function — everything downstream only depends on the (chunk, score) shape.

The model loads once at import time (module-level singleton) rather than
per-call, since re-loading a cross-encoder on every request would dominate
latency.
"""
from sentence_transformers import CrossEncoder

from app.config import settings
from app.retrieval.hybrid_retriever import RetrievedChunk

_model: CrossEncoder | None = None


def _get_model() -> CrossEncoder:
    global _model
    if _model is None:
        _model = CrossEncoder("BAAI/bge-reranker-v2-m3")
    return _model


def rerank(query: str, candidates: list[RetrievedChunk], top_n: int | None = None) -> list[RetrievedChunk]:
    top_n = top_n or settings.rerank_top_n
    if not candidates:
        return []

    model = _get_model()
    pairs = [[query, c.text] for c in candidates]
    scores = model.predict(pairs)

    reranked = sorted(zip(candidates, scores), key=lambda pair: pair[1], reverse=True)
    result = []
    for chunk, score in reranked[:top_n]:
        chunk.score = float(score)  # overwrite fusion score with reranker score
        result.append(chunk)
    return result
