import type { DeliveryIssueHistory } from "./delivery-issue-api";

export type DeliveryIssueHistoryState = Readonly<{
  isLoading: boolean;
  reports?: DeliveryIssueHistory["reports"];
  hasMore?: boolean;
  error?: string;
}>;

export function createDeliveryIssueHistoryController(options: Readonly<{
  load: () => Promise<DeliveryIssueHistory>;
  onChange: (state: DeliveryIssueHistoryState) => void;
  onAuthenticationLost?: () => void;
}>) {
  let version = 0;
  let disposed = false;
  function update(state: DeliveryIssueHistoryState) {
    if (!disposed) options.onChange(state);
  }
  return {
    async load() {
      const current = ++version;
      update({ isLoading: true });
      try {
        const history = await options.load();
        if (disposed || current !== version) return;
        update({ isLoading: false, reports: history.reports, hasMore: history.hasMore });
      } catch (error) {
        if (disposed || current !== version) return;
        const message = error instanceof Error ? error.message : "We could not load your delivery reports. Please try again.";
        if (error instanceof Error && "status" in error && (error.status === 401 || error.status === 403)) {
          options.onAuthenticationLost?.();
        }
        update({ isLoading: false, error: message });
      }
    },
    clear() {
      version += 1;
      update({ isLoading: false });
    },
    dispose() {
      disposed = true;
      version += 1;
    },
  };
}
