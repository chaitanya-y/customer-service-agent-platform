CREATE SCHEMA IF NOT EXISTS cancellation;

CREATE TABLE cancellation.executions (
  operation_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  environment_id text NOT NULL,
  workflow_id text NOT NULL,
  customer_id text NOT NULL,
  order_id text NOT NULL,
  order_reference text NOT NULL,
  preview_id text NOT NULL,
  preview_expires_at timestamptz NOT NULL,
  policy_version text NOT NULL,
  provider_facts_digest char(64) NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('IN_PROGRESS','SUCCEEDED','FAILED','PENDING_RECONCILIATION')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, environment_id, idempotency_key),
  UNIQUE (tenant_id, environment_id, workflow_id, preview_id)
);

CREATE UNIQUE INDEX cancellation_one_active_attempt_per_order
  ON cancellation.executions (tenant_id, environment_id, order_id) WHERE status <> 'FAILED';

GRANT USAGE ON SCHEMA cancellation TO cso_integration_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA cancellation TO cso_integration_app;
