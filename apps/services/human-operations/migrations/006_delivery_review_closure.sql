-- Add a terminal administrative review outcome without changing existing reports.
-- The runner applies each migration in one transaction, so no intermediate
-- constraint-free state is visible. Existing RLS policies and grants stay intact.
ALTER TABLE human_operations.delivery_issue_reports ADD COLUMN closed_at timestamptz;

ALTER TABLE human_operations.delivery_issue_reports
  DROP CONSTRAINT delivery_issue_reports_status_check,
  DROP CONSTRAINT delivery_issue_reports_check;
ALTER TABLE human_operations.delivery_issue_reports
  ADD CONSTRAINT delivery_issue_reports_status_check
    CHECK (status IN ('RECEIVED', 'CLAIMED', 'ACKNOWLEDGED', 'REVIEW_CLOSED')),
  ADD CONSTRAINT delivery_issue_reports_check CHECK (
    (status = 'RECEIVED' AND assigned_staff_id IS NULL AND claimed_at IS NULL AND acknowledged_at IS NULL AND closed_at IS NULL)
    OR (status = 'CLAIMED' AND assigned_staff_id IS NOT NULL AND claimed_at IS NOT NULL AND acknowledged_at IS NULL AND closed_at IS NULL)
    OR (status = 'ACKNOWLEDGED' AND assigned_staff_id IS NOT NULL AND claimed_at IS NOT NULL AND acknowledged_at IS NOT NULL AND closed_at IS NULL)
    OR (status = 'REVIEW_CLOSED' AND assigned_staff_id IS NOT NULL AND claimed_at IS NOT NULL AND acknowledged_at IS NOT NULL AND closed_at IS NOT NULL)
  );

ALTER TABLE human_operations.delivery_issue_report_audit_events
  DROP CONSTRAINT delivery_issue_report_audit_events_event_type_check;
ALTER TABLE human_operations.delivery_issue_report_audit_events
  ADD CONSTRAINT delivery_issue_report_audit_events_event_type_check
    CHECK (event_type IN ('REPORT_RECEIVED', 'REPORT_CLAIMED', 'REPORT_ACKNOWLEDGED', 'REPORT_REVIEW_CLOSED'));

ALTER TABLE human_operations.delivery_issue_report_idempotency
  DROP CONSTRAINT delivery_issue_report_idempotency_action_check;
ALTER TABLE human_operations.delivery_issue_report_idempotency
  ADD CONSTRAINT delivery_issue_report_idempotency_action_check
    CHECK (action IN ('create', 'claim', 'acknowledge', 'close'));
