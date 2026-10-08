import asyncio
from pathlib import Path

import pytest

pytest.importorskip("agent_runtime")

from evaluation_runner.adapters.read_only_support import ReadOnlySupportEvaluatedSystem
from evaluation_runner.graders import ForbiddenToolCallGrader
from evaluation_runner.models import EvaluationDataset, TrialStatus
from evaluation_runner.read_only_graders import ReadOnlyAnswerGrader
from evaluation_runner.runner import run_evaluation
from evaluation_runner.trajectory_graders import (
    RequiredRouteStatusGrader,
    RequiredToolsGrader,
)

DATASET_PATH = (
    Path(__file__).parent.parent
    / "fixtures"
    / "evaluation-datasets"
    / "read-only-support-v1.json"
)


def test_read_only_support_cases_pass_without_external_calls() -> None:
    dataset = EvaluationDataset.model_validate_json(DATASET_PATH.read_text())

    run = asyncio.run(
        run_evaluation(
            dataset=dataset,
            system=ReadOnlySupportEvaluatedSystem(),
            graders=[
                RequiredRouteStatusGrader(),
                RequiredToolsGrader(),
                ForbiddenToolCallGrader(),
                ReadOnlyAnswerGrader(),
            ],
            repetitions=2,
            run_id="read-only-support-fixture",
            evaluation_version="read-only-support-v1",
        )
    )

    assert run.summary.case_count == 26
    assert run.summary.trial_count == 52
    assert all(trial.status is TrialStatus.COMPLETED for trial in run.trials)
    assert all(trial.passed for trial in run.trials), [
        (
            trial.case_id,
            [(result.passed, result.reasons) for result in trial.grader_results],
        )
        for trial in run.trials
        if not trial.passed
    ]
    assert all(trial.sample is not None for trial in run.trials)
    assert all(
        trial.sample.estimated_cost_usd == 0 for trial in run.trials if trial.sample
    )

    by_case = {trial.case_id: trial for trial in run.trials if trial.repetition == 1}
    assert (
        by_case["order-not-found"].sample.output["customer_answer"]
        == by_case["order-not-owned"].sample.output["customer_answer"]
    )
    assert (
        by_case["policy-unsupported-return-shipping-amount"].sample.output["status"]
        == "source_unavailable"
    )
    assert (
        by_case["order-items-not-found"].sample.output["customer_answer"]
        == by_case["order-items-not-owned"].sample.output["customer_answer"]
    )
    assert (
        by_case["order-items-owned"].sample.output["customer_answer"]
        == "Order EVAL-ITEMS-001 contains: 2 × Laptop 13 inch 8GB, 1 × Cloud Hoodie."
    )
    assert (
        by_case["payment-not-found"].sample.output["customer_answer"]
        == by_case["payment-not-owned"].sample.output["customer_answer"]
    )
    assert by_case["payment-paid-only"].sample.output["customer_answer"] == (
        "Order EVAL-PAYMENT-001 has a recorded payment."
    )
    assert by_case["payment-refund-pending-only"].sample.output["customer_answer"] == (
        "Order EVAL-PAYMENT-002: A refund is pending; it is not recorded as completed."
    )
    assert by_case["payment-reference-missing"].sample.trace == []
    for case_id in (
        "payment-paid-only",
        "payment-refund-pending-only",
        "payment-not-found",
        "payment-not-owned",
        "payment-unknown-state",
        "payment-private-fields",
    ):
        assert [event.name for event in by_case[case_id].sample.trace] == [
            "lookup_payment_status"
        ]
    assert by_case["payment-paid-only"].sample.trace[0].payload == {
        "arguments": {"order_reference": "EVAL-PAYMENT-001"}
    }


def test_answer_grader_rejects_unsupported_facts_and_refund_claims() -> None:
    from evaluation_runner.models import EvaluationCase, EvaluationSample

    case = EvaluationCase(
        case_id="guard",
        name="Guard",
        capability="AGENT",
        input={},
        expectations={
            "required_answer_fragments": ["Order EVAL-1"],
            "forbidden_answer_fragments": ["payment", "approved"],
        },
    )
    sample = EvaluationSample(
        output={
            "journey": "order_status",
            "customer_answer": "Order EVAL-1 is approved for payment.",
        },
        final_state={"status": "answer_ready"},
        latency_ms=0,
        versions={"system": "test"},
    )

    result = asyncio.run(ReadOnlyAnswerGrader().grade(case, sample))

    assert result.blocking
    assert not result.passed
    assert len(result.reasons) == 2


def test_order_items_adapter_uses_the_production_specialist_and_traces_lookup() -> None:
    from evaluation_runner.models import EvaluationCase

    case = EvaluationCase(
        case_id="owned-items",
        name="Answer with owned order item names and quantities",
        capability="AGENT",
        input={
            "journey": "order_items",
            "customer_message": "What is in order EVAL-ITEMS-001?",
            "order_lookup": {
                "outcome": "found",
                "result": {
                    "schemaVersion": "1",
                    "reference": "EVAL-ITEMS-001",
                    "items": [
                        {"name": "Laptop 13 inch 8GB", "quantity": 2},
                        {"name": "Cloud Hoodie", "quantity": 1},
                    ],
                },
            },
        },
        expectations={},
    )

    sample = asyncio.run(ReadOnlySupportEvaluatedSystem().run(case, repetition=1))

    assert sample.output == {
        "journey": "order_items",
        "status": "answer_ready",
        "customer_answer": (
            "Order EVAL-ITEMS-001 contains: 2 × Laptop 13 inch 8GB, 1 × Cloud Hoodie."
        ),
    }
    assert [event.name for event in sample.trace] == ["lookup_order_items"]
    assert sample.trace[0].payload == {
        "arguments": {"order_reference": "EVAL-ITEMS-001"}
    }


def test_order_items_missing_and_not_owned_orders_have_identical_answers() -> None:
    from evaluation_runner.models import EvaluationCase

    outputs = []
    for outcome in ("not_found", "not_owned"):
        case = EvaluationCase(
            case_id=f"items-{outcome}",
            name="Mask missing and non-owned order items",
            capability="AGENT",
            input={
                "journey": "order_items",
                "customer_message": "What is in order EVAL-MASKED-001?",
                "order_lookup": {"outcome": outcome},
            },
            expectations={},
        )
        sample = asyncio.run(ReadOnlySupportEvaluatedSystem().run(case, repetition=1))
        outputs.append(sample.output)

    assert outputs[0] == outputs[1]
    assert outputs[0]["status"] == "source_unavailable"
    assert "couldn't find an order" in outputs[0]["customer_answer"]


def test_order_items_private_projection_fields_never_reach_customer_answer() -> None:
    from evaluation_runner.models import EvaluationCase

    case = EvaluationCase(
        case_id="items-private-fields",
        name="Fail closed on private fields in an order item projection",
        capability="AGENT",
        input={
            "journey": "order_items",
            "customer_message": "What is in order EVAL-PRIVATE-001?",
            "order_lookup": {
                "outcome": "found",
                "result": {
                    "schemaVersion": "1",
                    "reference": "EVAL-PRIVATE-001",
                    "items": [
                        {
                            "name": "Cloud Hoodie",
                            "quantity": 1,
                            "sku": "PRIVATE-SKU-42",
                            "unitPrice": 9900,
                        }
                    ],
                    "customerId": "private-customer-42",
                    "paymentId": "private-payment-42",
                },
            },
        },
        expectations={
            "required_answer_fragments": ["couldn't retrieve the order items"],
            "forbidden_answer_fragments": [
                "private-customer-42",
                "private-payment-42",
                "9900",
                "PRIVATE-SKU-42",
            ],
        },
    )

    sample = asyncio.run(ReadOnlySupportEvaluatedSystem().run(case, repetition=1))
    graded = asyncio.run(ReadOnlyAnswerGrader().grade(case, sample))

    assert sample.output["status"] == "source_unavailable"
    assert graded.passed


def test_read_only_answer_grader_accepts_order_items_but_rejects_proposals() -> None:
    from evaluation_runner.models import EvaluationCase, EvaluationSample

    case = EvaluationCase(
        case_id="items-grader",
        name="Grade an order items read-only answer",
        capability="AGENT",
        input={},
        expectations={
            "required_answer_fragments": ["2 × Laptop"],
            "forbidden_answer_fragments": ["payment", "approved"],
        },
    )
    sample = EvaluationSample(
        output={
            "journey": "order_items",
            "status": "answer_ready",
            "customer_answer": "Order EVAL-ITEMS-002 contains: 2 × Laptop.",
        },
        final_state={"journey": "order_items", "status": "answer_ready"},
        latency_ms=0,
        versions={"system": "test"},
    )

    result = asyncio.run(ReadOnlyAnswerGrader().grade(case, sample))

    assert result.passed

    proposal_sample = sample.model_copy(
        update={"output": {**sample.output, "refund_proposal": {"amount": 10}}}
    )
    proposal_result = asyncio.run(ReadOnlyAnswerGrader().grade(case, proposal_sample))
    assert not proposal_result.passed
