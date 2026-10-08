"""Offline recent-reference boundary; never a live ownership or freshness proof."""

import asyncio
import socket
from pathlib import Path

import pytest

pytest.importorskip("agent_runtime")

from agent_runtime.support.classifier import classify_support_journey
from agent_runtime.support.schemas import SupportIntakeRequest

from evaluation_runner.adapters.read_only_support import ReadOnlySupportEvaluatedSystem
from evaluation_runner.models import EvaluationDataset, TraceEvent, TrialStatus
from evaluation_runner.read_only_graders import (
    ReadOnlyAnswerGrader,
    ReadOnlyTrajectoryGrader,
)
from evaluation_runner.runner import run_evaluation

DATASET_PATH = (
    Path(__file__).parent.parent
    / "fixtures/evaluation-datasets/read-only-recent-orders-v8.json"
)


@pytest.fixture(autouse=True)
def deny_network(monkeypatch):
    def denied(*_args, **_kwargs):
        raise AssertionError("Recent-order evaluation must stay offline")

    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setattr(socket.socket, "connect_ex", denied)


def dataset():
    return EvaluationDataset.model_validate_json(DATASET_PATH.read_text())


class NoModel:
    async def classify(self, **_kwargs):
        raise AssertionError("This route must not use a model")


def test_v8_current_turn_routing_is_deterministic():
    for case in dataset().cases:
        decision = asyncio.run(
            classify_support_journey(
                SupportIntakeRequest(customer_message=case.input["customer_message"]),
                NoModel(),
            )
        )
        assert decision.journey == case.expectations["expected_journey"], case.case_id


def test_v8_rejects_fabricated_status_and_mutating_tool():
    case = next(c for c in dataset().cases if c.case_id == "recent-two-orders")
    sample = asyncio.run(ReadOnlySupportEvaluatedSystem().run(case, repetition=1))
    sample.output["customer_answer"] += " The first order was delivered."
    sample.trace.append(TraceEvent(sequence=2, kind="TOOL_CALL", name="create_refund"))
    assert not asyncio.run(ReadOnlyAnswerGrader().grade(case, sample)).passed
    assert not asyncio.run(ReadOnlyTrajectoryGrader().grade(case, sample)).passed


@pytest.mark.parametrize("case_id", ["recent-two-orders", "recent-partial-page"])
def test_v8_answer_preserves_every_source_reference_in_newest_first_order(case_id):
    case = next(c for c in dataset().cases if c.case_id == case_id)
    sample = asyncio.run(ReadOnlySupportEvaluatedSystem().run(case, repetition=1))
    source_references = [
        row["reference"]
        for row in case.input["recent_orders_lookup"]["result"]["orders"]
    ]
    # Fragment graders alone would miss reordered or omitted intermediate rows.
    answer = sample.output["customer_answer"]
    reference_segment = answer.split(": ", 1)[1].split(".", 1)[0]
    assert reference_segment.split(", ") == source_references


def test_v8_repeated_trials_are_read_only_and_fail_closed():
    reviewed = dataset()
    run = asyncio.run(
        run_evaluation(
            dataset=reviewed,
            system=ReadOnlySupportEvaluatedSystem(),
            graders=[ReadOnlyAnswerGrader(), ReadOnlyTrajectoryGrader()],
            repetitions=2,
            run_id="offline-recent-orders-v8",
            evaluation_version="read-only-recent-orders-v8",
        )
    )
    assert reviewed.dataset_version == "v8"
    assert run.summary.case_count == 12
    assert run.summary.trial_count == 24
    assert all(trial.status is TrialStatus.COMPLETED for trial in run.trials)
    assert all(trial.passed for trial in run.trials), [
        (trial.case_id, [g.reasons for g in trial.grader_results])
        for trial in run.trials
        if not trial.passed
    ]
    assert run.summary.passed_trial_count == 24
    assert run.summary.consistent_case_count == 12
    assert all(trial.sample.estimated_cost_usd == 0 for trial in run.trials)
    assert all(g.blocking for trial in run.trials for g in trial.grader_results)
    for case in reviewed.cases:
        samples = [
            trial.sample for trial in run.trials if trial.case_id == case.case_id
        ]
        assert samples[0].output == samples[1].output
        assert samples[0].trace == samples[1].trace
