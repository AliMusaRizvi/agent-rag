"""
Fetches public Handbook pages and converts them to clean markdown.

Why GitLab's Handbook specifically: it's public, real, and structurally
identical to what "internal knowledge search" looks like at a real company —
policies, engineering practices, workflows, cross-linked pages. That's the
whole reason it's the right stand-in dataset for this job (see design doc §2).

This module is intentionally generic (`fetch_pages` takes any list of URLs)
so the same ingestion pipeline works unmodified against a real client's
Confluence export or docs site later — only this file changes, nothing
downstream (chunker, embedder, retriever, graph) needs to know the source.
"""
import logging
from dataclasses import dataclass

import httpx
from bs4 import BeautifulSoup
from markdownify import markdownify
from tenacity import retry, stop_after_attempt, wait_exponential

logger = logging.getLogger(__name__)


@dataclass
class RawPage:
    url: str
    title: str
    markdown: str


# A representative seed set of Handbook sections. In practice, expand this by
# crawling the Handbook's sitemap.xml — kept as a static seed list here so
# ingestion is deterministic and reproducible for the eval gold set.
DEFAULT_SEED_URLS = [
    "https://handbook.gitlab.com/handbook/company/culture/",
    "https://handbook.gitlab.com/handbook/people-group/remote-work/",
    "https://handbook.gitlab.com/handbook/engineering/",
    "https://handbook.gitlab.com/handbook/security/",
    "https://handbook.gitlab.com/handbook/support/",
    "https://handbook.gitlab.com/handbook/marketing/",
    "https://handbook.gitlab.com/handbook/finance/",
    "https://handbook.gitlab.com/handbook/people-group/",
]


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
def _fetch(client: httpx.Client, url: str) -> httpx.Response:
    resp = client.get(url, timeout=20, follow_redirects=True)
    resp.raise_for_status()
    return resp


def fetch_pages(urls: list[str] | None = None) -> list[RawPage]:
    urls = urls or DEFAULT_SEED_URLS
    pages: list[RawPage] = []

    with httpx.Client(headers={"User-Agent": "enterprise-knowledge-agent-demo/1.0"}) as client:
        for url in urls:
            try:
                resp = _fetch(client, url)
            except httpx.HTTPError as exc:
                logger.warning("Skipping %s after retries: %s", url, exc)
                continue

            soup = BeautifulSoup(resp.text, "html.parser")

            # Strip nav/footer/script noise before converting — otherwise every
            # chunk gets polluted with the same boilerplate, which hurts both
            # embedding quality and reranker precision.
            for tag in soup(["nav", "footer", "script", "style", "header"]):
                tag.decompose()

            main = soup.find("main") or soup.find("article") or soup.body
            title = soup.title.string.strip() if soup.title and soup.title.string else url
            md = markdownify(str(main), heading_style="ATX") if main else ""

            pages.append(RawPage(url=url, title=title, markdown=md))
            logger.info("Fetched %s (%d chars)", url, len(md))

    return pages
