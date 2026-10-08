"""Synthetic named-variant price gate; not a live Vendure or checkout test."""

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
    / "fixtures/evaluation-datasets/read-only-catalog-price-v7.json"
)


@pytest.fixture(autouse=True)
def deny_network(monkeypatch):
    def denied(*_args, **_kwargs):
        raise AssertionError("Catalog-price evaluation must stay offline")

    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setattr(socket.socket, "connect_ex", denied)


def dataset():
    return EvaluationDataset.model_validate_json(DATASET_PATH.read_text())


def test_v7_explicit_price_and_mixed_questions_do_not_call_a_model():
    class NoModelClassifier:
        async def classify(self, **_kwargs):
            raise AssertionError("Explicit price routing must not call a model")

    for case in dataset().cases:
        request = SupportIntakeRequest(customer_message=case.input["customer_message"])
        decision = asyncio.run(classify_support_journey(request, NoModelClassifier()))
        assert decision.journey == case.expectations["expected_journey"], case.case_id


def test_v7_rejects_fabricated_checkout_total_and_mutating_tool():
    reviewed_case = next(
        case for case in dataset().cases if case.case_id == "catalog-price-usd"
    )
    sample = asyncio.run(
        ReadOnlySupportEvaluatedSystem().run(reviewed_case, repetition=1)
    ).model_copy(deep=True)
    sample.output["customer_answer"] += " Your checkout total is USD 1299.00."
    sample.trace.append(TraceEvent(sequence=2, kind="TOOL_CALL", name="create_refund"))

    assert not asyncio.run(ReadOnlyAnswerGrader().grade(reviewed_case, sample)).passed
    assert not asyncio.run(
        ReadOnlyTrajectoryGrader().grade(reviewed_case, sample)
    ).passed


def test_v7_catalog_price_is_deterministic_read_only_and_fails_closed():
    reviewed = dataset()
    run = asyncio.run(
        run_evaluation(
            dataset=reviewed,
            system=ReadOnlySupportEvaluatedSystem(),
            graders=[ReadOnlyAnswerGrader(), ReadOnlyTrajectoryGrader()],
            repetitions=2,
            run_id="offline-catalog-price-v7",
            evaluation_version="read-only-catalog-price-v7",
        )
    )

    assert reviewed.dataset_version == "v7"
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
    for case_id in (
        "catalog-price-usd",
        "catalog-price-inr",
        "catalog-price-jpy",
    ):
        assert by_case[case_id].output["status"] == "answer_ready"
        assert len(by_case[case_id].trace) == 1
    for case_id in (
        "catalog-price-product-only",
        "catalog-price-unknown-variant",
        "catalog-price-duplicate-variant",
    ):
        assert by_case[case_id].output["status"] == "awaiting_product"
    for case_id in (
        "catalog-price-missing-price",
        "catalog-price-unsupported-currency",
    ):
        assert by_case[case_id].output["status"] == "source_unavailable"
    for case_id in ("catalog-price-mixed-refund", "catalog-price-mixed-payment"):
        assert by_case[case_id].output["journey"] == "clarify"
        assert by_case[case_id].trace == []
