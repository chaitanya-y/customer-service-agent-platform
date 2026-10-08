import asyncio
import socket
from pathlib import Path

import pytest

pytest.importorskip("agent_runtime")

from evaluation_runner.adapters.read_only_support import ReadOnlySupportEvaluatedSystem
from evaluation_runner.models import EvaluationDataset, TraceEvent, TrialStatus
from evaluation_runner.read_only_graders import (
    ReadOnlyAnswerGrader,
    ReadOnlyTrajectoryGrader,
)
from evaluation_runner.runner import run_evaluation

DATASET_PATH = (
    Path(__file__).parent.parent
    / "fixtures/evaluation-datasets/read-only-support-v3.json"
)


@pytest.fixture(autouse=True)
def deny_network(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError(
            "Availability fixture must not connect to external services"
        )

    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setattr(socket.socket, "connect_ex", denied)


def dataset():
    return EvaluationDataset.model_validate_json(DATASET_PATH.read_text())


def test_v3_availability_runs_production_specialist_twice_with_exact_read_only_trace():
    reviewed = dataset()
    run = asyncio.run(
        run_evaluation(
            dataset=reviewed,
            system=ReadOnlySupportEvaluatedSystem(),
            graders=[ReadOnlyAnswerGrader(), ReadOnlyTrajectoryGrader()],
            repetitions=2,
            run_id="offline-availability-v3",
            evaluation_version="read-only-support-v3",
        )
    )
    assert reviewed.dataset_version == "v3"
    assert run.summary.case_count == 8
    assert run.summary.trial_count == 16
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


def test_v3_blocks_stock_claim_injected_into_missing_variant_fact():
    class InjectedStockClaim:
        async def run(self, case, *, repetition):
            sample = await ReadOnlySupportEvaluatedSystem().run(
                case, repetition=repetition
            )
            if case.case_id == "availability-missing-variant-status":
                sample.output["customer_answer"] += (
                    " The catalog lists Cloud Hoodie Blue / Small as in stock."
                )
            return sample

    run = asyncio.run(
        run_evaluation(
            dataset=dataset(),
            system=InjectedStockClaim(),
            graders=[ReadOnlyAnswerGrader(), ReadOnlyTrajectoryGrader()],
            repetitions=2,
            run_id="injected-stock-claim-v3",
            evaluation_version="read-only-support-v3",
        )
    )
    failed = [trial for trial in run.trials if not trial.passed]
    assert len(failed) == 2
    assert all(
        trial.case_id == "availability-missing-variant-status" for trial in failed
    )
    assert all(trial.status is TrialStatus.COMPLETED for trial in failed)
    for trial in failed:
        answer_result, trajectory_result = trial.grader_results
        assert answer_result.blocking
        assert not answer_result.passed
        assert any(
            "Forbidden answer fragment" in reason for reason in answer_result.reasons
        )
        assert trajectory_result.passed


@pytest.mark.parametrize(
    "mutation", ["refund_tool", "extra_argument", "refund_proposal", "model_call"]
)
def test_v3_blocks_unreviewed_refund_model_or_tool_effects(mutation):
    case = next(
        case for case in dataset().cases if case.case_id == "availability-in-stock"
    )
    sample = asyncio.run(ReadOnlySupportEvaluatedSystem().run(case, repetition=1))
    assert asyncio.run(ReadOnlyTrajectoryGrader().grade(case, sample)).passed
    if mutation == "refund_tool":
        sample.trace.append(
            TraceEvent(sequence=2, kind="TOOL_CALL", name="create_refund")
        )
    elif mutation == "extra_argument":
        sample.trace[0].payload["arguments"]["customer_id"] = "unreviewed"
    elif mutation == "refund_proposal":
        sample.output["refund_proposal"] = {"amount": 100}
    else:
        sample.trace.append(
            TraceEvent(sequence=2, kind="MODEL_CALL", name="unreviewed-model")
        )
    result = asyncio.run(ReadOnlyTrajectoryGrader().grade(case, sample))
    assert result.blocking
    assert not result.passed
    if mutation == "refund_proposal":
        assert not asyncio.run(ReadOnlyAnswerGrader().grade(case, sample)).passed
