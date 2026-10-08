import { deliveryIssueStatusMessage, type DeliveryIssueReport } from "./delivery-issue-api";
import type { DeliveryIssueHistoryState } from "./delivery-issue-history-controller";
import styles from "./delivery-issue-form.module.css";

export function DeliveryIssueHistoryPanel({ state, onView, onSelect }: Readonly<{
  state: DeliveryIssueHistoryState;
  onView: () => void;
  onSelect: (report: DeliveryIssueReport) => void;
}>) {
  return (
    <section aria-labelledby="delivery-issue-history-heading" className={styles.historyPanel}>
      <h3 id="delivery-issue-history-heading">Your delivery reports</h3>
      <p>View up to ten recent reports for this account. Select one to check its current status.</p>
      <button className="cso-primary-button" disabled={state.isLoading} onClick={onView} type="button">
        {state.isLoading ? "Loading delivery reports…" : state.error ? "Try again" : "View my delivery reports"}
      </button>
      {state.error ? <p className={styles.error} role="alert">{state.error}</p> : null}
      {state.reports?.length === 0 ? <p role="status">No delivery reports were found for this account.</p> : null}
      {state.reports && state.reports.length > 0 ? (
        <ul className={styles.historyList}>
          {state.reports.map((report) => (
            <li key={report.reportId}>
              <button aria-label={`View report ${report.reportId}`} onClick={() => onSelect(report)} type="button">
                <span>{report.orderReference} · {report.category.toLowerCase()} delivery issue</span>
                <span>{deliveryIssueStatusMessage(report.status)}</span>
              </button>
              {report.status === "REVIEW_CLOSED" ? <a href="/support">Contact support</a> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {state.hasMore ? <p>More reports exist. This view shows only the ten most recently updated.</p> : null}
    </section>
  );
}
