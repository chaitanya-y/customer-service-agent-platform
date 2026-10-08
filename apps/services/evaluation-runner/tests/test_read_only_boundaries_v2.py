import asyncio
from pathlib import Path

import pytest

from evaluation_runner.models import EvaluationCase, EvaluationSample, TraceEvent
from evaluation_runner.read_only_graders import (
    ReadOnlyAnswerGrader,
    ReadOnlyTrajectoryGrader,
    SavedAddressStatusContractGrader,
)


def case(expectations):
    return EvaluationCase(
        case_id="boundary",
        name="Boundary",
        capability="SAFETY",
        input={},
        expectations=expectations,
    )


def sample(output, trace=None):
    return EvaluationSample(
        output=output,
        final_state={"journey": output.get("journey"), "status": output.get("status")},
        trace=trace or [],
        latency_ms=0,
        versions={"system": "synthetic-test"},
    )


@pytest.mark.parametrize(
    "mutation", ["extra_argument", "extra_tool", "model", "private_output", "state"]
)
def test_exact_read_only_trajectory_rejects_unreviewed_behavior(mutation):
    expected = [
        {"name": "lookup_order_items", "arguments": {"order_reference": "EVAL-001"}}
    ]
    output = {
        "journey": "order_items",
        "status": "answer_ready",
        "customer_answer": "Items.",
    }
    trace = [
        TraceEvent(
            sequence=1,
            kind="TOOL_CALL",
            name=expected[0]["name"],
            payload={"arguments": dict(expected[0]["arguments"])},
        )
    ]
    value = sample(output, trace)
    if mutation == "extra_argument":
        value.trace[0].payload["arguments"]["customer_id"] = "private"
    elif mutation == "extra_tool":
        value.trace.append(
            TraceEvent(sequence=2, kind="TOOL_CALL", name="create_refund")
        )
    elif mutation == "model":
        value.trace.append(TraceEvent(sequence=2, kind="MODEL_CALL", name="paid-model"))
    elif mutation == "private_output":
        value.output["customer_id"] = "private"
    else:
        value.final_state["status"] = "refund_started"
    result = asyncio.run(
        ReadOnlyTrajectoryGrader().grade(
            case(
                {
                    "expected_journey": "order_items",
                    "required_route_status": "answer_ready",
                    "reviewed_trace": expected,
                }
            ),
            value,
        )
    )
    assert not result.passed
    assert result.blocking


@pytest.mark.parametrize(
    "projection",
    [
        {
            "schemaVersion": "1",
            "savedAddressCount": 0,
            "hasDefaultShippingAddress": False,
            "hasDefaultBillingAddress": False,
        },
        {
            "schemaVersion": "1",
            "savedAddressCount": 2,
            "hasDefaultShippingAddress": True,
            "hasDefaultBillingAddress": False,
        },
    ],
)
def test_saved_address_contract_accepts_safe_projection_only(projection):
    result = asyncio.run(
        SavedAddressStatusContractGrader().grade(
            case({"expected_saved_address_status": projection}),
            sample({"saved_address_status": projection}),
        )
    )
    assert result.passed


@pytest.mark.parametrize(
    "change",
    [
        {"schemaVersion": 1},
        {"savedAddressCount": True},
        {"savedAddressCount": -1},
        {"savedAddressCount": 0, "hasDefaultShippingAddress": True},
        {"email": "private@example.test"},
        {"hasDefaultBillingAddress": "false"},
    ],
)
def test_saved_address_contract_rejects_invalid_or_private_projection(change):
    expected = {
        "schemaVersion": "1",
        "savedAddressCount": 2,
        "hasDefaultShippingAddress": False,
        "hasDefaultBillingAddress": False,
    }
    result = asyncio.run(
        SavedAddressStatusContractGrader().grade(
            case({"expected_saved_address_status": expected}),
            sample({"saved_address_status": expected | change}),
        )
    )
    assert not result.passed


@pytest.mark.parametrize("effect", ["trace", "output"])
def test_saved_address_contract_does_not_claim_a_model_or_order_journey(effect):
    expected = {
        "schemaVersion": "1",
        "savedAddressCount": 0,
        "hasDefaultShippingAddress": False,
        "hasDefaultBillingAddress": False,
    }
    value = sample({"saved_address_status": expected})
    if effect == "trace":
        value.trace.append(TraceEvent(sequence=1, kind="MODEL_CALL", name="model"))
    else:
        value.output["order_shipping_address_confirmed"] = True
    assert not asyncio.run(
        SavedAddressStatusContractGrader().grade(
            case({"expected_saved_address_status": expected}), value
        )
    ).passed


def test_grader_rejects_malformed_reviewed_expectations():
    with pytest.raises(ValueError, match="reviewed_trace"):
        asyncio.run(
            ReadOnlyTrajectoryGrader().grade(case({"reviewed_trace": [{}]}), sample({}))
        )
    with pytest.raises(ValueError, match="Expected saved-address"):
        asyncio.run(
            SavedAddressStatusContractGrader().grade(
                case({"expected_saved_address_status": {}}), sample({})
            )
        )


def test_reviewed_v2_cases_execute_real_specialists_offline():
    pytest.importorskip("agent_runtime")
    from evaluation_runner.adapters.read_only_support import (
        ReadOnlySupportEvaluatedSystem,
    )
    from evaluation_runner.models import EvaluationDataset, TrialStatus
    from evaluation_runner.runner import run_evaluation

    path = (
        Path(__file__).parent.parent
        / "fixtures/evaluation-datasets/read-only-support-v2.json"
    )
    dataset = EvaluationDataset.model_validate_json(path.read_text())
    run = asyncio.run(
        run_evaluation(
            dataset=dataset,
            system=ReadOnlySupportEvaluatedSystem(),
            graders=[ReadOnlyAnswerGrader(), ReadOnlyTrajectoryGrader()],
            repetitions=2,
            run_id="offline-read-only-v2",
            evaluation_version="read-only-support-v2",
        )
    )
    assert len(dataset.cases) >= 15
    assert all(trial.status is TrialStatus.COMPLETED for trial in run.trials)
    # Keep the reviewed v2 fixture immutable. Its old FAILED wording assumed
    # the aggregate identified a failed attempt; the current provider mapping
    # includes cancelled attempts too. The corrected wording is covered by v5.
    # Its generic-return trace also records the original raw question; the
    # current narrow source-finding query is deliberate and separately tested.
    drift = [trial for trial in run.trials if not trial.passed]
    assert len(drift) == 4
    assert [trial.case_id for trial in drift].count("failed-refund") == 2
    assert [trial.case_id for trial in drift].count("policy-empty-evidence") == 2
    failed_refund = [trial for trial in drift if trial.case_id == "failed-refund"]
    assert all(
        trial.sample.output["customer_answer"]
        == "Order EVAL-BOUNDARY-001: A refund attempt did not complete; no completed refund is recorded."
        for trial in failed_refund
    )
    assert all(
        [result.passed for result in trial.grader_results] == [False, True]
        for trial in failed_refund
    )
    empty_policy = [
        trial for trial in drift if trial.case_id == "policy-empty-evidence"
    ]
    assert all(
        trial.sample.output["customer_answer"]
        == "I couldn't verify that information right now. Please try again later or contact support."
        and [result.passed for result in trial.grader_results] == [True, False]
        and len(trial.sample.trace) == 1
        and trial.sample.trace[0].kind == "TOOL_CALL"
        and trial.sample.trace[0].name == "retrieve_customer_evidence"
        and trial.sample.trace[0].payload["arguments"]
        == {
            "query_text": "change-of-mind returns unopened non-final-sale physical goods returned and inspected"
        }
        for trial in empty_policy
    )
    assert all(
        trial.passed
        for trial in run.trials
        if trial.case_id not in {"failed-refund", "policy-empty-evidence"}
    )
    assert all(trial.sample.estimated_cost_usd == 0 for trial in run.trials)
