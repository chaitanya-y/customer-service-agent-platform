"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  clearDeliveryTransitionStorage, nextDeliveryTransitionAttempt, parseDeliveryTransitionAttempt, reconcileDeliveryDetail, transitionIsResolved,
  type DeliveryDetailSnapshot, type DeliveryTransitionAction, type DeliveryTransitionAttempt,
} from "./delivery-report-detail-state";
import { formatDeliveryDate, normalizeDeliveryReport, normalizeDeliveryReportDetail, type DeliveryAuditEvent, type DeliveryReport } from "./delivery-report";
import { getConsoleData, OperationsApiError, postConsoleData } from "./operations-api";
import { isCurrentStaffSession, isStaffAuthorizationLoss, watchStaffBfcacheRestore } from "./staff-page-lifecycle";
import styles from "./operations-console.module.css";

type ReportDetail = { report: DeliveryReport; auditEvents: DeliveryAuditEvent[] };

export function DeliveryReportDetail({ reportId }: Readonly<{ reportId: string }>) {
  const [report, setReport] = useState<DeliveryReport>();
  const [events, setEvents] = useState<DeliveryAuditEvent[]>([]);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const snapshot = useRef<DeliveryDetailSnapshot<ReportDetail> | undefined>(undefined);
  const sequence = useRef(0);
  const generation = useRef(0);
  const pending = useRef<DeliveryTransitionAttempt | undefined>(undefined);
  const submittingNow = useRef(false);
  const stopped = useRef(false);
  const currentReportId = useRef(reportId);
  currentReportId.current = reportId;
  const storageKey = `cso.delivery-report.transition:${reportId}`;

  const clearPrivateState = useCallback(() => {
    stopped.current = true;
    generation.current += 1;
    sequence.current += 1;
    snapshot.current = undefined;
    pending.current = undefined;
    submittingNow.current = false;
    setReport(undefined);
    setEvents([]);
    setSubmitting(false);
  }, []);

  const readPending = useCallback(() => {
    if (pending.current?.reportId === reportId) return pending.current;
    try {
      pending.current = parseDeliveryTransitionAttempt(window.sessionStorage.getItem(storageKey), reportId);
    } catch { pending.current = undefined; }
    return pending.current;
  }, [reportId, storageKey]);

  const clearPending = useCallback(() => {
    pending.current = undefined;
    try { window.sessionStorage.removeItem(storageKey); } catch { /* In-memory retries remain possible. */ }
  }, [storageKey]);

  const applyDetail = useCallback((detail: ReportDetail, requestSequence: number) => {
    if (stopped.current) return;
    if (detail.report.reportId !== currentReportId.current) return;
    const next = reconcileDeliveryDetail(snapshot.current, detail, requestSequence);
    if (next === snapshot.current) return;
    snapshot.current = next;
    setReport(next.detail.report);
    setEvents(next.detail.auditEvents);
    setError(undefined);
    const attempt = readPending();
    if (attempt && transitionIsResolved(attempt, next.detail.report)) clearPending();
  }, [clearPending, readPending]);

  const refresh = useCallback(async () => {
    if (stopped.current) return;
    const requestGeneration = generation.current;
    const requestSequence = ++sequence.current;
    try {
      const detail = normalizeDeliveryReportDetail(await getConsoleData(`/api/delivery-issue-reports/${encodeURIComponent(reportId)}`));
      if (!isCurrentStaffSession(stopped.current, generation.current, requestGeneration)) return;
      applyDetail(detail, requestSequence);
    } catch (cause) {
      if (!isCurrentStaffSession(stopped.current, generation.current, requestGeneration)) return;
      if (isStaffAuthorizationLoss(cause)) {
        try { clearDeliveryTransitionStorage(window.sessionStorage); } catch { /* Still hide private mounted state. */ }
      }
      if (isStaffAuthorizationLoss(cause) || (cause instanceof OperationsApiError && cause.status === 404)) clearPrivateState();
      if (requestSequence >= (snapshot.current?.sequence ?? 0)) throw cause;
    }
  }, [applyDetail, clearPrivateState, reportId]);

  useEffect(() => {
    generation.current += 1;
    stopped.current = false;
    void refresh().catch((cause: unknown) => {
      if (!snapshot.current) setError(cause instanceof Error ? cause.message : "Unable to load this delivery report.");
    });
    const hide = () => clearPrivateState();
    window.addEventListener("pagehide", hide);
    const stopWatchingRestore = watchStaffBfcacheRestore(window);
    return () => {
      stopped.current = true;
      generation.current += 1;
      sequence.current += 1;
      window.removeEventListener("pagehide", hide);
      stopWatchingRestore();
    };
  }, [clearPrivateState, refresh]);

  async function transition(action: DeliveryTransitionAction) {
    const requestGeneration = generation.current;
    const current = snapshot.current?.detail.report ?? report;
    if (!current || submittingNow.current || stopped.current ||
        (action === "claim" && current.status !== "RECEIVED") ||
        (action === "acknowledge" && current.status !== "CLAIMED") ||
        (action === "close" && (current.status !== "ACKNOWLEDGED" || !current.canCloseReview))) return;
    submittingNow.current = true;
    const attempt = nextDeliveryTransitionAttempt(readPending(), current, action, crypto.randomUUID());
    pending.current = attempt;
    try { window.sessionStorage.setItem(storageKey, JSON.stringify(attempt)); } catch { /* Keep the attempt for this mounted session. */ }
    setSubmitting(true); setError(undefined);
    try {
      const response = await postConsoleData(`/api/delivery-issue-reports/${encodeURIComponent(current.reportId)}/${action}`,
        { expected_version: attempt.expectedVersion }, attempt.idempotencyKey, "The delivery report could not be updated.");
      if (!isCurrentStaffSession(stopped.current, generation.current, requestGeneration)) return;
      if (!response || typeof response !== "object" || !("delivery_issue_report" in response)) throw new Error("Human Operations returned an invalid delivery report.");
      const updated = normalizeDeliveryReport(response.delivery_issue_report);
      applyDetail({ report: updated, auditEvents: snapshot.current?.detail.auditEvents ?? [] }, ++sequence.current);
      await refresh();
    } catch (cause) {
      if (!isCurrentStaffSession(stopped.current, generation.current, requestGeneration)) return;
      if (isStaffAuthorizationLoss(cause)) {
        try { clearDeliveryTransitionStorage(window.sessionStorage); } catch { /* Still hide private mounted state. */ }
      }
      if (isStaffAuthorizationLoss(cause) || (cause instanceof OperationsApiError && cause.status === 404)) clearPrivateState();
      else {
        if (cause instanceof OperationsApiError && cause.status >= 400 && cause.status < 500) clearPending();
        try { await refresh(); } catch { /* Retain the original command error and retry identity. */ }
      }
      if (!stopped.current && pending.current) {
        setError(cause instanceof Error ? cause.message : "The report could not be updated. Refresh and try again.");
      } else if (!stopped.current && snapshot.current?.detail.report.status !== "REVIEW_CLOSED") {
        setError(cause instanceof Error ? cause.message : "The report could not be updated. Refresh and try again.");
      }
    } finally {
      if (isCurrentStaffSession(stopped.current, generation.current, requestGeneration)) {
        submittingNow.current = false;
        setSubmitting(false);
      }
    }
  }

  return <section className={styles.detail}>
    <Link className={styles.backLink} href="/delivery-issue-reports">← Delivery reports</Link>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {!report && !error ? <p className={styles.loading}>Loading delivery report…</p> : null}
    {report ? <>
      <header className={styles.detailHeader}><div><span className="cso-eyebrow">{report.category} delivery issue</span>
        <h1>{report.orderReference}</h1><p>Report {report.reportId}</p></div>
        <span className={`${styles.status} ${styles[`status${report.status}`]}`}>{report.status}</span></header>
      <div className={styles.detailGrid}>
        <section className={styles.reviewPanel} aria-labelledby="delivery-report-heading">
          <span className="cso-eyebrow">Customer report</span><h2 id="delivery-report-heading">Report details</h2>
          <dl className={styles.definitionList}>
            <div><dt>Order</dt><dd>{report.orderReference}</dd></div><div><dt>Category</dt><dd>{report.category}</dd></div>
            <div><dt>Received</dt><dd>{formatDeliveryDate(report.createdAt)}</dd></div>
            <div><dt>Assigned to</dt><dd>{report.assignedStaffId ?? "Unassigned"}</dd></div>
            <div><dt>Report version</dt><dd>{report.version}</dd></div>
            {report.claimedAt ? <div><dt>Claimed</dt><dd>{formatDeliveryDate(report.claimedAt)}</dd></div> : null}
            {report.acknowledgedAt ? <div><dt>Acknowledged</dt><dd>{formatDeliveryDate(report.acknowledgedAt)}</dd></div> : null}
            {report.closedAt ? <div><dt>Review closed</dt><dd>{formatDeliveryDate(report.closedAt)}</dd></div> : null}
          </dl>
        </section>
        <aside className={styles.decisionPanel} aria-labelledby="delivery-action-heading">
          <span className="cso-eyebrow">Delivery follow-up</span><h2 id="delivery-action-heading">{report.status === "REVIEW_CLOSED" ? "Review closed" : report.status === "ACKNOWLEDGED" ? "Acknowledged" : "Next step"}</h2>
          <p>{report.status === "RECEIVED" ? "Claim this report to begin staff review." : report.status === "CLAIMED" ?
            "Only the assigned staff member can acknowledge this report. Acknowledgment does not confirm a resolution or remedy." :
            report.status === "ACKNOWLEDGED" ? "A staff member has acknowledged this report. Closing the review does not confirm the issue was fixed or a remedy was provided." :
            "A specialist completed the review. This does not confirm the delivery issue was fixed or a remedy was provided."}</p>
          {report.status === "RECEIVED" ? <button className="cso-primary-button" disabled={submitting} onClick={() => void transition("claim")} type="button">{submitting ? "Claiming…" : "Claim report"}</button> : null}
          {report.status === "CLAIMED" ? <button className="cso-primary-button" disabled={submitting} onClick={() => void transition("acknowledge")} type="button">{submitting ? "Acknowledging…" : "Acknowledge report"}</button> : null}
          {report.status === "ACKNOWLEDGED" && report.canCloseReview ? <button className="cso-primary-button" disabled={submitting} onClick={() => void transition("close")} type="button">{submitting ? "Closing review…" : "Close review"}</button> : null}
          <button className={styles.filter} disabled={submitting} onClick={() => void refresh().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Unable to refresh report."))} type="button">Refresh status</button>
        </aside>
      </div>
      <section className={styles.auditPanel} aria-labelledby="delivery-audit-heading"><h2 id="delivery-audit-heading">Audit trail</h2>
        {events.length ? <ol>{events.map((event) => <li key={event.eventId}><strong>{event.eventType.replaceAll("_", " ")}</strong>
          <span>{event.actorType === "HUMAN" ? "Staff" : "Customer"} {event.actorId} · {formatDeliveryDate(event.occurredAt)} · version {event.reportVersion}</span></li>)}</ol> : <p>No audit events are available yet.</p>}
      </section>
    </> : null}
  </section>;
}
