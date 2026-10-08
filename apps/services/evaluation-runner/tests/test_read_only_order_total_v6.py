"""Offline synthetic order-total cases exercise the Agent specialist, not live auth."""

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
    / "fixtures/evaluation-datasets/read-only-order-total-v6.json"
)


@pytest.fixture(autouse=True)
def deny_network(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError("Order-total evaluation must remain offline")

    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setattr(socket.socket, "connect_ex", denied)


def dataset():
    return EvaluationDataset.model_validate_json(DATASET_PATH.read_text())


def test_v6_explicit_order_total_questions_route_without_a_model():
    class NoModelClassifier:
        async def classify(self, **_kwargs):
            raise AssertionError("Explicit order-total questions must not call a model")

    cases = [case for case in dataset().cases if case.input["journey"] == "order_total"]
    assert len(cases) == 7
    for case in cases:
        request = SupportIntakeRequest(customer_message=case.input["customer_message"])
        decision = asyncio.run(classify_support_journey(request, NoModelClassifier()))
        assert decision.journey == "order_total", case.case_id


def test_v6_grading_rejects_a_payment_claim_and_refund_tool():
    reviewed_case = next(
        case for case in dataset().cases if case.case_id == "order-total-usd"
    )
    sample = asyncio.run(
        ReadOnlySupportEvaluatedSystem().run(reviewed_case, repetition=1)
    ).model_copy(deep=True)
    sample.output["customer_answer"] += " Your payment was received."
    sample.trace.append(TraceEvent(sequence=2, kind="TOOL_CALL", name="create_refund"))

    answer_grade = asyncio.run(ReadOnlyAnswerGrader().grade(reviewed_case, sample))
    trajectory_grade = asyncio.run(
        ReadOnlyTrajectoryGrader().grade(reviewed_case, sample)
    )
    assert answer_grade.blocking and not answer_grade.passed
    assert trajectory_grade.blocking and not trajectory_grade.passed


def test_v6_order_total_is_deterministic_read_only_and_fails_closed():
    reviewed = dataset()
    run = asyncio.run(
        run_evaluation(
            dataset=reviewed,
            system=ReadOnlySupportEvaluatedSystem(),
            graders=[ReadOnlyAnswerGrader(), ReadOnlyTrajectoryGrader()],
            repetitions=2,
            run_id="offline-order-total-v6",
            evaluation_version="read-only-order-total-v6",
        )
    )

    assert reviewed.dataset_version == "v6"
    assert run.summary.case_count == 10
    assert run.summary.trial_count == 20
    assert all(trial.status is TrialStatus.COMPLETED for trial in run.trials)
    assert all(trial.passed for trial in run.trials), [
        (
            trial.case_id,
            [(result.passed, result.reasons) for result in trial.grader_results],
        )
        for trial in run.trials
        if not trial.passed
    ]
    assert run.summary.passed_trial_count == 20
    assert run.summary.consistent_case_count == 10
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

    by_case = {
        trial.case_id: trial.sample for trial in run.trials if trial.repetition == 1
    }
    assert by_case["order-total-usd"].output["customer_answer"] == (
        "The tax-inclusive total for order EVAL-TOTAL-USD-001 is USD 123.45."
    )
    assert by_case["order-total-inr"].output["customer_answer"] == (
        "The tax-inclusive total for order EVAL-TOTAL-INR-001 is INR 987.65."
    )
    assert by_case["order-total-jpy"].output["customer_answer"] == (
        "The tax-inclusive total for order EVAL-TOTAL-JPY-001 is JPY 1234."
    )
    for case_id in (
        "order-total-missing-order",
        "order-total-mismatched-reference",
        "order-total-unsupported-source",
        "order-total-unreviewed-source-field",
    ):
        assert by_case[case_id].output["status"] == "source_unavailable"
        assert (
            "couldn't retrieve the order total"
            in by_case[case_id].output["customer_answer"]
        )
    for case_id in (
        "order-total-mixed-invoice",
        "order-total-mixed-payment",
        "order-total-mixed-refund",
    ):
        assert by_case[case_id].output["journey"] == "clarify"
        assert by_case[case_id].output["status"] == "clarification_required"
        assert by_case[case_id].trace == []
