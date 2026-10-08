-- Conservative application-only fence: no execution status releases an order.
-- This intentionally blocks later partial refunds and cannot guard Admin/PSP bypasses.
-- Historical reason/selection is unavailable: do not invent a digest for it.
ALTER TABLE refund.executions ADD COLUMN execution_intent_sha256 char(64)
  CHECK (execution_intent_sha256 IS NULL OR execution_intent_sha256 ~ '^[0-9a-f]{64}$');

CREATE TABLE refund.order_claims (
  tenant_id text NOT NULL,
  environment_id text NOT NULL,
  order_id text NOT NULL,
  execution_id uuid REFERENCES refund.executions(execution_id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, order_id),
  UNIQUE (execution_id)
);

-- Preserve every historical execution, including ambiguous failures and orders
-- with several executions. Ownerless historical claims block only new intents;
-- Existing executions without a proven intent digest cannot be replayed through
-- reserve; their ledger and exact-provider-ID reconciliation remain available.
INSERT INTO refund.order_claims (tenant_id, environment_id, order_id, created_at)
SELECT tenant_id, environment_id, order_id, MIN(created_at)
FROM refund.executions
GROUP BY tenant_id, environment_id, order_id;

-- The application cannot release or transfer a claim. Any future recovery or
-- partial-refund support needs a separately reviewed provider-safe design.
GRANT SELECT, INSERT ON refund.order_claims TO cso_integration_app;
