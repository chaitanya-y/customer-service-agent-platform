"""Offline regression cases for truthful refund attempts and split shipments."""

import asyncio
import socket
from pathlib import Path

import pytest

pytest.importorskip("agent_runtime")

from evaluation_runner.adapters.read_only_support import ReadOnlySupportEvaluatedSystem
from evaluation_runner.models import EvaluationDataset, TrialStatus
from evaluation_runner.read_only_graders import (
    ReadOnlyAnswerGrader,
    ReadOnlyTrajectoryGrader,
)
from evaluation_runner.runner import run_evaluation

DATASET_PATH = (
    Path(__file__).parent.parent
    / "fixtures/evaluation-datasets/read-only-support-v5.json"
)


@pytest.fixture(autouse=True)
def deny_network(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError("Status clarity evaluation must remain offline")

    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setattr(socket.socket, "connect_ex", denied)


def dataset():
    return EvaluationDataset.model_validate_json(DATASET_PATH.read_text())


def test_v5_status_clarity_cases_are_consistent_and_read_only():
    reviewed = dataset()
    run = asyncio.run(
        run_evaluation(
            dataset=reviewed,
            system=ReadOnlySupportEvaluatedSystem(),
            graders=[ReadOnlyAnswerGrader(), ReadOnlyTrajectoryGrader()],
            repetitions=2,
            run_id="offline-status-clarity-v5",
            evaluation_version="read-only-support-v5",
        )
    )

    assert reviewed.dataset_version == "v5"
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


@pytest.mark.parametrize(
    "case_id,removed_fragment",
    [
        (
            "refund-failed-specific-completed-aggregate",
            "This order-level summary cannot confirm the outcome of a particular refund attempt.",
        ),
        (
            "split-fulfillment-paired-codes",
            "Fulfillment 1 status: Shipped; tracking code: TRACK-A.",
        ),
    ],
)
def test_v5_grader_blocks_missing_safety_fact(case_id, removed_fragment):
    reviewed_case = next(case for case in dataset().cases if case.case_id == case_id)
    sample = asyncio.run(
        ReadOnlySupportEvaluatedSystem().run(reviewed_case, repetition=1)
    )
    sample.output["customer_answer"] = sample.output["customer_answer"].replace(
        removed_fragment, ""
    )
    result = asyncio.run(ReadOnlyAnswerGrader().grade(reviewed_case, sample))
    assert result.blocking
    assert not result.passed
