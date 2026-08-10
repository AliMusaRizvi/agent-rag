"""
Builds and compiles the LangGraph state machine.

Why LangGraph over a linear chain (see design doc §7 for the framework
choice itself): this graph has two real loops (grader->rewrite,
hallucination->regenerate) and one hard pause (human approval before a
write action) — control flow a linear chain can't express. Each of those
three properties maps directly to a line in the job post: "hybrid retrieval
and reranking" needs the rewrite loop to be worth anything, "source
citations" needs the hallucination loop to be *verified* rather than
asserted, and "Human-in-the-Loop" needs a real pause point, not a comment.
"""
from langgraph.graph import END, StateGraph
from langgraph.checkpoint.postgres import PostgresSaver

from app.config import settings
from app.graph.state import GraphState
from app.graph.nodes import (
    chat_node,
    execute_tool_node,
    finalize_node,
    generate_node,
    grade_node,
    hallucination_check_node,
    prepare_regenerate_node,
    prepare_tool_call_node,
    retrieve_node,
    rewrite_node,
    router_node,
    should_regenerate,
    should_rewrite,
)


def _route_from_router(state: GraphState) -> str:
    return {"retrieve": "retrieve", "tool_call": "prepare_tool_call", "chat": "chat"}[state["route"]]


def build_graph():
    graph = StateGraph(GraphState)

    graph.add_node("router", router_node)
    graph.add_node("retrieve", retrieve_node)
    graph.add_node("grade", grade_node)
    graph.add_node("rewrite", rewrite_node)
    graph.add_node("generate", generate_node)
    graph.add_node("hallucination_check", hallucination_check_node)
    graph.add_node("prepare_regenerate", prepare_regenerate_node)
    graph.add_node("finalize", finalize_node)
    graph.add_node("chat", chat_node)
    graph.add_node("prepare_tool_call", prepare_tool_call_node)
    graph.add_node("execute_tool", execute_tool_node)

    graph.set_entry_point("router")

    graph.add_conditional_edges(
        "router", _route_from_router, {"retrieve": "retrieve", "prepare_tool_call": "prepare_tool_call", "chat": "chat"}
    )

    graph.add_edge("retrieve", "grade")
    graph.add_conditional_edges("grade", should_rewrite, {"rewrite": "rewrite", "generate": "generate"})
    graph.add_edge("rewrite", "retrieve")  # loop back for another retrieval pass

    graph.add_edge("generate", "hallucination_check")
    graph.add_conditional_edges(
        "hallucination_check",
        should_regenerate,
        {"regenerate": "prepare_regenerate", "finalize": "finalize"},
    )
    graph.add_edge("prepare_regenerate", "generate")  # loop back for another generation pass

    graph.add_edge("finalize", END)
    graph.add_edge("chat", END)

    # Human-in-the-loop: the graph PAUSES before execute_tool. The caller
    # (see api/main.py's /approve-tool endpoint) must resume the graph with
    # tool_approved=True in the state before this node is allowed to run.
    graph.add_edge("prepare_tool_call", "execute_tool")
    graph.add_edge("execute_tool", END)

    checkpointer = PostgresSaver.from_conn_string(settings.postgres_url)
    checkpointer.setup()

    return graph.compile(checkpointer=checkpointer, interrupt_before=["execute_tool"])


# Module-level singleton — compiling the graph is not free, do it once.
compiled_graph = build_graph()
