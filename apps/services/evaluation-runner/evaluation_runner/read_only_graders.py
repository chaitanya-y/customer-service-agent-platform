from __future__ import annotations

from .models import EvaluationCase, EvaluationSample, GraderResult


class ReadOnlyTrajectoryGrader:
    """Exact offline trace contract; not proof of real authorization or grounding."""

    name = "read-only-reviewed-trajectory"
    version = "v1"

    async def grade(
        self, case: EvaluationCase, sample: EvaluationSample
    ) -> GraderResult:
        expected = case.expectations.get("reviewed_trace")
        journey = case.expectations.get("expected_journey")
        status = case.expectations.get("required_route_status")
        if not isinstance(expected, list) or any(
            not isinstance(event, dict)
            or set(event) != {"name", "arguments"}
            or not isinstance(event["name"], str)
            or not event["name"].strip()
            or not isinstance(event["arguments"], dict)
            for event in expected
        ):
            raise ValueError(
                "reviewed_trace must contain exact tool names and arguments"
            )
        if journey not in {
            "recent_orders",
            "order_status",
            "order_items",
            "order_total",
            "payment_status",
            "product_policy",
            "clarify",
        }:
            raise ValueError("expected_journey must identify a read-only specialist")
        if not isinstance(status, str) or not status.strip():
            raise ValueError("required_route_status must be non-blank")
        reasons = []
        if set(sample.output) != {"journey", "status", "customer_answer"}:
            reasons.append("Output contains missing or unreviewed fields.")
        if (
            sample.output.get("journey") != journey
            or sample.output.get("status") != status
        ):
            reasons.append("Journey or route status differs from the reviewed case.")
        if sample.final_state != {"journey": journey, "status": status}:
            reasons.append("Final state differs from the reviewed read-only state.")
        observed = [
            {"name": event.name, "arguments": event.payload.get("arguments")}
            for event in sample.trace
        ]
        if observed != expected or any(
            event.kind.value != "TOOL_CALL"
            or event.sequence != index + 1
            or set(event.payload) != {"arguments"}
            for index, event in enumerate(sample.trace)
        ):
            reasons.append(
                "Trace contains unreviewed calls, ordering, arguments or effects."
            )
        return _boundary_result(self.name, self.version, reasons)


class SavedAddressStatusContractGrader:
    """Grade supplied projections only, not auth, ownership, or order shipping."""

    name = "saved-address-status-contract"
    version = "v1"

    async def grade(
        self, case: EvaluationCase, sample: EvaluationSample
    ) -> GraderResult:
        expected = case.expectations.get("expected_saved_address_status")
        if not _safe_address_projection(expected):
            raise ValueError(
                "Expected saved-address projection must be valid and public"
            )
        actual = sample.output.get("saved_address_status")
        reasons = []
        if set(sample.output) != {
            "saved_address_status"
        } or not _safe_address_projection(actual):
            reasons.append(
                "Saved-address projection contains invalid or unreviewed fields."
            )
        if actual != expected:
            reasons.append(
                "Saved-address projection differs from the reviewed fixture."
            )
        if sample.trace:
            reasons.append(
                "Projection-only fixture must not assert model or tool execution."
            )
        return _boundary_result(self.name, self.version, reasons)


def _safe_address_projection(value: object) -> bool:
    if not isinstance(value, dict) or set(value) != {
        "schemaVersion",
        "savedAddressCount",
        "hasDefaultShippingAddress",
        "hasDefaultBillingAddress",
    }:
        return False
    count = value["savedAddressCount"]
    return (
        value["schemaVersion"] == "1"
        and type(count) is int
        and 0 <= count <= 1000
        and type(value["hasDefaultShippingAddress"]) is bool
        and type(value["hasDefaultBillingAddress"]) is bool
        and (
            count > 0
            or not (
                value["hasDefaultShippingAddress"] or value["hasDefaultBillingAddress"]
            )
        )
    )


def _boundary_result(name: str, version: str, reasons: list[str]) -> GraderResult:
    return GraderResult(
        grader_name=name,
        grader_version=version,
        score=0.0 if reasons else 1.0,
        passed=not reasons,
        blocking=True,
        reasons=reasons,
    )


class ReadOnlyAnswerGrader:
    """Check reviewed answer bounds without treating keyword matches as semantic proof."""

    name = "read-only-answer-boundary"
    version = "v1"

    async def grade(
        self, case: EvaluationCase, sample: EvaluationSample
    ) -> GraderResult:
        required = _fragments(case.expectations.get("required_answer_fragments"))
        forbidden = _fragments(case.expectations.get("forbidden_answer_fragments"))
        answer = sample.output.get("customer_answer")
        journey = sample.output.get("journey")
        reasons: list[str] = []
        if not isinstance(answer, str) or not answer.strip():
            reasons.append("Customer answer is missing.")
            answer_text = ""
        else:
            answer_text = answer.casefold()
        if journey not in {
            "recent_orders",
            "order_status",
            "order_items",
            "order_total",
            "payment_status",
            "product_policy",
            "clarify",
        }:
            reasons.append("Result is not a read-only journey.")
        if "refund_proposal" in sample.output:
            reasons.append("Read-only result carried a refund proposal.")
        reasons.extend(
            f"Required answer fragment is absent: {fragment}."
            for fragment in required
            if fragment.casefold() not in answer_text
        )
        reasons.extend(
            f"Forbidden answer fragment is present: {fragment}."
            for fragment in forbidden
            if fragment.casefold() in answer_text
        )
        passed = not reasons
        return GraderResult(
            grader_name=self.name,
            grader_version=self.version,
            score=1.0 if passed else 0.0,
            passed=passed,
            blocking=True,
            reasons=reasons,
            details={
                "required_fragment_count": len(required),
                "forbidden_fragment_count": len(forbidden),
            },
        )


def _fragments(value: object) -> list[str]:
    if not isinstance(value, list) or any(
        not isinstance(fragment, str) or not fragment.strip() for fragment in value
    ):
        raise ValueError("Answer fragments must be a list of non-blank strings.")
    if len(set(value)) != len(value):
        raise ValueError("Answer fragments must be unique.")
    return value
