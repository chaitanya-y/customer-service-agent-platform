-- The accepted assistant turn owns an immutable, encrypted Temporal start intent.
-- Existing reservations remain unreadable for automatic recovery and require
-- operator reconciliation; no default or backfill invents their proposal.
ALTER TABLE conversation.refund_start_reservations
  ADD COLUMN start_input_ciphertext bytea,
  ADD COLUMN start_input_iv bytea,
  ADD COLUMN start_input_tag bytea,
  ADD COLUMN start_input_key_version text,
  ADD COLUMN start_input_sha256 text,
  ADD COLUMN start_input_length integer,
  ADD CONSTRAINT refund_start_encryption_complete CHECK (
    (start_input_ciphertext IS NULL AND start_input_iv IS NULL AND start_input_tag IS NULL
      AND start_input_key_version IS NULL AND start_input_sha256 IS NULL AND start_input_length IS NULL)
    OR
    (start_input_ciphertext IS NOT NULL AND start_input_iv IS NOT NULL AND start_input_tag IS NOT NULL
      AND start_input_key_version IS NOT NULL AND start_input_sha256 IS NOT NULL AND start_input_length IS NOT NULL
      AND octet_length(start_input_iv) = 12 AND octet_length(start_input_tag) = 16
      AND start_input_sha256 ~ '^[0-9a-f]{64}$' AND start_input_length > 0)
  );
