ALTER TABLE cancellation.executions
  ADD COLUMN payment_id text;

ALTER TABLE cancellation.executions
  ADD CONSTRAINT cancellation_payment_matches_policy
  CHECK (
    (policy_version = 'NO_PAYMENT_ZERO_TOTAL_V1' AND payment_id IS NULL)
    OR (policy_version = 'AUTHORIZED_DUMMY_V1' AND payment_id IS NOT NULL AND length(payment_id) > 0)
  );
