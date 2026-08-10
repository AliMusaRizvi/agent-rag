"""
Header-aware chunking.

Why not fixed-size (every N tokens)? It slices mid-sentence, separates a
heading from the content it governs, and produces topically incoherent
chunks — which directly hurts two things this project measures: reranker
precision (a reranker scores a chunk far more accurately when it's one
complete idea) and citation accuracy (you want to cite "the Remote Work
Policy section", not an arbitrary character span). See design doc §5.

Strategy:
1. Split on markdown headers first (## / ###) so each chunk starts as one
   coherent section.
2. Any section still longer than `max_chars` gets sub-split on paragraph
   boundaries with a small overlap, so a single oversized section doesn't
   become one giant unsearchable chunk.
"""
import hashlib
import re
from dataclasses import dataclass, field

from app.ingestion.scraper import RawPage

HEADER_RE = re.compile(r"^(#{1,3})\s+(.*)$", re.MULTILINE)


@dataclass
class Chunk:
    chunk_id: str
    text: str
    source_url: str
    source_title: str
    section: str
    metadata: dict = field(default_factory=dict)


def _stable_id(source_url: str, section: str, idx: int) -> str:
    raw = f"{source_url}::{section}::{idx}"
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def _split_oversized(text: str, max_chars: int, overlap: int) -> list[str]:
    if len(text) <= max_chars:
        return [text]

    paragraphs = [p for p in text.split("\n\n") if p.strip()]
    parts: list[str] = []
    current = ""
    for para in paragraphs:
        if len(current) + len(para) + 2 <= max_chars:
            current = f"{current}\n\n{para}" if current else para
        else:
            if current:
                parts.append(current)
            # carry a small overlap forward for retrieval continuity across
            # the split, without duplicating whole paragraphs
            tail = current[-overlap:] if current else ""
            current = f"{tail}\n\n{para}" if tail else para
    if current:
        parts.append(current)
    return parts


def chunk_page(page: RawPage, max_chars: int = 1500, overlap: int = 150) -> list[Chunk]:
    """Splits one page's markdown into header-scoped, size-bounded chunks."""
    matches = list(HEADER_RE.finditer(page.markdown))

    if not matches:
        # No headers at all — treat the whole page as one section.
        sections = [("(untitled)", page.markdown)]
    else:
        sections = []
        for i, match in enumerate(matches):
            start = match.end()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(page.markdown)
            heading = match.group(2).strip()
            body = page.markdown[start:end].strip()
            if body:
                sections.append((heading, body))

    chunks: list[Chunk] = []
    for section_title, body in sections:
        for idx, piece in enumerate(_split_oversized(body, max_chars, overlap)):
            chunks.append(
                Chunk(
                    chunk_id=_stable_id(page.url, section_title, idx),
                    text=f"# {section_title}\n\n{piece}" if section_title != "(untitled)" else piece,
                    source_url=page.url,
                    source_title=page.title,
                    section=section_title,
                    metadata={"char_len": len(piece)},
                )
            )
    return chunks


def chunk_pages(pages: list[RawPage], max_chars: int = 1500, overlap: int = 150) -> list[Chunk]:
    all_chunks: list[Chunk] = []
    for page in pages:
        all_chunks.extend(chunk_page(page, max_chars, overlap))
    return all_chunks
