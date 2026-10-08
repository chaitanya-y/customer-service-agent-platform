export type EvidenceConfig = Readonly<{ storageDirectory: string; contextSecret: string }>;

// Delivery-report assertions use the context secret even when photo evidence
// storage is disabled. A secret alone must not turn on photo storage.
export function resolveEvidenceConfig(
  storageDirectory: string | undefined,
  contextSecret: string | undefined,
): EvidenceConfig | undefined {
  if (!storageDirectory) return undefined;
  if (!contextSecret || Buffer.byteLength(contextSecret) < 32) {
    throw new Error('INVALID_EVIDENCE_CONFIG');
  }
  return { storageDirectory, contextSecret };
}
