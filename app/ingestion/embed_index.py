"""
Embeds and indexes chunks into Qdrant.

Why Qdrant specifically, and why both dense AND sparse vectors in the same
collection: see design doc §4 and §6. Short version — dense embeddings catch
semantic paraphrase, BM25 sparse catches exact-match (policy names, tool
names, IDs) that dense retrieval frequently misses. Qdrant supports storing
and querying both in a single collection/round-trip, which is why it was
chosen over a dense-only store.

Run as a script: `python -m app.ingestion.embed_index`
"""
import logging

from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    NamedSparseVector,
    NamedVector,
    PointStruct,
    SparseVector,
    SparseVectorParams,
    VectorParams,
)
from rank_bm25 import BM25Okapi

from app.config import settings
from app.ingestion.chunker import Chunk, chunk_pages
from app.ingestion.scraper import fetch_pages
from app.llm_providers import get_embeddings

logger = logging.getLogger(__name__)

DENSE_VECTOR_NAME = "dense"
SPARSE_VECTOR_NAME = "sparse"


def _tokenize(text: str) -> list[str]:
    return text.lower().split()


def _build_bm25_sparse_vectors(chunks: list[Chunk]) -> list[SparseVector]:
    """
    Builds a BM25 model over the whole corpus and converts each chunk's BM25
    term weights into Qdrant's sparse vector format (indices + values).
    This is what gives Qdrant's hybrid query the "exact match" half of
    retrieval, alongside the dense embedding's semantic half.
    """
    tokenized = [_tokenize(c.text) for c in chunks]
    bm25 = BM25Okapi(tokenized)

    # Build a stable vocabulary index -> BM25 needs a fixed term->id mapping
    # to produce comparable sparse vectors across documents.
    vocab = {term: idx for idx, term in enumerate(bm25.idf.keys())}

    sparse_vectors = []
    for tokens in tokenized:
        term_counts: dict[str, int] = {}
        for t in tokens:
            term_counts[t] = term_counts.get(t, 0) + 1

        indices, values = [], []
        for term, count in term_counts.items():
            if term not in vocab:
                continue
            idf = bm25.idf.get(term, 0.0)
            # simplified BM25 term weight (idf * tf), sufficient for a
            # sparse-vector retrieval signal — Qdrant handles the rest
            weight = idf * count
            if weight > 0:
                indices.append(vocab[term])
                values.append(float(weight))

        sparse_vectors.append(SparseVector(indices=indices, values=values))

    return sparse_vectors


def ensure_collection(client: QdrantClient) -> None:
    if client.collection_exists(settings.qdrant_collection):
        return
    client.create_collection(
        collection_name=settings.qdrant_collection,
        vectors_config={DENSE_VECTOR_NAME: VectorParams(size=settings.embedding_dim, distance=Distance.COSINE)},
        sparse_vectors_config={SPARSE_VECTOR_NAME: SparseVectorParams()},
    )
    logger.info("Created Qdrant collection '%s'", settings.qdrant_collection)


def index_chunks(chunks: list[Chunk]) -> None:
    client = QdrantClient(url=settings.qdrant_url, api_key=settings.qdrant_api_key or None)
    ensure_collection(client)

    embeddings = get_embeddings()
    # task_type=RETRIEVAL_DOCUMENT is Gemini-specific tuning for indexed
    # content vs. RETRIEVAL_QUERY used at search time (see hybrid_retriever.py)
    dense_vectors = embeddings.embed_documents([c.text for c in chunks])
    sparse_vectors = _build_bm25_sparse_vectors(chunks)

    points = [
        PointStruct(
            id=i,
            vector={DENSE_VECTOR_NAME: dense_vectors[i], SPARSE_VECTOR_NAME: sparse_vectors[i]},
            payload={
                "chunk_id": chunk.chunk_id,
                "text": chunk.text,
                "source_url": chunk.source_url,
                "source_title": chunk.source_title,
                "section": chunk.section,
            },
        )
        for i, chunk in enumerate(chunks)
    ]

    client.upsert(collection_name=settings.qdrant_collection, points=points)
    logger.info("Indexed %d chunks into '%s'", len(points), settings.qdrant_collection)


def run_full_ingestion() -> None:
    logging.basicConfig(level=logging.INFO)
    pages = fetch_pages()
    chunks = chunk_pages(pages)
    logger.info("Fetched %d pages -> %d chunks", len(pages), len(chunks))
    index_chunks(chunks)


if __name__ == "__main__":
    run_full_ingestion()
