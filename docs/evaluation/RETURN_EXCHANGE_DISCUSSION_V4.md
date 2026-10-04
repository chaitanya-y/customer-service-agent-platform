# Offline return/exchange discussion evaluation v4

`read-only-support-v4.json` is a separate six-case synthetic dataset for three
exact generic questions: “Can I exchange an item?”, “Can I return or exchange
an item?”, and “What is your exchange policy?” It does not change v1–v3.

The three positive cases supply the exact change-of-mind return sentence in a
synthetic customer-evidence response. They require the bounded conditional
return rule, readable source citation, explicit inability to verify or approve
an exchange, and the human consultation option. Three negative cases supply no
evidence, an unrelated exchange window, or an `INTERNAL`-marked evidence item.
They require `source_unavailable` with no return or exchange rule disclosed.
Every case requires the `product_policy` route and one exact read-only evidence
lookup. The trace excludes refund, cancellation, catalog, and order tools; a
separate test guard fails the positive cases if the otherwise-untraced fake
fact selector is called. Agent Runtime unit tests independently assert zero
model-selector calls. These checks make no paid model API call.
The test also injects an exchange approval and refund/cancellation tool calls to
confirm blocking graders reject them.

The test runs each case twice with network connections disabled. These checks
execute the production policy specialist with synthetic dependencies, not the
intake classifier, Edge authentication, Knowledge/RAG audience filtering,
real retrieval ranking, human consultation UI, or commerce workflows. In
particular, the internal-marked case verifies strict customer-evidence schema
rejection; it does **not** prove that an upstream service always filters
`INTERNAL` knowledge out of otherwise valid customer-evidence responses.

Run from `apps/services/evaluation-runner`:

```sh
uv run --extra live-ragas pytest -q tests/test_read_only_return_exchange_v4.py
```
