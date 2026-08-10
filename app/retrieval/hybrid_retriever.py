"""
Hybrid retrieval: dense (semantic) + sparse (BM25 exact-match), fused by
Qdrant's native query API in a single round trip. See design doc §6 for
why dense-only retrieval is the most common naive-RAG failure mode this
avoids.
"""
from dataclasses import dataclass

from qdrant_client import QdrantClient
from qdrant_client.models import FusionQuery, Fusion, Prefetch, SparseVector

from app.config import settings
from app.ingestion.embed_index import DENSE_VECTOR_NAME, SPARSE_VECTOR_NAME, _tokenize
from app.llm_providers import get_embeddings


@dataclass
class RetrievedChunk:
    chunk_id: str
    text: str
    source_url: str
    source_title: str
    section: str
    score: float


def _query_sparse_vector(query: str, idf_lookup: dict[str, float] | None = None) -> SparseVector:
    """
    Builds a query-time sparse vector. In production, reuse the BM25 idf
    table saved at ingestion time (persist it alongside the Qdrant
    collection) rather than recomputing a fresh corpus statistic per query.
    """
    tokens = _tokenize(query)
    unique = list(dict.fromkeys(tokens))
    indices = [hash(t) % 100_000 for t in unique]  # placeholder id scheme;
    # swap for the persisted ingestion-time vocabulary in production so
    # query-time term ids line up exactly with indexed term ids.
    values = [1.0 for _ in unique]
    return SparseVector(indices=indices, values=values)


def hybrid_search(query: str, top_k: int | None = None) -> list[RetrievedChunk]:
    top_k = top_k or settings.retrieval_top_k
    client = QdrantClient(url=settings.qdrant_url, api_key=settings.qdrant_api_key or None)

    embeddings = get_embeddings()
    # RETRIEVAL_QUERY task type — Gemini tunes query embeddings differently
    # from document embeddings, so this must not reuse embed_documents().
    dense_query = embeddings.embed_query(query)
    sparse_query = _query_sparse_vector(query)

    results = client.query_points(
        collection_name=settings.qdrant_collection,
        prefetch=[
            Prefetch(query=dense_query, using=DENSE_VECTOR_NAME, limit=top_k),
            Prefetch(query=sparse_query, using=SPARSE_VECTOR_NAME, limit=top_k),
        ],
        # Reciprocal Rank Fusion combines both ranked lists into one —
        # this is the "hybrid" step: neither signal alone decides the result.
        query=FusionQuery(fusion=Fusion.RRF),
        limit=top_k,
    )

    return [
        RetrievedChunk(
            chunk_id=point.payload["chunk_id"],
            text=point.payload["text"],
            source_url=point.payload["source_url"],
            source_title=point.payload["source_title"],
            section=point.payload["section"],
            score=point.score,
        )
        for point in results.points
    ]
