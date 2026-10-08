-- Preserve historical executions. If duplicates already exist, index creation
-- fails and requires an explicit operator reconciliation; never discard money
-- movement history automatically to make this migration pass.
CREATE UNIQUE INDEX refund_executions_workflow_preview_unique
  ON refund.executions (tenant_id, environment_id, workflow_id, preview_id);
