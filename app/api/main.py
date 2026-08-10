"""
FastAPI layer. Thin on purpose — all real logic lives in the graph; this
module's job is HTTP plumbing: session/thread management, invoking the
compiled graph, and exposing the human-in-the-loop approval step as its
own endpoint so a UI (Streamlit, or the React app you build in Loveable/
AI Studio) can render a real "Approve" button rather than faking the pause.
"""
import logging
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.graph.build_graph import compiled_graph
from app.ingestion.embed_index import run_full_ingestion

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Enterprise Knowledge Agent")

# Wide-open CORS for a demo; scope this to your actual deployed frontend
# origin before treating this as anything beyond a portfolio project.
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


class ChatRequest(BaseModel):
    message: str
    thread_id: str | None = None


class ChatResponse(BaseModel):
    thread_id: str
    response: str | None = None
    requires_approval: bool = False
    pending_tool_args: dict | None = None


class ApprovalRequest(BaseModel):
    thread_id: str
    approved: bool


@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    thread_id = req.thread_id or str(uuid.uuid4())
    config = {"configurable": {"thread_id": thread_id}}

    result = compiled_graph.invoke({"user_query": req.message}, config=config)

    # If the graph is paused at the interrupt, there's no final_response yet —
    # that's the human-in-the-loop signal the UI should render as an approval card.
    if "final_response" not in result:
        return ChatResponse(
            thread_id=thread_id,
            requires_approval=True,
            pending_tool_args=result.get("pending_tool_args").model_dump()
            if result.get("pending_tool_args")
            else None,
        )

    return ChatResponse(thread_id=thread_id, response=result["final_response"])


@app.post("/approve-tool", response_model=ChatResponse)
def approve_tool(req: ApprovalRequest) -> ChatResponse:
    """
    Resumes a graph paused at the `execute_tool` interrupt. This is the
    literal human-in-the-loop mechanism: nothing writes to GitHub until
    this endpoint is called with approved=True.
    """
    config = {"configurable": {"thread_id": req.thread_id}}

    # Feed the approval decision into state, then resume execution.
    compiled_graph.update_state(config, {"tool_approved": req.approved})
    result = compiled_graph.invoke(None, config=config)

    return ChatResponse(thread_id=req.thread_id, response=result.get("final_response"))


@app.post("/ingest")
def ingest():
    """Kicks off the full scrape -> chunk -> embed -> index pipeline."""
    try:
        run_full_ingestion()
        return {"status": "ok"}
    except Exception as exc:  # noqa: BLE001
        logger.exception("Ingestion failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/health")
def health():
    return {"status": "ok"}
