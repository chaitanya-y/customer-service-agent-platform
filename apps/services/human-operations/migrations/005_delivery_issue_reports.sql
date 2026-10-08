CREATE TABLE human_operations.delivery_issue_reports (
  tenant_id text NOT NULL,
  environment_id text NOT NULL,
  report_id text NOT NULL,
  customer_id text NOT NULL,
  conversation_id text NOT NULL,
  order_reference text NOT NULL,
  category text NOT NULL CHECK (category IN ('MISSING', 'WRONG', 'DAMAGED', 'DELAYED')),
  status text NOT NULL CHECK (status IN ('RECEIVED', 'CLAIMED', 'ACKNOWLEDGED')),
  report_version bigint NOT NULL CHECK (report_version >= 1),
  assigned_staff_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  claimed_at timestamptz,
  acknowledged_at timestamptz,
  PRIMARY KEY (tenant_id, environment_id, report_id),
  CHECK (
    (status = 'RECEIVED' AND assigned_staff_id IS NULL AND claimed_at IS NULL AND acknowledged_at IS NULL)
    OR (status = 'CLAIMED' AND assigned_staff_id IS NOT NULL AND claimed_at IS NOT NULL AND acknowledged_at IS NULL)
    OR (status = 'ACKNOWLEDGED' AND assigned_staff_id IS NOT NULL AND claimed_at IS NOT NULL AND acknowledged_at IS NOT NULL)
  )
);

CREATE TABLE human_operations.delivery_issue_report_audit_events (
  tenant_id text NOT NULL,
  environment_id text NOT NULL,
  event_id text NOT NULL,
  report_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('REPORT_RECEIVED', 'REPORT_CLAIMED', 'REPORT_ACKNOWLEDGED')),
  occurred_at timestamptz NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('CUSTOMER', 'HUMAN')),
  actor_id text NOT NULL,
  report_version bigint NOT NULL CHECK (report_version >= 1),
  PRIMARY KEY (tenant_id, environment_id, event_id),
  FOREIGN KEY (tenant_id, environment_id, report_id)
    REFERENCES human_operations.delivery_issue_reports (tenant_id, environment_id, report_id)
);

CREATE TABLE human_operations.delivery_issue_report_idempotency (
  tenant_id text NOT NULL,
  environment_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('create', 'claim', 'acknowledge')),
  idempotency_scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  report_id text,
  response_snapshot jsonb,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, action, idempotency_scope, idempotency_key),
  FOREIGN KEY (tenant_id, environment_id, report_id)
    REFERENCES human_operations.delivery_issue_reports (tenant_id, environment_id, report_id),
  CHECK (response_snapshot IS NULL OR jsonb_typeof(response_snapshot) = 'object')
);

CREATE INDEX delivery_issue_reports_queue
  ON human_operations.delivery_issue_reports (tenant_id, environment_id, status, updated_at DESC);
CREATE INDEX delivery_issue_report_audit_by_report
  ON human_operations.delivery_issue_report_audit_events (tenant_id, environment_id, report_id, occurred_at, event_id);

ALTER TABLE human_operations.delivery_issue_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_operations.delivery_issue_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE human_operations.delivery_issue_report_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_operations.delivery_issue_report_audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE human_operations.delivery_issue_report_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_operations.delivery_issue_report_idempotency FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_environment_scope ON human_operations.delivery_issue_reports
  USING (tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id())
  WITH CHECK (tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id());
CREATE POLICY tenant_environment_scope ON human_operations.delivery_issue_report_audit_events
  USING (tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id())
  WITH CHECK (tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id());
CREATE POLICY tenant_environment_scope ON human_operations.delivery_issue_report_idempotency
  USING (tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id())
  WITH CHECK (tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id());

-- Migration 001 set broad default table privileges; narrow these three new
-- objects explicitly so the runtime role cannot erase the audit trail.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cso_human_operations_app') THEN
    REVOKE ALL ON human_operations.delivery_issue_reports,
      human_operations.delivery_issue_report_audit_events,
      human_operations.delivery_issue_report_idempotency
      FROM cso_human_operations_app;
    GRANT SELECT, INSERT, UPDATE ON human_operations.delivery_issue_reports TO cso_human_operations_app;
    GRANT SELECT, INSERT ON human_operations.delivery_issue_report_audit_events TO cso_human_operations_app;
    GRANT SELECT, INSERT, UPDATE ON human_operations.delivery_issue_report_idempotency TO cso_human_operations_app;
  END IF;
END
$$;
