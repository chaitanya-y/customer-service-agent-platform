-- Earlier schema reserved QUEUED/HUMAN modes but recorded no session or assignee.
-- Do not invent ownership or silently return existing human work to AI.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM conversation.conversations WHERE control_mode IN ('QUEUED', 'HUMAN')) THEN
    RAISE EXCEPTION 'Existing non-AI conversations require explicit handoff reconciliation before migration 004';
  END IF;
END;
$$;

ALTER TABLE conversation.conversations
  ADD COLUMN control_version bigint NOT NULL DEFAULT 1 CHECK (control_version >= 1),
  ADD COLUMN handoff_session_id uuid,
  ADD COLUMN assigned_staff_id text,
  ADD COLUMN queued_at timestamptz,
  ADD CONSTRAINT coherent_handoff_control CHECK (
    (control_mode = 'AI' AND handoff_session_id IS NULL AND assigned_staff_id IS NULL AND queued_at IS NULL)
    OR (control_mode = 'QUEUED' AND handoff_session_id IS NOT NULL AND assigned_staff_id IS NULL AND queued_at IS NOT NULL)
    OR (control_mode = 'HUMAN' AND handoff_session_id IS NOT NULL AND assigned_staff_id IS NOT NULL AND queued_at IS NOT NULL)
  );

ALTER TABLE conversation.messages ADD COLUMN handoff_session_id uuid;

CREATE TABLE conversation.refund_start_reservations (
  tenant_id text NOT NULL,
  environment_id text NOT NULL,
  conversation_id uuid NOT NULL,
  workflow_id text NOT NULL,
  assistant_message_id uuid NOT NULL,
  accepted_control_version bigint NOT NULL CHECK (accepted_control_version >= 1),
  status text NOT NULL CHECK (status IN ('PENDING', 'STARTED', 'ABORTED')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, conversation_id, workflow_id),
  UNIQUE (tenant_id, environment_id, assistant_message_id),
  FOREIGN KEY (tenant_id, environment_id, conversation_id)
    REFERENCES conversation.conversations (tenant_id, environment_id, conversation_id),
  FOREIGN KEY (tenant_id, environment_id, assistant_message_id)
    REFERENCES conversation.messages (tenant_id, environment_id, message_id)
);
ALTER TABLE conversation.refund_start_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation.refund_start_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_environment_scope ON conversation.refund_start_reservations
USING (tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id())
WITH CHECK (tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id());

CREATE INDEX open_handoff_queue ON conversation.conversations
  (tenant_id, environment_id, queued_at, conversation_id) WHERE status = 'OPEN' AND control_mode IN ('QUEUED', 'HUMAN');
