// In-memory only: an epoch invalidates pending work without storing identity or
// customer data. Pagehide is a separate visibility lifecycle, not auth loss.
let epoch = 0;
let notifying = false;
const listeners = new Set<() => void>();

export function customerSessionEpoch(): number {
  return epoch;
}

export function notifyCustomerAuthLost(expectedEpoch = epoch): void {
  if (expectedEpoch !== epoch || notifying) return;
  epoch += 1;
  notifying = true;
  try {
    for (const listener of [...listeners]) listener();
  } finally {
    notifying = false;
  }
}

export function subscribeCustomerAuthLost(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
