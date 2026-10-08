"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import {
  getCancellationStatus,
  CancellationApiError,
  sendCancellationDecision,
  type CancellationState,
} from "./cancellation-api";
import { customerSessionEpoch, notifyCustomerAuthLost, subscribeCustomerAuthLost } from "./customer-session-state";
import styles from "./cancellation-journey.module.css";

function dateLabel(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function CancellationReviewView({ state, busy, decisionSubmitted, error, onDecision, onRefresh }: Readonly<{
  state: CancellationState;
  busy: boolean;
  decisionSubmitted: boolean;
  error?: string;
  onDecision: (accepted: boolean) => void;
  onRefresh: () => void;
}>) {
  const preview = state.preview;
  return (
    <section aria-live="polite" className={styles.panel}>
      <span className="cso-eyebrow">Order cancellation</span>
      <h1>{state.title}</h1>
      <p className={styles.detail}>{state.detail}</p>

      {preview ? <div className={styles.preview}>
        <h2>Order to review</h2>
        <dl className={styles.facts}>
          <div><dt>Order reference</dt><dd>{preview.order_reference}</dd></div>
          <div><dt>Placed</dt><dd>{dateLabel(preview.placed_at)}</dd></div>
          <div><dt>Total</dt><dd>{new Intl.NumberFormat("en-US", { style: "currency", currency: preview.total.currency }).format(0)}</dd></div>
          <div><dt>Review by</dt><dd>{dateLabel(preview.valid_until)}</dd></div>
        </dl>
        <h3>Items in this order</h3>
        <ul className={styles.lines}>
          {preview.lines.map((line) => <li key={line.item_id}><span>{line.display_name ?? `Item ID ${line.item_id}`}</span><span>Quantity {line.quantity}</span></li>)}
        </ul>
        <p className={styles.warning}>This is a zero-total order. Confirming requests cancellation of the whole order; it does not issue a refund or release a payment authorization.</p>
        {state.canDecide && !decisionSubmitted ? <div className={styles.actions}>
          <button className={styles.secondaryButton} disabled={busy} onClick={() => onDecision(false)} type="button">Decline</button>
          <button className="cso-primary-button" disabled={busy} onClick={() => onDecision(true)} type="button">
            {busy ? "Sending decision…" : "Confirm cancellation"}
          </button>
        </div> : null}
        {decisionSubmitted && state.canDecide ? <p className={styles.receipt} role="status">Decision received. Checking the order outcome…</p> : null}
      </div> : null}

      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {!state.isTerminal ? <p className={styles.polling}>We check for updates automatically while this page is open.</p> : null}
      <div className={styles.footer}>
        <button className={styles.secondaryButton} onClick={onRefresh} type="button">Refresh status</button>
        <a href="/support">Back to support</a>
      </div>
    </section>
  );
}

export function CancellationJourney({ workflowId }: Readonly<{ workflowId: string }>) {
  const [state, setState] = useState<CancellationState>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [decisionSubmitted, setDecisionSubmitted] = useState(false);
  const loadInFlight = useRef(false);
  const decisionInFlight = useRef(false);
  const generation = useRef(0);
  const hidden = useRef(false);
  const authLost = useRef(false);

  const clearPrivateState = useCallback(() => {
    generation.current += 1;
    loadInFlight.current = false;
    decisionInFlight.current = false;
    setState(undefined);
    setError(undefined);
    setBusy(false);
    setDecisionSubmitted(false);
    setLoading(false);
  }, []);

  const handleAuthLoss = useCallback(() => {
    authLost.current = true;
    clearPrivateState();
    setError("Please sign in again to view your cancellation review.");
  }, [clearPrivateState]);

  const refresh = useCallback(async () => {
    if (loadInFlight.current || hidden.current) return;
    const requestGeneration = generation.current;
    const sessionEpoch = customerSessionEpoch();
    const current = () => generation.current === requestGeneration && customerSessionEpoch() === sessionEpoch;
    loadInFlight.current = true;
    try {
      const next = await getCancellationStatus(workflowId);
      if (!current()) return;
      authLost.current = false;
      setState(next);
      setError(undefined);
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof CancellationApiError && (cause.status === 401 || cause.status === 403)) {
        notifyCustomerAuthLost(sessionEpoch);
        return;
      }
      setError(cause instanceof Error ? cause.message : "We could not load your cancellation status.");
    } finally {
      if (current()) {
        setLoading(false);
        loadInFlight.current = false;
      }
    }
  }, [workflowId]);

  useEffect(() => {
    hidden.current = false;
    const unsubscribe = subscribeCustomerAuthLost(handleAuthLoss);
    const onHide = () => {
      hidden.current = true;
      flushSync(clearPrivateState);
    };
    const onShow = (event: PageTransitionEvent) => {
      hidden.current = false;
      if (event.persisted) void refresh();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
      hidden.current = true;
      generation.current += 1;
      loadInFlight.current = false;
      decisionInFlight.current = false;
    };
  }, [clearPrivateState, handleAuthLoss, refresh]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (state?.isTerminal) return;
    const timer = window.setInterval(() => {
      if (!authLost.current && document.visibilityState === "visible") void refresh();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [state?.isTerminal, refresh]);

  async function decide(accepted: boolean) {
    if (hidden.current || authLost.current || !state?.canDecide || !state.preview || busy || decisionSubmitted || decisionInFlight.current) return;
    const requestGeneration = generation.current;
    const sessionEpoch = customerSessionEpoch();
    const current = () => generation.current === requestGeneration && customerSessionEpoch() === sessionEpoch;
    decisionInFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await sendCancellationDecision(workflowId, state.preview.preview_id, accepted);
      if (!current()) return;
      setDecisionSubmitted(true);
      await refresh();
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof CancellationApiError && (cause.status === 401 || cause.status === 403)) {
        notifyCustomerAuthLost(sessionEpoch);
        return;
      }
      setError(cause instanceof Error ? cause.message : "We could not record your decision. Please try again.");
    } finally {
      if (current()) {
        setBusy(false);
        decisionInFlight.current = false;
      }
    }
  }

  if (loading && !state) return <p className={styles.loading}>Loading your cancellation review…</p>;
  if (!state) return <section className={styles.panel}>
    <h1>We could not load this cancellation review.</h1>
    {error ? <p role="alert">{error}</p> : null}
    <button className="cso-primary-button" onClick={() => void refresh()} type="button">Try again</button>
  </section>;
  return <CancellationReviewView state={state} busy={busy} decisionSubmitted={decisionSubmitted} error={error}
    onDecision={(accepted) => { void decide(accepted); }} onRefresh={() => { void refresh(); }} />;
}
