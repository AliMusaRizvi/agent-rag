"""
RAGAS evaluation harness (see design doc §10 for why RAGAS specifically).

Run as: `python -m app.eval.ragas_eval`

Expand `app/eval/gold_set_sample.json` to 30-50 hand-written questions before
treating these numbers as a real result to put in a portfolio README — three
questions is enough to prove the harness works, not enough to be a credible
evaluation.

Each metric maps to a specific failure mode in the pipeline:
- faithfulness       -> catches hallucination (validates the hallucination_check node)
- answer_relevancy    -> does the answer actually address the question
- context_precision   -> measures the RERANKER (are top chunks actually relevant)
- context_recall      -> measures the RETRIEVER (did hybrid search find everything needed)
"""
import json
import logging
from pathlib import Path

from datasets import Dataset
from ragas import evaluate
from ragas.metrics import answer_relevancy, context_precision, context_recall, faithfulness

from app.graph.build_graph import compiled_graph

logger = logging.getLogger(__name__)

GOLD_SET_PATH = Path(__file__).parent / "gold_set_sample.json"


def _run_pipeline_for_question(question: str, thread_id: str) -> dict:
    config = {"configurable": {"thread_id": thread_id}}
    result = compiled_graph.invoke({"user_query": question}, config=config)

    answer = result.get("cited_answer")
    contexts = [c.text for c in result.get("reranked_chunks", [])]

    return {
        "question": question,
        "answer": answer.answer if answer else result.get("final_response", ""),
        "contexts": contexts,
    }


def build_eval_dataset() -> Dataset:
    gold_set = json.loads(GOLD_SET_PATH.read_text())
    rows = []
    for i, item in enumerate(gold_set):
        row = _run_pipeline_for_question(item["question"], thread_id=f"eval-{i}")
        rows.append(row)
    return Dataset.from_list(rows)


def run_eval() -> dict:
    logging.basicConfig(level=logging.INFO)
    dataset = build_eval_dataset()

    result = evaluate(
        dataset,
        metrics=[faithfulness, answer_relevancy, context_precision, context_recall],
    )
    logger.info("RAGAS results: %s", result)
    return result


if __name__ == "__main__":
    run_eval()
