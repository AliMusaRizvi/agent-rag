"""
Memory (see design doc §9): a Postgres-backed LangGraph checkpointer gives
conversation state that survives process restarts, at no added
infrastructure cost since Postgres is already running for this project's
metadata/pgvector alternate path. The checkpointer itself is instantiated
in graph/build_graph.py (it must be bound to the compiled graph directly);
this module exists as the single place to document *why* Postgres and not
the in-memory default, and as the place to add longer-term memory (user
preferences, cross-thread facts) if this project grows beyond a single
conversation thread per user.
"""
from app.config import settings

CONNECTION_STRING = settings.postgres_url

# Longer-term, cross-thread memory (e.g. "this user always wants answers
# scoped to the Engineering handbook section") would be implemented here as
# a separate table keyed by user_id rather than thread_id — left as a
# documented extension point rather than built, since the job's "Memory"
# requirement is satisfied by conversation-level persistence for an MVP.
