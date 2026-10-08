/** A bfcache restore revives mounted state; reload to recheck staff auth and data. */
export function watchStaffBfcacheRestore(browserWindow: Window): () => void {
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) browserWindow.location.reload();
  };
  browserWindow.addEventListener("pageshow", onPageShow);
  return () => browserWindow.removeEventListener("pageshow", onPageShow);
}

export function isStaffAuthorizationLoss(cause: unknown): boolean {
  if (!cause || typeof cause !== "object" || !("status" in cause)) return false;
  return cause.status === 401 || cause.status === 403;
}

export function isCurrentStaffSession(stopped: boolean, currentGeneration: number, requestGeneration: number): boolean {
  return !stopped && currentGeneration === requestGeneration;
}
