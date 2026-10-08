"""Bounded current-turn catalog question shapes shared by routing and answering."""

from __future__ import annotations

import re

_EXPLICIT_AVAILABILITY_QUESTION = re.compile(
    r"^is (?:the )?(?P<name>[^?.,!\n]{1,200}?) (?:in stock|available)[?.!]?$",
    re.IGNORECASE,
)
_EXPLICIT_PRICE_QUESTION = re.compile(
    r"^(?:what is the (?:price|cost) of (?:the )?(?:product named )?"
    r"(?P<price_name>[^?.,!\n]{1,200}?)"
    r"|how much does (?:the )?(?P<cost_name>[^?.,!\n]{1,200}?) cost)"
    r"[?.!]?$",
    re.IGNORECASE,
)
_PRICE_MENTION = re.compile(
    r"\bprice\b|\bhow much\b[^.!?]{0,200}\bcost\b", re.IGNORECASE
)
_COMPOUND_NAME = re.compile(r"\b(?:and|then|also|plus)\b", re.IGNORECASE)


def explicit_availability_name(question: str) -> str | None:
    match = _EXPLICIT_AVAILABILITY_QUESTION.fullmatch(question.strip())
    return match.group("name").strip() if match is not None else None


def explicit_price_name(question: str) -> str | None:
    match = _EXPLICIT_PRICE_QUESTION.fullmatch(question.strip())
    if match is None:
        return None
    name = (match.group("price_name") or match.group("cost_name")).strip()
    return name if name and _COMPOUND_NAME.search(name) is None else None


def mentions_price(question: str) -> bool:
    return _PRICE_MENTION.search(question) is not None
