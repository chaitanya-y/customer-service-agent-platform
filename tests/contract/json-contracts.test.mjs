import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");

const contracts = {
  contextAssertion:
    "contracts/internal-api/trusted-context-assertion/v1/context-assertion-claims.schema.json",
  executionEvidence:
    "contracts/ai-io/execution-evidence/v1/execution-evidence.schema.json",
  orderContext:
    "contracts/tools/order-context/v1/order-context.schema.json",
  refundContext:
    "contracts/tools/refund-context/v1/refund-context.schema.json",
  refundProposal:
    "contracts/workflows/proposals/v1/refund-proposal.schema.json",
  refundPolicyInput:
    "contracts/workflows/policy/v1/refund-policy-input.schema.json",
  policyDecision:
    "contracts/workflows/policy/v1/policy-decision.schema.json",
  refundEvidenceSummary:
    "contracts/customer-api/refund-evidence/v1/refund-evidence-summary.schema.json",
  refundEvidenceReviewCommand:
    "contracts/human-api/refund-evidence/v1/refund-evidence-review-command.schema.json",
  supportIntake:
    "contracts/ai-io/support-intake/v1/support-intake-response.schema.json",
  productCatalog:
    "contracts/tools/product-catalog/v1/product-catalog.schema.json",
};

const fixtures = {
  contextAssertion: "context-assertion",
  executionEvidence: "execution-evidence",
  orderContext: "order-context",
  refundContext: "refund-context",
  refundProposal: "refund-proposal",
  refundPolicyInput: "refund-policy-input",
  policyDecision: "policy-decision",
  refundEvidenceSummary: "refund-evidence-summary",
  refundEvidenceReviewCommand: "refund-evidence-review-command",
  supportIntake: "support-intake",
  productCatalog: "product-catalog",
};

async function readJson(relativePath) {
  const content = await readFile(
    path.join(repositoryRoot, relativePath),
    "utf8",
  );
  return JSON.parse(content);
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});
addFormats(ajv);

for (const schemaPath of Object.values(contracts)) {
  ajv.addSchema(await readJson(schemaPath));
}

for (const [contractName, schemaPath] of Object.entries(contracts)) {
  test(`${contractName} schema compiles`, () => {
    const schema = ajv.getSchema(
      pathToSchemaId(schemaPath),
    );
    assert.ok(schema);
  });

  test(`${contractName} accepts its valid fixture`, async () => {
    const validate = ajv.getSchema(pathToSchemaId(schemaPath));
    const fixture = await readJson(
      `tests/contract/fixtures/${fixtures[contractName]}/valid.json`,
    );

    assert.equal(
      validate(fixture),
      true,
      ajv.errorsText(validate.errors),
    );
  });

  test(`${contractName} rejects its unsafe fixture`, async () => {
    const validate = ajv.getSchema(pathToSchemaId(schemaPath));
    const fixture = await readJson(
      `tests/contract/fixtures/${fixtures[contractName]}/invalid.json`,
    );

    assert.equal(validate(fixture), false);
    assert.ok(validate.errors?.length);
  });
}

test("context assertion accepts only a well-formed optional refund policy binding", async () => {
  const validate = ajv.getSchema(pathToSchemaId(contracts.contextAssertion));
  const valid = await readJson(
    `tests/contract/fixtures/${fixtures.contextAssertion}/valid.json`,
  );

  assert.equal(
    validate({
      ...valid,
      refundPolicy: {
        policyVersion: "refund-policy-v1",
        catalogSha256: "a".repeat(64),
      },
    }),
    true,
    ajv.errorsText(validate.errors),
  );
  assert.equal(
    validate({
      ...valid,
      refundPolicy: {
        policyVersion: "refund-policy-v1",
        catalogSha256: "not-a-hash",
      },
    }),
    false,
  );
  assert.equal(
    validate({
      ...valid,
      refundPolicy: {
        policyVersion: "refund-policy-v1",
        catalogSha256: "a".repeat(64),
        threshold: 1,
      },
    }),
    false,
  );
});

test("supportIntake rejects a proposal on a read-only journey", async () => {
  const validate = ajv.getSchema(pathToSchemaId(contracts.supportIntake));

  assert.equal(
    validate({
      journey: "order_status",
      status: "answer_ready",
      customer_answer: { message: "Your order is processing." },
      refund_proposal: { proposalId: "forged-proposal" },
    }),
    false,
  );
});

test("supportIntake accepts only a minimal owned-order items answer", () => {
  const validate = ajv.getSchema(pathToSchemaId(contracts.supportIntake));
  const answer = {
    journey: "order_items",
    status: "answer_ready",
    customer_answer: { message: "Order ORDER-123 contains Laptop (quantity 2)." },
  };

  assert.equal(validate(answer), true, ajv.errorsText(validate.errors));
  assert.equal(validate({ ...answer, refund_proposal: { proposalId: "forged" } }), false);
  assert.equal(validate({ ...answer, status: "awaiting_product" }), false);
});

test("supportIntake requires a proposal for a ready refund", () => {
  const validate = ajv.getSchema(pathToSchemaId(contracts.supportIntake));

  assert.equal(
    validate({
      journey: "refund",
      status: "refund_proposal_ready",
      customer_message: "I need a refund.",
      order_reference: "3",
    }),
    false,
  );
});

test("supportIntake accepts a legacy refund proposal before it is ready", async () => {
  const validate = ajv.getSchema(pathToSchemaId(contracts.supportIntake));
  const refundProposal = await readJson(
    "tests/contract/fixtures/refund-proposal/valid.json",
  );

  assert.equal(
    validate({
      journey: "refund",
      status: "awaiting_refund_details",
      customer_message: "I need a refund.",
      order_reference: "3",
      refund_proposal: refundProposal,
    }),
    true,
    ajv.errorsText(validate.errors),
  );
});

test("productCatalog rejects excess and internal data", async () => {
  const validate = ajv.getSchema(pathToSchemaId(contracts.productCatalog));
  const valid = await readJson(
    `tests/contract/fixtures/${fixtures.productCatalog}/valid.json`,
  );

  assert.equal(
    validate({ ...valid, matches: Array.from({ length: 6 }, () => valid.matches[0]) }),
    false,
  );
  assert.equal(
    validate({
      ...valid,
      matches: [{ ...valid.matches[0], sourceId: "vendure-123" }],
    }),
    false,
  );
});

function pathToSchemaId(schemaPath) {
  const ids = {
    [contracts.contextAssertion]:
      "https://customer-service-os.example/contracts/internal-api/trusted-context-assertion/v1/claims",
    [contracts.executionEvidence]:
      "https://customer-service-os.example/contracts/ai-io/execution-evidence/v1",
    [contracts.orderContext]:
      "https://customer-service-os.example/contracts/tools/order-context/v1",
    [contracts.refundContext]:
      "https://customer-service-os.example/contracts/tools/refund-context/v1",
    [contracts.refundProposal]:
      "https://customer-service-os.example/contracts/workflows/proposals/v1/refund-proposal",
    [contracts.refundPolicyInput]:
      "https://customer-service-os.example/contracts/workflows/policy/v1/refund-policy-input",
    [contracts.policyDecision]:
      "https://customer-service-os.example/contracts/workflows/policy/v1/refund-policy-decision",
    [contracts.refundEvidenceSummary]:
      "https://customer-service-os.example/contracts/customer-api/refund-evidence/v1/summary",
    [contracts.refundEvidenceReviewCommand]:
      "https://customer-service-os.example/contracts/human-api/refund-evidence/v1/review-command",
    [contracts.supportIntake]:
      "https://customer-service-os.example/contracts/ai-io/support-intake/v1",
    [contracts.productCatalog]:
      "https://customer-service-os.example/contracts/tools/product-catalog/v1",
  };

  return ids[schemaPath];
}
