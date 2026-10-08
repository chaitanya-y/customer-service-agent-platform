"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { createCustomerConversation, loadCustomerConversation } from "./conversation-api";
import { customerSessionEpoch, notifyCustomerAuthLost, subscribeCustomerAuthLost } from "./customer-session-state";
import {
  createDeliveryIssueReport,
  deliveryIssueStatusMessage,
  loadDeliveryIssueReport,
  loadDeliveryIssueHistory,
  nextDeliveryIssueAttempt,
  normalizeOrderReference,
  parseDeliveryIssueAttempt,
  recoverDeliveryIssueReport,
  type DeliveryIssueAttempt,
  type DeliveryIssueCategory,
  type DeliveryIssueReport,
} from "./delivery-issue-api";
import { createDeliveryIssueHistoryController, type DeliveryIssueHistoryState } from "./delivery-issue-history-controller";
import { DeliveryIssueHistoryPanel } from "./delivery-issue-history";
import { createDeliveryIssueRefreshController, showDeliveryIssueHistoryReport, type DeliveryIssueRefreshState } from "./delivery-issue-refresh";
import styles from "./delivery-issue-form.module.css";

const PENDING_ATTEMPT_KEY = "cso.delivery-issue.pending-attempt";
const REPORT_ID_KEY = "cso.delivery-issue.report-id";
const STATUS_POLL_INTERVAL_MS = 15_000;

const categories: ReadonlyArray<Readonly<{ value: DeliveryIssueCategory; label: string }>> = [
  { value: "MISSING", label: "Delivery is missing" },
  { value: "WRONG", label: "Wrong item arrived" },
  { value: "DAMAGED", label: "Item arrived damaged" },
  { value: "DELAYED", label: "Delivery is delayed" },
];

export function DeliveryIssueForm() {
  const [orderReference, setOrderReference] = useState("");
  const [category, setCategory] = useState<DeliveryIssueCategory | "">("");
  const [refreshState, setRefreshState] = useState<DeliveryIssueRefreshState>({ isRefreshing: false });
  const [historyState, setHistoryState] = useState<DeliveryIssueHistoryState>({ isLoading: false });
  const [submitError, setSubmitError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const pendingAttempt = useRef<DeliveryIssueAttempt | undefined>(undefined);
  const submissionVersion = useRef(0);
  const refreshController = useRef<ReturnType<typeof createDeliveryIssueRefreshController> | null>(null);
  const historyController = useRef<ReturnType<typeof createDeliveryIssueHistoryController> | null>(null);
  const { reportId, report, statusError, isRefreshing } = refreshState;

  function clearSensitiveState(options: Readonly<{ preserveAttempt?: boolean }> = {}) {
    submissionVersion.current += 1;
    if (!options.preserveAttempt) window.sessionStorage.removeItem(PENDING_ATTEMPT_KEY);
    window.sessionStorage.removeItem(REPORT_ID_KEY);
    pendingAttempt.current = undefined;
    refreshController.current?.clear();
    historyController.current?.clear();
    setOrderReference("");
    setCategory("");
    setSubmitError(undefined);
    setIsSubmitting(false);
  }

  useEffect(() => {
    const unsubscribe = subscribeCustomerAuthLost(() => clearSensitiveState());
    return () => {
      unsubscribe();
      submissionVersion.current += 1;
    };
  }, []);

  useEffect(() => {
    const controller = createDeliveryIssueRefreshController({
      load: loadDeliveryIssueReport,
      storage: window.sessionStorage,
      storageKey: REPORT_ID_KEY,
      onChange: setRefreshState,
      onAuthenticationLost: notifyCustomerAuthLost,
    });
    refreshController.current = controller;
    const storedAttempt = parseDeliveryIssueAttempt(window.sessionStorage.getItem(PENDING_ATTEMPT_KEY));
    if (storedAttempt) {
      pendingAttempt.current = storedAttempt;
      setOrderReference(storedAttempt.orderReference);
      setCategory(storedAttempt.category);
    } else {
      window.sessionStorage.removeItem(PENDING_ATTEMPT_KEY);
    }
    controller.restore();
    return () => {
      controller.dispose();
      if (refreshController.current === controller) refreshController.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = createDeliveryIssueHistoryController({
      load: loadDeliveryIssueHistory,
      onChange: setHistoryState,
      onAuthenticationLost: notifyCustomerAuthLost,
    });
    historyController.current = controller;
    return () => {
      controller.dispose();
      if (historyController.current === controller) historyController.current = null;
    };
  }, []);

  useEffect(() => {
    if (!reportId) return;
    const controller = refreshController.current;
    if (!controller) return;
    void controller.refresh();
    const interval = window.setInterval(() => { void controller.refresh(); }, STATUS_POLL_INTERVAL_MS);
    return () => { window.clearInterval(interval); };
  }, [reportId]);

  useEffect(() => {
    const onPageHide = () => clearSensitiveState({ preserveAttempt: true });
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      const storedAttempt = parseDeliveryIssueAttempt(window.sessionStorage.getItem(PENDING_ATTEMPT_KEY));
      if (!storedAttempt) return;
      pendingAttempt.current = storedAttempt;
      setOrderReference(storedAttempt.orderReference);
      setCategory(storedAttempt.category);
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedReference = normalizeOrderReference(orderReference);
    if (!normalizedReference || !category) {
      setSubmitError("Enter a valid order reference and choose one delivery issue.");
      return;
    }

    const previousAttempt = pendingAttempt.current;
    const version = ++submissionVersion.current;
    const epoch = customerSessionEpoch();
    const isCurrent = () => version === submissionVersion.current && epoch === customerSessionEpoch();
    let attempt = nextDeliveryIssueAttempt(previousAttempt, normalizedReference, category);
    const isRetry = Boolean(previousAttempt?.conversationId && previousAttempt === attempt);
    pendingAttempt.current = attempt;
    window.sessionStorage.setItem(PENDING_ATTEMPT_KEY, JSON.stringify(attempt));
    setSubmitError(undefined);
    setIsSubmitting(true);
    try {
      if (!attempt.conversationId) {
        const conversation = await createCustomerConversation(attempt.conversationCreateKey);
        if (!isCurrent()) return;
        attempt = { ...attempt, conversationId: conversation.conversationId };
        pendingAttempt.current = attempt;
        window.sessionStorage.setItem(PENDING_ATTEMPT_KEY, JSON.stringify(attempt));
      }

      const confirmed = isRetry
        ? await recoverDeliveryIssueReport({ ...attempt, conversationId: attempt.conversationId! }, loadCustomerConversation)
        : await createDeliveryIssueReport({
            conversationId: attempt.conversationId!,
            orderReference: attempt.orderReference,
            category: attempt.category,
            idempotencyKey: attempt.reportKey,
          });
      if (!isCurrent()) return;
      refreshController.current?.confirm(confirmed);
      window.sessionStorage.removeItem(PENDING_ATTEMPT_KEY);
      pendingAttempt.current = undefined;
      setOrderReference("");
      setCategory("");
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof Error && "status" in error && (error.status === 401 || error.status === 403)) notifyCustomerAuthLost(epoch);
      setSubmitError(error instanceof Error ? error.message : "We could not confirm receipt. Please retry this report.");
    } finally {
      if (isCurrent()) setIsSubmitting(false);
    }
  }

  function selectHistoryReport(selected: DeliveryIssueReport) {
    const controller = refreshController.current;
    if (controller) void showDeliveryIssueHistoryReport(controller, selected);
  }

  return (
    <section aria-labelledby="delivery-issue-heading" className={styles.panel}>
      <div className={styles.intro}>
        <span className="cso-eyebrow">Delivery issue report</span>
        <h2 id="delivery-issue-heading">Report a delivery issue</h2>
        <p>Submit the order reference and one issue type. A specialist can acknowledge your report; this does not mean the issue has been resolved.</p>
      </div>

      <form className={styles.form} noValidate onSubmit={submit}>
        <label htmlFor="delivery-order-reference">Order reference</label>
        <input
          autoComplete="off"
          disabled={isSubmitting}
          id="delivery-order-reference"
          maxLength={100}
          onChange={(event) => { setOrderReference(event.target.value); setSubmitError(undefined); }}
          placeholder="For example, ORDER1234"
          required
          type="text"
          value={orderReference}
        />
        <label htmlFor="delivery-issue-category">What happened?</label>
        <select
          disabled={isSubmitting}
          id="delivery-issue-category"
          onChange={(event) => { setCategory(event.target.value as DeliveryIssueCategory | ""); setSubmitError(undefined); }}
          required
          value={category}
        >
          <option value="">Choose a delivery issue</option>
          {categories.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {submitError ? <p className={styles.error} role="alert">{submitError}</p> : null}
        <button className="cso-primary-button" disabled={isSubmitting} type="submit">
          {isSubmitting ? "Submitting…" : pendingAttempt.current ? "Retry delivery issue report" : "Submit delivery issue report"}
        </button>
      </form>

      {!reportId && statusError ? <p className={styles.error} role="alert">{statusError}</p> : null}

      <DeliveryIssueHistoryPanel
        state={historyState}
        onView={() => { void historyController.current?.load(); }}
        onSelect={selectHistoryReport}
      />

      {reportId ? (
        <aside aria-labelledby="delivery-report-status-heading" className={styles.statusCard}>
          <h3 id="delivery-report-status-heading">Your delivery issue report</h3>
          {report ? (
            <div role="status">
              <p className={styles.statusMessage}>{deliveryIssueStatusMessage(report.status)}</p>
              <p className={styles.reportDetail}>Order {report.orderReference} · Report {report.reportId}</p>
              {report.status === "REVIEW_CLOSED" ? <a href="/support">Contact support</a> : null}
            </div>
          ) : <p role="status">Checking your report status…</p>}
          {statusError ? <p className={styles.error} role="alert">{statusError}</p> : null}
          {isRefreshing ? <span className={styles.refreshNote}>Refreshing status…</span> : null}
        </aside>
      ) : null}
    </section>
  );
}
