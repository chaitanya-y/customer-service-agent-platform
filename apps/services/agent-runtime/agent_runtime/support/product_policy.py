from __future__ import annotations

import re
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from agent_runtime.integrations.customer_evidence import (
    CustomerEvidence,
    CustomerEvidenceLookup,
    CustomerEvidenceResponse,
)
from agent_runtime.integrations.product_catalog import (
    ProductCatalogLookup,
    ProductCatalogResult,
    ProductMatch,
)
from agent_runtime.support.catalog_questions import (
    explicit_availability_name,
    explicit_price_name,
)
from agent_runtime.support.schemas import (
    CustomerAnswer,
    ReadOnlySupportResponse,
    SupportIntakeRequest,
)

_POLICY_TOPIC = re.compile(
    r"\b(?:policy|policies|return|returns|refund|refunds|exchange|exchanges|"
    r"returnable|refundable|shipping|delivery|warranty|cancel|cancellation)\b",
    re.IGNORECASE,
)
PolicyQuestionKind = Literal[
    "return_rule",
    "return_fee",
    "return_shipping_payer",
    "return_shipping_amount",
    "refund_rule",
    "photo_rule",
]

# With no router-provided product hint, only these complete generic questions
# are eligible for a RAG answer. Unknown wording is not evidence of generality.
_GENERIC_POLICY_QUESTIONS: dict[str, PolicyQuestionKind] = {
    "what is your returns policy": "return_rule",
    "what is your return policy": "return_rule",
    "what is the return policy": "return_rule",
    "can i return an item": "return_rule",
    "can i return a product": "return_rule",
    "can i exchange an item": "return_rule",
    "can i return or exchange an item": "return_rule",
    "what is your exchange policy": "return_rule",
    "how long do i have to return an item": "return_rule",
    "are returns free": "return_fee",
    "who pays for return shipping": "return_shipping_payer",
    "who pays return shipping": "return_shipping_payer",
    "what is the return shipping cost": "return_shipping_amount",
    "how much is return shipping": "return_shipping_amount",
    "how much does return shipping cost": "return_shipping_amount",
    "how much do i pay for return shipping": "return_shipping_amount",
    "are refunds available": "refund_rule",
    "are refunds allowed": "refund_rule",
    "are photos required for a damaged-item refund": "photo_rule",
}
_EXCHANGE_DISCUSSION_QUESTIONS = frozenset(
    {
        "can i exchange an item",
        "can i return or exchange an item",
        "what is your exchange policy",
    }
)
_GENERIC_RETURN_SECTION_QUESTIONS = frozenset(
    {
        "what is your returns policy",
        "what is your return policy",
        "what is the return policy",
    }
)
_CHANGE_OF_MIND_RETURN_LOOKUP = "change-of-mind returns unopened non-final-sale physical goods returned and inspected"
_PRODUCT_POLICY_QUESTIONS: dict[str, PolicyQuestionKind] = {
    "can i return {product}": "return_rule",
    "what is the return policy for {product}": "return_rule",
    "what is the return policy on {product}": "return_rule",
    "what is your return policy for {product}": "return_rule",
}
_PRODUCT_POLICY_CLAUSES: dict[str, PolicyQuestionKind] = {
    "your returns policy": "return_rule",
    "your return policy": "return_rule",
    "the return policy": "return_rule",
}
_READABLE_SOURCE_LABEL = re.compile(r"[\w][\w .,&()'’\-]*\Z")
_RETURN_WINDOW = re.compile(
    r"(?P<subject>Returns|Exchanges|Refund requests) (?P<modal>are|may be) "
    r"(?P<verb>accepted|allowed) within (?P<count>[1-9][0-9]{0,2}) "
    r"(?:(?P<basis>calendar|business) )?"
    r"(?P<unit>days|weeks|months) of delivery\.\Z",
    re.IGNORECASE,
)
_RETURN_SHIPPING_PAYER = re.compile(
    r"Customers pay for return shipping\.\Z", re.IGNORECASE
)
_RETURN_SHIPPING_FREE = re.compile(r"Return shipping is free\.\Z", re.IGNORECASE)
_SIMPLE_POLICY = re.compile(
    r"(?P<subject>Returns|Exchanges|Refunds) are "
    r"(?P<decision>accepted|allowed|not accepted|not allowed)\.\Z",
    re.IGNORECASE,
)
_DAMAGED_PHOTO_RULE = re.compile(
    r"Photo evidence is required before a damaged-item refund can be approved\.\Z",
    re.IGNORECASE,
)
_ACME_CHANGE_OF_MIND_RETURN = (
    "Unopened, non-final-sale physical goods may be refunded within 14 calendar "
    "days of delivery after the item is returned and inspected."
)
_CURRENCY_MINOR_DIGITS = {
    "AUD": 2,
    "CAD": 2,
    "CHF": 2,
    "CNY": 2,
    "EUR": 2,
    "GBP": 2,
    "INR": 2,
    "JPY": 0,
    "KWD": 3,
    "USD": 2,
}
_UNAVAILABLE = "I couldn't verify that information right now. Please try again later or contact support."
_PRODUCT_CLARIFY = (
    "Which product do you mean? Please share one product name so I can check it."
)
_VARIANT_CLARIFY = (
    "Which variant do you mean? Please share its full name so I can check it."
)
_EXPLICIT_PRODUCT_QUESTION = re.compile(
    r"^(?:what is the (?:price|cost) of (?:the )?(?:product named )?"
    r"|do you sell (?:the )?)"
    r"(?P<name>[^?.,!\n]{1,200}?)"
    r"(?:,\s+and\s+what is its price)?[?.!]?$",
    re.IGNORECASE,
)


class AnswerFactSelection(BaseModel):
    """Model-selected source span, never a customer-facing answer."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    policy_chunk_id: str | None = Field(default=None, max_length=160)
    policy_excerpt: str | None = Field(default=None, max_length=500)


class StructuredAnswerModel(Protocol):
    async def select_answer_facts(
        self,
        *,
        question: str,
        evidence: list[dict[str, object]],
        product: dict[str, object] | None,
    ) -> object: ...


def _response(status: str, message: str) -> ReadOnlySupportResponse:
    if len(message) > 2_000:
        status, message = "source_unavailable", _UNAVAILABLE
    return ReadOnlySupportResponse(
        journey="product_policy",
        status=status,
        customer_answer=CustomerAnswer(message=message),
    )


def _safe_public_text(value: str) -> bool:
    return (
        bool(value.strip())
        and "://" not in value
        and "@" not in value
        and all(character.isprintable() for character in value)
    )


def _readable_source_label(value: str, *, limit: int) -> bool:
    return (
        0 < len(value) <= limit and _READABLE_SOURCE_LABEL.fullmatch(value) is not None
    )


def _normalize_question(value: str) -> str:
    return " ".join(value.casefold().strip().rstrip("?.!").split())


def is_generic_exchange_discussion(value: str) -> bool:
    return _normalize_question(value) in _EXCHANGE_DISCUSSION_QUESTIONS


def _catalog_search_text(question: str, product_query: str | None) -> str:
    explicit_name = _explicit_product_name(question)
    if explicit_name is not None:
        return explicit_name
    if product_query is not None:
        return product_query.strip()
    return question[:200]


def _explicit_product_name(question: str) -> str | None:
    price_name = explicit_price_name(question)
    if price_name is not None:
        return price_name
    match = _EXPLICIT_PRODUCT_QUESTION.fullmatch(question.strip())
    if match is not None:
        return match.group("name").strip()
    return explicit_availability_name(question)


def _catalog_match_for_query(product: ProductMatch, query: str) -> ProductMatch | None:
    normalized_query = _normalize_question(query)
    normalized_name = _normalize_question(product.name)
    if not normalized_query or not normalized_name:
        return None
    if normalized_query == normalized_name:
        return product
    if not normalized_query.startswith(f"{normalized_name} "):
        return None
    requested_variant = normalized_query.removeprefix(f"{normalized_name} ")
    variants = [
        variant
        for variant in product.variants
        if requested_variant == _normalize_question(variant.name)
        or normalized_query == _normalize_question(variant.name)
    ]
    if len(variants) != 1:
        return None
    return product.model_copy(update={"variants": variants})


def _policy_question_kind(
    question: str, *, product_query: str | None
) -> PolicyQuestionKind | None:
    normalized = _normalize_question(question)
    if product_query is None:
        return _GENERIC_POLICY_QUESTIONS.get(normalized)

    normalized_product = _normalize_question(product_query)
    if not normalized_product or normalized_product not in normalized:
        return None
    template = normalized.replace(normalized_product, "{product}", 1)
    direct_kind = _PRODUCT_POLICY_QUESTIONS.get(template)
    if direct_kind is not None:
        return direct_kind

    clauses = normalized.split(" and ")
    if len(clauses) != 2:
        return None
    eligible = [
        _PRODUCT_POLICY_CLAUSES[clause]
        for clause in clauses
        if clause in _PRODUCT_POLICY_CLAUSES
    ]
    return eligible[0] if len(eligible) == 1 else None


def _policy_fact(kind: PolicyQuestionKind, excerpt: str) -> str | None:
    """Allow only bounded declarative source facts, never arbitrary source prose."""

    if len(excerpt) > 250 or not excerpt.isprintable():
        return None
    if kind == "return_shipping_payer":
        if _RETURN_SHIPPING_PAYER.fullmatch(excerpt):
            return "Customers pay for return shipping."
        if _RETURN_SHIPPING_FREE.fullmatch(excerpt):
            return "Return shipping is free."
        return None
    if kind in {"return_shipping_amount", "return_fee"}:
        return None
    if kind == "photo_rule":
        if _DAMAGED_PHOTO_RULE.fullmatch(excerpt):
            return "Photo evidence is required before a damaged-item refund can be approved."
        return None
    if kind == "return_rule" and excerpt == _ACME_CHANGE_OF_MIND_RETURN:
        return excerpt

    window = _RETURN_WINDOW.fullmatch(excerpt)
    if window is not None:
        subject = window.group("subject").lower()
        if not (
            (kind == "return_rule" and subject == "returns")
            or (kind == "refund_rule" and subject == "refund requests")
        ):
            return None
        basis = window.group("basis")
        timing = f"{basis} " if basis else ""
        return (
            f"{window.group('subject')} {window.group('modal')} {window.group('verb')} within "
            f"{window.group('count')} {timing}{window.group('unit')} of delivery."
        )

    simple = _SIMPLE_POLICY.fullmatch(excerpt)
    if simple is not None and (
        (kind == "return_rule" and simple.group("subject").lower() == "returns")
        or (kind == "refund_rule" and simple.group("subject").lower() == "refunds")
    ):
        return f"{simple.group('subject')} are {simple.group('decision')}."
    return None


def _verified_quote(
    *,
    kind: PolicyQuestionKind,
    selection: AnswerFactSelection,
    evidence: list[CustomerEvidence],
) -> str | None:
    if selection.policy_chunk_id is None or selection.policy_excerpt is None:
        return None
    matches = [item for item in evidence if item.chunk_id == selection.policy_chunk_id]
    if len(matches) != 1:
        return None
    item = matches[0]
    excerpt = selection.policy_excerpt
    title = item.citation.title
    sections = item.citation.section_path
    if not excerpt or excerpt not in item.content:
        return None
    if not _readable_source_label(title, limit=120):
        return None
    if len(sections) > 3 or not all(
        _readable_source_label(section, limit=100) for section in sections
    ):
        return None
    fact = _policy_fact(kind, excerpt)
    if fact is None:
        return None
    return f"{fact} (Source: {title}, {' > '.join(sections)}.)"


def _verified_exact_photo_rule(evidence: list[CustomerEvidence]) -> str | None:
    excerpt = "Photo evidence is required before a damaged-item refund can be approved."
    for item in evidence:
        if excerpt in item.content:
            verified = _verified_quote(
                kind="photo_rule",
                selection=AnswerFactSelection(
                    policy_chunk_id=item.chunk_id,
                    policy_excerpt=excerpt,
                ),
                evidence=evidence,
            )
            if verified is not None:
                return verified
    return None


def _verified_exact_acme_return_rule(evidence: list[CustomerEvidence]) -> str | None:
    for item in evidence:
        if _ACME_CHANGE_OF_MIND_RETURN in item.content:
            verified = _verified_quote(
                kind="return_rule",
                selection=AnswerFactSelection(
                    policy_chunk_id=item.chunk_id,
                    policy_excerpt=_ACME_CHANGE_OF_MIND_RETURN,
                ),
                evidence=evidence,
            )
            if verified is not None:
                return verified
    return None


def _format_price(amount_minor: int, currency: str) -> str | None:
    digits = _CURRENCY_MINOR_DIGITS.get(currency)
    if digits is None:
        return None
    divisor = 10**digits
    major, minor = divmod(amount_minor, divisor)
    amount = str(major) if digits == 0 else f"{major}.{minor:0{digits}d}"
    return f"{amount} {currency}"


def _format_product(product: ProductMatch, *, price_requested: bool) -> str | None:
    if not _safe_public_text(product.name):
        return None
    details = [f"{product.name} is listed in the catalog."]
    variants = []
    has_verified_price = False
    for variant in product.variants[:2]:
        if not _safe_public_text(variant.name):
            return None
        detail = variant.name
        if variant.price is not None:
            price = _format_price(variant.price.amount_minor, variant.price.currency)
            if price is not None:
                detail += f" — {price}"
                has_verified_price = True
        variants.append(detail)
    if price_requested and not has_verified_price:
        return None
    if variants:
        details.append(f"Variants: {'; '.join(variants)}.")
    if len(product.variants) > 2:
        details.append(f"Showing 2 of {len(product.variants)} variants.")
    return " ".join(details)


def _format_variant_availability(product: ProductMatch, requested: str) -> str | None:
    if _normalize_question(requested) == _normalize_question(product.name):
        return None
    if len(product.variants) != 1:
        return None
    variant = product.variants[0]
    if not _safe_public_text(product.name) or not _safe_public_text(variant.name):
        return None
    if variant.availability is None:
        return None
    name = variant.name
    if not _normalize_question(name).startswith(_normalize_question(product.name)):
        name = f"{product.name} {name}"
    label = "in stock" if variant.availability == "IN_STOCK" else "out of stock"
    return (
        f"The catalog lists {name} as {label}. "
        "Availability can change; this does not reserve an item."
    )


def _format_variant_price(product: ProductMatch) -> str | None:
    if len(product.variants) != 1 or not _safe_public_text(product.name):
        return None
    variant = product.variants[0]
    if not _safe_public_text(variant.name) or variant.price is None:
        return None
    price = _format_price(variant.price.amount_minor, variant.price.currency)
    if price is None:
        return None
    name = variant.name
    if not _normalize_question(name).startswith(_normalize_question(product.name)):
        name = f"{product.name} {name}"
    return (
        f"The current catalog price for {name} is {price} including tax. "
        "This is not a checkout total or a quote, and it does not hold the price or item."
    )


async def answer_product_policy(
    request: SupportIntakeRequest,
    evidence_client: CustomerEvidenceLookup,
    catalog_client: ProductCatalogLookup,
    answer_model: StructuredAnswerModel,
    *,
    product_query: str | None = None,
) -> ReadOnlySupportResponse:
    """Render only verified public catalog facts and exact customer-safe policy spans."""

    question = request.customer_message
    exchange_discussion = is_generic_exchange_discussion(question)
    availability_name = explicit_availability_name(question)
    price_name = explicit_price_name(question)
    needs_policy = bool(_POLICY_TOPIC.search(question))
    if product_query is not None and (
        not product_query.strip() or len(product_query) > 200
    ):
        return _response("source_unavailable", _UNAVAILABLE)
    if needs_policy and _normalize_question(question) in _GENERIC_POLICY_QUESTIONS:
        product_query = None
    needs_product = product_query is not None or not needs_policy
    explicit_product_name = _explicit_product_name(question)
    if needs_product and not needs_policy and explicit_product_name is None:
        return _response("source_unavailable", _UNAVAILABLE)
    question_kind = (
        _policy_question_kind(question, product_query=product_query)
        if needs_policy
        else None
    )
    if needs_policy and question_kind is None:
        return _response("source_unavailable", _UNAVAILABLE)
    product: ProductMatch | None = None
    if needs_product:
        catalog_query = (
            product_query
            if needs_policy and product_query is not None
            else _catalog_search_text(question, product_query)
        )
        try:
            catalog = ProductCatalogResult.model_validate(
                await catalog_client.lookup_product_catalog(catalog_query)
            )
        except Exception:  # noqa: BLE001 - external catalog failure must fail closed
            return _response("source_unavailable", _UNAVAILABLE)
        if len(catalog.matches) != 1:
            return _response("awaiting_product", _PRODUCT_CLARIFY)
        product = catalog.matches[0]
        requested_product = (
            product_query
            if needs_policy and product_query is not None
            else explicit_product_name or product_query
        )
        product = (
            _catalog_match_for_query(product, requested_product)
            if requested_product is not None
            else None
        )
        if product is None:
            catalog_name = _normalize_question(catalog.matches[0].name)
            requested_name = _normalize_question(requested_product or "")
            requested_variant_of_product = bool(
                catalog_name and requested_name.startswith(f"{catalog_name} ")
            )
            return _response(
                "awaiting_product",
                _VARIANT_CLARIFY
                if requested_variant_of_product
                and (availability_name is not None or price_name is not None)
                else _PRODUCT_CLARIFY,
            )

    if price_name is not None and product is not None:
        product_only = _normalize_question(price_name) == _normalize_question(
            product.name
        )
        if product_only and len(product.variants) != 1:
            return _response("awaiting_product", _VARIANT_CLARIFY)
        price_text = _format_variant_price(product)
        if price_text is None:
            return _response("source_unavailable", _UNAVAILABLE)
        if product_only:
            price_text = f"{product.name} is listed in the catalog. {price_text}"
        return _response("answer_ready", price_text)

    if availability_name is not None and product is not None:
        if _normalize_question(availability_name) == _normalize_question(product.name):
            return _response("awaiting_product", _VARIANT_CLARIFY)
        availability_text = _format_variant_availability(product, availability_name)
        if availability_text is None:
            return _response("source_unavailable", _UNAVAILABLE)
        return _response("answer_ready", availability_text)

    product_text = (
        _format_product(
            product,
            price_requested=bool(
                re.search(r"\b(?:price|cost)\b", question, re.IGNORECASE)
            ),
        )
        if product is not None
        else None
    )
    if needs_product and product_text is None:
        return _response("source_unavailable", _UNAVAILABLE)

    evidence: list[CustomerEvidence] = []
    if needs_policy:
        try:
            targeted_return = (
                exchange_discussion
                or _normalize_question(question) in _GENERIC_RETURN_SECTION_QUESTIONS
            )
            evidence_query = (
                _CHANGE_OF_MIND_RETURN_LOOKUP if targeted_return else question
            )
            retrieved = CustomerEvidenceResponse.model_validate(
                await evidence_client.retrieve_customer_evidence(evidence_query)
            )
            evidence = retrieved.evidence
        except Exception:  # noqa: BLE001 - external retrieval failure must fail closed
            return _response("source_unavailable", _UNAVAILABLE)
        if not evidence:
            return _response("source_unavailable", _UNAVAILABLE)

    policy_text = None
    if question_kind == "photo_rule":
        policy_text = _verified_exact_photo_rule(evidence)
    elif question_kind == "return_rule" and product_query is None:
        policy_text = _verified_exact_acme_return_rule(evidence)
    if exchange_discussion and policy_text is None:
        return _response("source_unavailable", _UNAVAILABLE)
    if needs_policy and policy_text is None:
        # Do not expose source URIs or internal release/document IDs to the model.
        model_evidence: list[dict[str, object]] = [
            {
                "chunk_id": item.chunk_id,
                "content": item.content,
                "title": item.citation.title,
                "section_path": item.citation.section_path,
            }
            for item in evidence
        ]
        model_product = (
            product.model_dump(by_alias=True, exclude_none=True)
            if product is not None
            else None
        )
        try:
            selected = AnswerFactSelection.model_validate(
                await answer_model.select_answer_facts(
                    question=question,
                    evidence=model_evidence,
                    product=model_product,
                )
            )
        except Exception:  # noqa: BLE001 - malformed or failed model output is unsafe
            return _response("source_unavailable", _UNAVAILABLE)
        policy_text = _verified_quote(
            kind=question_kind,
            selection=selected,
            evidence=evidence,
        )
        if policy_text is None:
            return _response("source_unavailable", _UNAVAILABLE)

    if exchange_discussion:
        policy_text = (
            f"For returns, {policy_text} I can't verify an exchange policy or approve an "
            "exchange here. You can ask a support specialist through the human "
            "consultation option."
        )
    return _response(
        "answer_ready", " ".join(part for part in (product_text, policy_text) if part)
    )
