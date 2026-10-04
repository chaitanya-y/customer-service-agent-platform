# Return and exchange discussion boundary

The Agent Runtime's read-only product/policy path recognizes three direct generic
questions: “Can I exchange an item?”, “Can I return or exchange an item?”, and
“What is your exchange policy?” It answers with the conditional Acme
change-of-mind **return** sentence only when that exact sentence is present in
retrieved customer-safe evidence and has a valid public citation. The response
labels it as a return rule, says that it cannot verify an exchange policy or
approve an exchange, and points to the existing human consultation option.

This is policy discussion, not an exchange or return request. It does not check
an order's eligibility, start a refund workflow, issue a label, quote fees,
reserve stock, or promise an exchange. If the exact return source is absent,
retrieval fails, or the citation is invalid, the agent gives its existing
source-unavailable answer. It does not treat a generic return window as proof
of an exchange policy. Other exchange phrasings remain outside this narrow
deterministic path and may safely fall back to clarification or unavailable.

The evidence lookup is restricted to `CUSTOMER_SAFE` by Knowledge/RAG's
customer-evidence boundary; the Agent Runtime verifies the selected span and
prints only the readable citation, never its private source URI. These tests
use synthetic evidence and do not prove that a live retrieval for every
exchange phrasing will find the published source. The consultation button and
its staffing/browser gate are tracked in
[Next journey boundaries](NEXT_JOURNEY_BOUNDARIES.md).

## Live retrieval diagnostic, 2026-10-02

A local authenticated Edge chat asked “Can I exchange an item?” and safely
returned source unavailable, with no refund or cancellation action. The exact
change-of-mind return sentence exists in the registered `CUSTOMER_SAFE`
tenant-local index (`section-005-chunk-001`), but Knowledge/RAG's top-three
results for the raw exchange question were damaged items, exclusions, and
incorrect/missing items. The needed return section was absent. A separately
signed, read-only Knowledge/RAG request for “change-of-mind returns unopened
non-final-sale physical goods returned and inspected” returned that exact
return section first. This isolates the miss to the retrieval query, not the
index or source classification. The agent still requires the exact quoted
source and public citation; an exchange remains unverified. The narrow fix
uses the targeted query only for the three recognized generic exchange
questions. Six query-sensitive red/green tests cover exact-source-present and
absent cases; the full Agent Runtime suite passed 516 tests and Ruff passed.
After restarting Agent Runtime, the same authenticated Edge question returned
the exact conditional return sentence with its section citation, explicitly
declined to verify or approve an exchange, and offered human consultation.
The persisted two-message conversation had no refund or cancellation link.
This is one live local answer, not repeated-trial reliability or an exchange
fulfillment test. Neither diagnostic chat created a commerce workflow.

The separate [offline v4 evaluation](evaluation/RETURN_EXCHANGE_DISCUSSION_V4.md)
runs six synthetic evidence cases twice. It checks the exact retrieval query,
source-dependent response, exchange uncertainty, and absence of action tools;
it does not replace the one live retrieval observation or browser/staffing QA.
