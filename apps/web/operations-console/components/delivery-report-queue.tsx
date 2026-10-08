"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { clearDeliveryTransitionStorage } from "./delivery-report-detail-state";

import { formatDeliveryDate, normalizeDeliveryReportList, type DeliveryReport, type DeliveryReportStatus } from "./delivery-report";
import { getConsoleData } from "./operations-api";
import { isStaffAuthorizationLoss, watchStaffBfcacheRestore } from "./staff-page-lifecycle";
import styles from "./operations-console.module.css";

const filters: DeliveryReportStatus[] = ["RECEIVED", "CLAIMED", "ACKNOWLEDGED", "REVIEW_CLOSED"];

export function DeliveryReportQueue() {
  const [status, setStatus] = useState<DeliveryReportStatus>("RECEIVED");
  const [assignee, setAssignee] = useState<"all" | "me" | "unassigned">("all");
  const [reports, setReports] = useState<DeliveryReport[] | undefined>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let mounted = true;
    setReports(undefined); setError(undefined);
    const hide = () => { mounted = false; setReports(undefined); setError(undefined); };
    window.addEventListener("pagehide", hide);
    const stopWatchingRestore = watchStaffBfcacheRestore(window);
    const query = new URLSearchParams({ status, limit: "100" });
    if (assignee !== "all") query.set("assignee", assignee);
    void getConsoleData(`/api/delivery-issue-reports?${query}`)
      .then((body) => { if (mounted) setReports(normalizeDeliveryReportList(body)); })
      .catch((cause: unknown) => {
        if (!mounted) return;
        if (isStaffAuthorizationLoss(cause)) {
          try { clearDeliveryTransitionStorage(window.sessionStorage); } catch { /* Still hide private rows. */ }
          mounted = false; setReports(undefined);
        }
        setError(cause instanceof Error ? cause.message : "Unable to load delivery reports.");
      });
    return () => { mounted = false; window.removeEventListener("pagehide", hide); stopWatchingRestore(); };
  }, [status, assignee]);

  return <section className={styles.queue} aria-labelledby="delivery-queue-heading">
    <div className={styles.queueHeader}>
      <div><span className="cso-eyebrow">Delivery Operations</span><h1 id="delivery-queue-heading">Delivery issue reports</h1>
        <p>Track customer-submitted delivery concerns. Acknowledgment confirms review, not a remedy or resolution.</p></div>
      <div className={styles.filters} aria-label="Report status">
        {filters.map((filter) => <button key={filter} type="button" aria-pressed={status === filter}
          className={status === filter ? styles.selectedFilter : styles.filter} onClick={() => setStatus(filter)}>{filter}</button>)}
      </div>
    </div>
    <div className={styles.filters} aria-label="Report assignment">
      {(["all", "unassigned", "me"] as const).map((filter) => <button key={filter} type="button" aria-pressed={assignee === filter}
        className={assignee === filter ? styles.selectedFilter : styles.filter} onClick={() => setAssignee(filter)}>
        {filter === "all" ? "All" : filter === "me" ? "Assigned to me" : "Unassigned"}</button>)}
    </div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {reports === undefined && !error ? <p className={styles.loading}>Loading delivery reports…</p> : null}
    {reports?.length === 0 ? <section className={styles.emptyState}><h2>No {status.toLowerCase()} reports</h2><p>Reports appear here after a customer submits one for an owned order.</p></section> : null}
    {reports?.length ? <div className={styles.caseList}>{reports.map((report) => <Link className={styles.caseRow} key={report.reportId} href={`/delivery-issue-reports/${encodeURIComponent(report.reportId)}`}>
      <div><span className={styles.caseType}>{report.category} delivery issue</span><strong>{report.orderReference}</strong>
        <span className={styles.muted}>Report {report.reportId}</span></div>
      <div className={styles.caseMeta}><span className={`${styles.status} ${styles[`status${report.status}`]}`}>{report.status}</span>
        <span>{report.assignedStaffId ?? "Unassigned"}</span><span>{formatDeliveryDate(report.updatedAt)}</span></div>
    </Link>)}</div> : null}
  </section>;
}
