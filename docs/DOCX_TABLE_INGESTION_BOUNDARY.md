# DOCX table ingestion boundary

Status: parser-v1 now **rejects a DOCX with a top-level table** before indexing
any of its paragraphs. It does not extract table text. Previously, a document
with both paragraphs and a table could produce a partial knowledge artifact
with only a warning, leaving policy conditions in the table absent from search.
Rejecting the whole source is safer than publishing incomplete customer-safe
evidence. Table-free DOCX documents retain the same parser version, sections,
and page-location warning; no registered source, release, or index was changed.

The new generated mixed paragraph/table regression failed against the former
parser and passes with early rejection. The full Knowledge/RAG suite passed
150 tests and Ruff lint passed. This is offline parser verification, not a
production re-ingestion or an assertion that every table location is detected.
In particular, python-docx's top-level `Document.tables` does not include
tables nested in cells or in other document parts such as headers/footers;
those parts are not normalized by parser-v1 either. See the
[python-docx document API](https://python-docx.readthedocs.io/en/latest/api/document.html).

Full table support requires a separate parser version, not an in-place edit to
an already published release. A proposed parser-v2 must preserve paragraph
and table order under the correct heading, define unambiguous row/column
serialization, test merged/omitted/nested cells and table-only documents, and
make unsupported structures fail closed. The [python-docx table guide](https://python-docx.readthedocs.io/en/latest/user/tables.html)
explains why merged cells and omitted grid positions need explicit handling.
Then re-run chunking, embeddings, retrieval tests, and customer-answer
evaluation, publish an immutable new knowledge release, and switch consumers
only after review. Added table text can shift section/chunk identities and
citations even when the source file's SHA-256 is unchanged.
