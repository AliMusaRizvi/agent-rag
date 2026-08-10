"""
Central configuration.

Why this exists as its own module: every other module imports `settings`
instead of calling os.getenv() scattered everywhere. That means swapping
a model name, a DB URL, or a provider is a one-line change in one place —
the same principle behind keeping the vector store and the LLM provider
behind interfaces (see llm_providers.py and retrieval/hybrid_retriever.py).
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # LLM providers
    google_api_key: str = ""
    groq_api_key: str = ""
    openai_api_key: str = ""
    anthropic_api_key: str = ""

    primary_llm_model: str = "gemini-2.5-flash"
    fallback_llm_model: str = "llama-3.3-70b-versatile"
    embedding_model: str = "models/gemini-embedding-001"
    embedding_dim: int = 768

    # Vector DB
    qdrant_url: str = "http://localhost:6333"
    qdrant_api_key: str = ""
    qdrant_collection: str = "enterprise_handbook"

    # Memory
    postgres_url: str = "postgresql://postgres:postgres@localhost:5432/agent_memory"

    # Tools
    github_token: str = ""
    github_repo: str = "your-org/your-demo-repo"

    # Observability
    langchain_tracing_v2: bool = True
    langchain_api_key: str = ""
    langchain_project: str = "enterprise-knowledge-agent"

    # Retrieval tuning
    retrieval_top_k: int = 20          # candidates pulled from hybrid search
    rerank_top_n: int = 5              # kept after reranking, sent to the LLM
    max_rewrite_loops: int = 2         # caps cost/latency on the grader loop
    max_hallucination_retries: int = 1


settings = Settings()
