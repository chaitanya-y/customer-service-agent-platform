import type { DeliveryIssueReport } from "./delivery-issue-api";

export type DeliveryIssueRefreshState = Readonly<{
  reportId?: string;
  report?: DeliveryIssueReport;
  statusError?: string;
  isRefreshing: boolean;
}>;

type ReportStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createDeliveryIssueRefreshController(options: Readonly<{
  load: (reportId: string) => Promise<DeliveryIssueReport>;
  storage: ReportStorage;
  storageKey: string;
  onChange: (state: DeliveryIssueRefreshState) => void;
  onAuthenticationLost?: () => void;
}>) {
  let state: DeliveryIssueRefreshState = { isRefreshing: false };
  let requestVersion = 0;
  let disposed = false;

  function update(next: DeliveryIssueRefreshState) {
    if (disposed) return;
    state = next;
    options.onChange(state);
  }

  return {
    clear() {
      requestVersion += 1;
      options.storage.removeItem(options.storageKey);
      update({ isRefreshing: false });
    },
    restore() {
      const reportId = options.storage.getItem(options.storageKey);
      if (reportId) update({ ...state, reportId });
    },
    confirm(report: DeliveryIssueReport) {
      requestVersion += 1;
      options.storage.setItem(options.storageKey, report.reportId);
      update({ reportId: report.reportId, report, isRefreshing: false });
    },
    async refresh() {
      const reportId = state.reportId;
      if (!reportId || disposed) return;
      const version = ++requestVersion;
      update({ ...state, isRefreshing: true });
      try {
        const report = await options.load(reportId);
        if (disposed || version !== requestVersion) return;
        update({ reportId, report, isRefreshing: false });
      } catch (error) {
        if (disposed || version !== requestVersion) return;
        const message = error instanceof Error ? error.message : "We could not refresh this report. Please try again.";
        if (error instanceof Error && "status" in error && (error.status === 401 || error.status === 403 || error.status === 404)) {
          options.storage.removeItem(options.storageKey);
          update({ statusError: message, isRefreshing: false });
          if (error.status === 401 || error.status === 403) options.onAuthenticationLost?.();
        } else {
          update({ ...state, statusError: message, isRefreshing: false });
        }
      }
    },
    dispose() {
      disposed = true;
      requestVersion += 1;
    },
  };
}

export async function showDeliveryIssueHistoryReport(
  controller: Pick<ReturnType<typeof createDeliveryIssueRefreshController>, "confirm" | "refresh">,
  report: DeliveryIssueReport,
): Promise<void> {
  controller.confirm(report);
  await controller.refresh();
}
