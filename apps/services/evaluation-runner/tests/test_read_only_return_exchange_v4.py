import asyncio
import socket
from pathlib import Path

import pytest

pytest.importorskip("agent_runtime")

from evaluation_runner.adapters import read_only_support
from evaluation_runner.adapters.read_only_support import ReadOnlySupportEvaluatedSystem
from evaluation_runner.models import EvaluationDataset, TraceEvent, TrialStatus
from evaluation_runner.read_only_graders import (
    ReadOnlyAnswerGrader,
    ReadOnlyTrajectoryGrader,
)
from evaluation_runner.runner import run_evaluation

DATASET_PATH = (
    Path(__file__).parent.parent
    / "fixtures/evaluation-datasets/read-only-support-v4.json"
)


@pytest.fixture(autouse=True)
def deny_network(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError("Return/exchange evaluation must remain offline")

    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setattr(socket.socket, "connect_ex", denied)


def dataset():
    return EvaluationDataset.model_validate_json(DATASET_PATH.read_text())


def test_v4_return_exchange_discussion_is_consistent_and_read_only(monkeypatch):
    async def forbid_fact_selector(*args, **kwargs):
        raise AssertionError("Generic exchange discussion must not select facts with a model")

    monkeypatch.setattr(
        read_only_support._FactSelector,
        "select_answer_facts",
        forbid_fact_selector,
    )
    reviewed = dataset()
    run = asyncio.run(
        run_evaluation(
            dataset=reviewed,
            system=ReadOnlySupportEvaluatedSystem(),
            graders=[ReadOnlyAnswerGrader(), ReadOnlyTrajectoryGrader()],
            repetitions=2,
            run_id="offline-return-exchange-v4",
            evaluation_version="read-only-support-v4",
        )
    )

    assert reviewed.dataset_version == "v4"
    assert {
        case.input["customer_message"] for case in reviewed.cases
    } == {
        "Can I exchange an item?",
        "Can I return or exchange an item?",
        "What is your exchange policy?",
    }
    assert run.summary.case_count == 6
    assert run.summary.trial_count == 12
    assert run.summary.passed_trial_count == 12
    assert run.summary.consistent_case_count == 6
    assert all(trial.status is TrialStatus.COMPLETED for trial in run.trials)
    assert all(trial.passed for trial in run.trials), [
        (trial.case_id, trial.grader_results)
        for trial in run.trials
        if not trial.passed
    ]
    assert all(trial.sample.estimated_cost_usd == 0 for trial in run.trials)
    assert all(
        result.blocking for trial in run.trials for result in trial.grader_results
    )
    for case in reviewed.cases:
        samples = [
            trial.sample for trial in run.trials if trial.case_id == case.case_id
        ]
        assert samples[0].output == samples[1].output
        assert samples[0].trace == samples[1].trace
        assert samples[0].output["journey"] == "product_policy"


@pytest.mark.parametrize("mutation", ["exchange_promise", "refund_tool", "cancel_tool"])
def test_v4_grades_block_exchange_promise_and_action_traces(mutation):
    case = next(case for case in dataset().cases if case.case_id == "exchange-item-safe")
    sample = asyncio.run(ReadOnlySupportEvaluatedSystem().run(case, repetition=1))
    if mutation == "exchange_promise":
        sample.output["customer_answer"] += " Your exchange is approved."
        result = asyncio.run(ReadOnlyAnswerGrader().grade(case, sample))
    else:
        sample.trace.append(
            TraceEvent(
                sequence=2,
                kind="TOOL_CALL",
                name="create_refund" if mutation == "refund_tool" else "cancel_order",
            )
        )
        result = asyncio.run(ReadOnlyTrajectoryGrader().grade(case, sample))
    assert result.blocking
    assert not result.passed
