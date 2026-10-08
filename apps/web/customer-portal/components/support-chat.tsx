"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import {
  MAX_CUSTOMER_MESSAGE_LENGTH,
  CustomerConversationApiError,
  createCustomerConversation,
  getCustomerHandoffStatus,
  isValidCustomerMessage,
  loadCustomerConversation,
  requestHumanHandoff,
  sendCustomerMessage,
  type CustomerChatMessage,
  type CustomerHandoff,
  type RefundWorkflowLink,
} from "./conversation-api";
import { startCancellationReview } from "./cancellation-api";
import { notifyCustomerAuthLost, subscribeCustomerAuthLost } from "./customer-session-state";
import styles from "./support-chat.module.css";
import {
  loadSavedAddressStatus,
  SavedAddressStatusApiError,
  type SavedAddressStatus,
} from "./saved-address-status-api";
import { loadRecentOrderReferences, RecentOrderReferencesApiError, type RecentOrderReferences } from "./recent-order-references-api";

const CONVERSATION_STORAGE_KEY = "cso.current-conversation-id";
const ORDER_REFERENCE_LIMIT = 100;

type PendingTurn = Readonly<{
  clientMessageId: string;
  conversationIdempotencyKey: string;
  idempotencyKey: string;
  orderReference?: string;
  text: string;
}>;

type PendingHandoff = Readonly<{
  conversationIdempotencyKey: string;
  idempotencyKey: string;
  expectedControlVersion?: number;
}>;

function formatMessageTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? undefined
    : new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
}

function mergeMessages(
  previous: readonly ChatMessage[],
  next: readonly ChatMessage[],
): ChatMessage[] {
  const messages = new Map(previous.map((message) => [message.messageId, message]));
  for (const message of next) messages.set(message.messageId, message);
  return [...messages.values()];
}

type ChatMessage = CustomerChatMessage & Readonly<{
  refundWorkflow?: RefundWorkflowLink;
}>;

export function CancellationReviewAction({ orderReference, loading, error, onReview }: Readonly<{
  orderReference: string;
  loading: boolean;
  error?: string;
  onReview: () => void;
}>) {
  return <aside className={styles.workflowCard}>
    <strong>Cancellation is ready to review</strong>
    <p>Review order {orderReference} and decide whether to request cancellation. The order is not cancelled yet.</p>
    <button className={styles.workflowButton} disabled={loading} onClick={onReview} type="button">
      {loading ? "Opening review…" : "Review cancellation"}
    </button>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
  </aside>;
}

export function SavedAddressStatusCard({ status, loading, error, onCheck, onConsult,
  consultationAvailable, consultationPending, consultationActive, consultationClosed }: Readonly<{
  status?: SavedAddressStatus;
  loading: boolean;
  error?: string;
  onCheck: () => void;
  onConsult?: () => void;
  consultationAvailable?: boolean;
  consultationPending?: boolean;
  consultationActive?: boolean;
  consultationClosed?: boolean;
}>) {
  return (
    <aside className={styles.addressStatus} aria-labelledby="saved-address-heading">
      <h2 id="saved-address-heading">Saved address status</h2>
      <p>Check your account’s saved address count and default settings. This does not confirm the shipping address on an order and does not change any address.</p>
      <button className="cso-primary-button" disabled={loading} onClick={onCheck} type="button">
        {loading ? "Checking saved addresses…" : "Check saved addresses"}
      </button>
      {status ? <div role="status" className={styles.addressSummary}>
        <p>Saved addresses: {status.savedAddressCount}</p>
        <p>Default shipping address: {status.hasDefaultShippingAddress ? "Set" : "Not set"}</p>
        <p>Default billing address: {status.hasDefaultBillingAddress ? "Set" : "Not set"}</p>
      </div> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {onConsult ? <>
        <p id="saved-address-consultation-boundary">Need help with your saved addresses? A specialist must verify your account before advising you. This consultation does not change any address.</p>
        {!consultationActive && !consultationClosed ? <button className={styles.handoffButton}
          aria-describedby="saved-address-consultation-boundary"
          disabled={!consultationAvailable || consultationPending}
          onClick={onConsult} type="button">
          {consultationPending ? "Requesting a specialist…" : "Talk to a person about saved addresses"}
        </button> : null}
        {!consultationAvailable && !consultationActive && !consultationClosed
          ? <p>Account consultation is currently unavailable. No consultation has been requested.</p> : null}
        {consultationActive ? <p>Describe your saved-address question in the conversation below. Do not share a full address or payment details in chat.</p> : null}
      </> : null}
    </aside>
  );
}

export function RecentOrderReferencesCard({ result, loading, error, onFind }: Readonly<{
  result?: RecentOrderReferences;
  loading: boolean;
  error?: string;
  onFind: () => void;
}>) {
  return <aside className={styles.addressStatus} aria-labelledby="recent-orders-heading" aria-busy={loading}>
    <h2 id="recent-orders-heading">Recent order references</h2>
    <p>Find up to ten of your latest placed orders. This read does not change an order.</p>
    <button className="cso-primary-button" disabled={loading} onClick={onFind} type="button">
      {loading ? "Finding your recent orders…" : error ? "Try again" : "Find my recent orders"}
    </button>
    {loading ? <p role="status">Finding your recent orders…</p> : null}
    {!loading && !error && result ? <div role="status" className={styles.addressSummary}>
      {result.orders.length === 0 ? <p>No recent placed orders were found.</p> : <>
        <ul>{result.orders.map(order => <li key={order.reference}>
          <strong>{order.reference}</strong> — Placed <time dateTime={order.placedAt}>
            {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(order.placedAt))}
          </time>
        </li>)}</ul>
        <p>Use a reference in the chat’s “Add an order reference if you have one” field, then ask about that order.</p>
      </>}
      {result.hasMore ? <p>More orders exist. Only your ten most recent placed orders are shown.</p> : null}
    </div> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
  </aside>;
}

export function SupportChat({ handoffAvailable }: Readonly<{ handoffAvailable: boolean }>) {
  const [conversationId, setConversationId] = useState<string>();
  const [control, setControl] = useState<CustomerHandoff>();
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [orderReference, setOrderReference] = useState("");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [clarification, setClarification] = useState<string>();
  const [isLoadingConversation, setIsLoadingConversation] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [isRequestingHandoff, setIsRequestingHandoff] = useState(false);
  const [cancellationReviewLoading, setCancellationReviewLoading] = useState(false);
  const [cancellationReviewError, setCancellationReviewError] = useState<Readonly<{ orderReference: string; message: string }>>();
  const cancellationReviewInFlight = useRef(false);
  const pendingTurn = useRef<PendingTurn | undefined>(undefined);
  const pendingHandoff = useRef<PendingHandoff | undefined>(undefined);
  const pollInFlight = useRef(false);
  const transcriptGeneration = useRef(0);
  const [addressStatus, setAddressStatus] = useState<SavedAddressStatus>();
  const [addressError, setAddressError] = useState<string>();
  const [isCheckingAddresses, setIsCheckingAddresses] = useState(false);
  const addressReadInFlight = useRef(false);
  const addressReadGeneration = useRef(0);
  const [recentOrders, setRecentOrders] = useState<RecentOrderReferences>();
  const [recentOrdersError, setRecentOrdersError] = useState<string>();
  const [isFindingOrders, setIsFindingOrders] = useState(false);
  const recentOrdersReadInFlight = useRef(false);
  const recentOrdersReadGeneration = useRef(0);

  const clearRecentOrders = useCallback(() => {
    recentOrdersReadGeneration.current += 1;
    setRecentOrders(undefined);
    setRecentOrdersError(undefined);
    setIsFindingOrders(false);
  }, []);

  useEffect(() => {
    window.addEventListener("pagehide", clearRecentOrders);
    return () => {
      window.removeEventListener("pagehide", clearRecentOrders);
      recentOrdersReadGeneration.current += 1;
    };
  }, [clearRecentOrders]);

  async function findRecentOrders() {
    if (recentOrdersReadInFlight.current) return;
    recentOrdersReadInFlight.current = true;
    const generation = recentOrdersReadGeneration.current;
    setRecentOrders(undefined);
    setRecentOrdersError(undefined);
    setIsFindingOrders(true);
    try {
      const result = await loadRecentOrderReferences();
      if (generation === recentOrdersReadGeneration.current) setRecentOrders(result);
    } catch (error) {
      if (generation === recentOrdersReadGeneration.current) {
        if (error instanceof RecentOrderReferencesApiError && [401, 403].includes(error.status)) clearAuthenticatedSupportState();
        setRecentOrdersError(error instanceof RecentOrderReferencesApiError ? error.message : "We could not find your recent orders. Please try again.");
      }
    } finally {
      recentOrdersReadInFlight.current = false;
      if (generation === recentOrdersReadGeneration.current) setIsFindingOrders(false);
    }
  }

  const clearAddressStatus = useCallback(() => {
    addressReadGeneration.current += 1;
    setAddressStatus(undefined);
    setAddressError(undefined);
    setIsCheckingAddresses(false);
  }, []);

  const clearConversation = useCallback(() => {
    transcriptGeneration.current += 1;
    window.sessionStorage.removeItem(CONVERSATION_STORAGE_KEY);
    setConversationId(undefined);
    setControl(undefined);
    setMessages([]);
    setIsLoadingConversation(false);
    pendingTurn.current = undefined;
    pendingHandoff.current = undefined;
    setDraft("");
    setOrderReference("");
    setClarification(undefined);
    setIsSending(false);
    setIsRequestingHandoff(false);
  }, []);

  const clearSensitiveSupportState = useCallback(() => {
    clearAddressStatus();
    clearRecentOrders();
    clearConversation();
    setErrorMessage(undefined);
    setCancellationReviewError(undefined);
    setCancellationReviewLoading(false);
  }, [clearAddressStatus, clearRecentOrders, clearConversation]);

  useEffect(() => {
    const unsubscribe = subscribeCustomerAuthLost(clearSensitiveSupportState);
    return () => {
      unsubscribe();
      transcriptGeneration.current += 1;
    };
  }, [clearSensitiveSupportState]);

  const clearAuthenticatedSupportState = useCallback(() => {
    notifyCustomerAuthLost();
  }, []);

  const hideConversationOnPageHide = useCallback(() => {
    transcriptGeneration.current += 1;
    setConversationId(undefined);
    setControl(undefined);
    setMessages([]);
    setDraft("");
    setOrderReference("");
    setClarification(undefined);
    setIsLoadingConversation(false);
    setIsSending(false);
    setIsRequestingHandoff(false);
    setCancellationReviewError(undefined);
    setCancellationReviewLoading(false);
    // Keep the conversation ID and uncertain request keys for an authoritative
    // reload or same-key retry when this tab is restored.
  }, []);

  useEffect(() => {
    window.addEventListener("pagehide", clearAddressStatus);
    return () => {
      window.removeEventListener("pagehide", clearAddressStatus);
      addressReadGeneration.current += 1;
    };
  }, [clearAddressStatus]);

  async function checkSavedAddresses() {
    if (addressReadInFlight.current) return;
    addressReadInFlight.current = true;
    const generation = addressReadGeneration.current;
    setAddressStatus(undefined);
    setAddressError(undefined);
    setIsCheckingAddresses(true);
    try {
      const result = await loadSavedAddressStatus();
      if (generation === addressReadGeneration.current) setAddressStatus(result);
    } catch (error) {
      if (generation === addressReadGeneration.current) {
        if (error instanceof SavedAddressStatusApiError && [401, 403].includes(error.status)) clearAuthenticatedSupportState();
        setAddressError(error instanceof Error ? error.message : "We could not check your saved addresses.");
      }
    } finally {
      addressReadInFlight.current = false;
      if (generation === addressReadGeneration.current) setIsCheckingAddresses(false);
    }
  }

  async function reviewCancellation(orderReference: string) {
    if (cancellationReviewInFlight.current) return;
    const generation = transcriptGeneration.current;
    cancellationReviewInFlight.current = true;
    setCancellationReviewLoading(true);
    setCancellationReviewError(undefined);
    try {
      const route = await startCancellationReview(orderReference);
      if (generation !== transcriptGeneration.current) return;
      window.location.assign(route);
    } catch (error) {
      if (generation !== transcriptGeneration.current) return;
      if (error instanceof Error && "status" in error && (error.status === 401 || error.status === 403)) {
        clearAuthenticatedSupportState();
        setErrorMessage("Your session ended. Please sign in again to continue.");
        return;
      }
      setCancellationReviewError({ orderReference,
        message: error instanceof Error ? error.message : "We could not open the cancellation review. Please try again." });
    } finally {
      cancellationReviewInFlight.current = false;
      if (generation === transcriptGeneration.current) setCancellationReviewLoading(false);
    }
  }

  const loadConversation = useCallback(async (id: string) => {
    const generation = ++transcriptGeneration.current;
    setIsLoadingConversation(true);
    setErrorMessage(undefined);
    try {
      const conversation = await loadCustomerConversation(id);
      if (generation === transcriptGeneration.current) {
        setConversationId(conversation.conversationId);
        setControl(conversation);
        setMessages(conversation.messages);
      }
    } catch (error) {
      if (generation !== transcriptGeneration.current) return;
      if (error instanceof CustomerConversationApiError && [401, 403].includes(error.status)) {
        clearAuthenticatedSupportState();
      }
      if (error instanceof CustomerConversationApiError && error.status === 404) clearConversation();
      setErrorMessage(error instanceof Error ? error.message : "We could not load this conversation.");
    } finally {
      if (generation === transcriptGeneration.current) setIsLoadingConversation(false);
    }
  }, [clearAuthenticatedSupportState, clearConversation]);

  useEffect(() => {
    const storedConversationId = window.sessionStorage.getItem(CONVERSATION_STORAGE_KEY);
    if (!storedConversationId) {
      setIsLoadingConversation(false);
      return;
    }

    setConversationId(storedConversationId);
    void loadConversation(storedConversationId);
  }, [loadConversation]);

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      const storedConversationId = window.sessionStorage.getItem(CONVERSATION_STORAGE_KEY);
      if (storedConversationId) void loadConversation(storedConversationId);
    };
    window.addEventListener("pagehide", hideConversationOnPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", hideConversationOnPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [hideConversationOnPageHide, loadConversation]);

  useEffect(() => {
    if (!conversationId || (control?.controlMode !== "QUEUED" && control?.controlMode !== "HUMAN") ||
        control.status !== "OPEN") return;
    const timer = window.setInterval(async () => {
      if (pollInFlight.current || isSending || isRequestingHandoff || document.visibilityState === "hidden") return;
      pollInFlight.current = true;
      const generation = transcriptGeneration.current;
      try {
        const refreshed = await loadCustomerConversation(conversationId);
        if (generation === transcriptGeneration.current) {
          setControl(refreshed);
          setMessages(refreshed.messages);
        }
      } catch (error) {
        if (generation === transcriptGeneration.current && error instanceof CustomerConversationApiError && [401, 403].includes(error.status)) {
          clearAuthenticatedSupportState();
          setErrorMessage("Your session ended. Please sign in again to continue this conversation.");
        }
      } finally {
        pollInFlight.current = false;
      }
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [conversationId, control?.controlMode, control?.status, isSending, isRequestingHandoff, clearAuthenticatedSupportState]);

  async function requestSpecialist() {
    if (!handoffAvailable || isSending || isRequestingHandoff || isLoadingConversation || control?.status === "CLOSED" ||
        control?.controlMode === "QUEUED" || control?.controlMode === "HUMAN") return;
    const attempt = pendingHandoff.current ?? {
      conversationIdempotencyKey: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
    };
    pendingHandoff.current = attempt;
    const generation = ++transcriptGeneration.current;
    setIsRequestingHandoff(true);
    setErrorMessage(undefined);
    try {
      let currentConversationId = conversationId;
      let currentControl = control;
      if (!currentConversationId) {
        const created = await createCustomerConversation(attempt.conversationIdempotencyKey);
        if (generation !== transcriptGeneration.current) return;
        currentConversationId = created.conversationId;
        currentControl = created;
        window.sessionStorage.setItem(CONVERSATION_STORAGE_KEY, currentConversationId);
        setConversationId(currentConversationId);
        setControl(created);
      }
      const expectedControlVersion = attempt.expectedControlVersion ?? currentControl?.controlVersion ?? 1;
      pendingHandoff.current = { ...attempt, expectedControlVersion };
      const next = await requestHumanHandoff({
        conversationId: currentConversationId,
        expectedControlVersion,
        idempotencyKey: attempt.idempotencyKey,
      });
      if (generation !== transcriptGeneration.current) return;
      setControl(next);
      pendingHandoff.current = undefined;
      setClarification(undefined);
    } catch (error) {
      if (generation !== transcriptGeneration.current) return;
      if (error instanceof CustomerConversationApiError && [401, 403].includes(error.status)) {
        clearAuthenticatedSupportState();
      }
      if (error instanceof CustomerConversationApiError && error.status === 409 && conversationId) {
        pendingHandoff.current = undefined;
        setIsRequestingHandoff(false);
        await loadConversation(conversationId);
        return;
      }
      setErrorMessage(error instanceof Error ? error.message : "We could not request a specialist. Please try again.");
    } finally {
      if (generation === transcriptGeneration.current) setIsRequestingHandoff(false);
    }
  }

  function updateDraft(value: string) {
    setDraft(value);
    setErrorMessage(undefined);
    setClarification(undefined);
    if (pendingTurn.current?.text !== value.trim()) pendingTurn.current = undefined;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (control?.status === "CLOSED" || isRequestingHandoff) return;
    const text = draft.trim();
    const normalizedOrderReference = orderReference.trim();

    if (!isValidCustomerMessage(text)) {
      setErrorMessage(
        text
          ? `Please keep your message within ${MAX_CUSTOMER_MESSAGE_LENGTH.toLocaleString()} characters.`
          : "Describe what happened before sending your message.",
      );
      return;
    }

    const existingPendingTurn = pendingTurn.current;
    const canRetryPendingTurn = existingPendingTurn
      && existingPendingTurn.text === text
      && existingPendingTurn.orderReference === (normalizedOrderReference || undefined);
    const nextPendingTurn: PendingTurn = canRetryPendingTurn
      ? existingPendingTurn
      : {
        clientMessageId: crypto.randomUUID(),
        conversationIdempotencyKey: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        ...(normalizedOrderReference ? { orderReference: normalizedOrderReference } : {}),
        text,
      };

    pendingTurn.current = nextPendingTurn;
    const generation = ++transcriptGeneration.current;
    setErrorMessage(undefined);
    setClarification(undefined);
    setIsSending(true);

    try {
      let currentConversationId = conversationId;
      if (!currentConversationId) {
        const conversation = await createCustomerConversation(nextPendingTurn.conversationIdempotencyKey);
        if (generation !== transcriptGeneration.current) return;
        currentConversationId = conversation.conversationId;
        window.sessionStorage.setItem(CONVERSATION_STORAGE_KEY, currentConversationId);
        setConversationId(currentConversationId);
        setControl(conversation);
      }

      const turn = await sendCustomerMessage({
        clientMessageId: nextPendingTurn.clientMessageId,
        conversationId: currentConversationId,
        idempotencyKey: nextPendingTurn.idempotencyKey,
        ...(nextPendingTurn.orderReference ? { orderReference: nextPendingTurn.orderReference } : {}),
        text: nextPendingTurn.text,
      });
      if (generation !== transcriptGeneration.current) return;
      const customerMessage: CustomerChatMessage = {
        messageId: turn.customerMessageId,
        sender: "customer",
        text: nextPendingTurn.text,
      };
      const assistantMessage = turn.assistantMessage
        ? {
          ...turn.assistantMessage,
              ...(turn.refundWorkflow ? { refundWorkflow: turn.refundWorkflow } : {}),
              ...(turn.cancellationRequest ? { cancellationRequest: turn.cancellationRequest } : {}),
        }
        : undefined;
      setMessages((previous) => mergeMessages(
        previous,
        [customerMessage, ...(assistantMessage ? [assistantMessage] : [])],
      ));
      if (turn.controlMode && turn.controlVersion) {
        setControl((previous) => previous ? {
          ...previous, controlMode: turn.controlMode!, controlVersion: turn.controlVersion!,
        } : previous);
      }
      setDraft("");
      setOrderReference("");
      pendingTurn.current = undefined;

      if (!turn.assistantMessage) {
        setClarification(turn.controlMode === "QUEUED" || turn.controlMode === "HUMAN"
          ? "Your message was sent. A support specialist will reply here."
          : turn.refundWorkflow
          ? "Your refund request is ready to review."
          : "We need a little more information before we can continue. Please add any details you can.");
      }
    } catch (error) {
      if (generation !== transcriptGeneration.current) return;
      if (error instanceof CustomerConversationApiError && [401, 403].includes(error.status)) {
        clearAuthenticatedSupportState();
      }
      setErrorMessage(error instanceof Error ? error.message : "We could not send your message. Please try again.");
    } finally {
      if (generation === transcriptGeneration.current) setIsSending(false);
    }
  }

  const handoffStatus = control ? getCustomerHandoffStatus(control.status, control.controlMode) : undefined;

  return (
    <section className={styles.chatPanel} aria-labelledby="support-heading">
      <header className={styles.chatHeader}>
        <span className="cso-eyebrow">Support conversation</span>
        <h1 id="support-heading">How can we help?</h1>
        <p>Ask about an order, delivery, product policy, or refund. If you request a refund, we will show the exact amount before anything is submitted.</p>
        <div className={styles.handoffControls}>
          {handoffStatus ? <p className={styles.handoffStatus} role="status"><strong>{handoffStatus.label}</strong><span>{handoffStatus.detail}</span></p> : null}
          {handoffAvailable && (!control || (control.status === "OPEN" && control.controlMode === "AI")) ? (
            <button className={styles.handoffButton} disabled={isLoadingConversation || isSending || isRequestingHandoff}
              onClick={() => { void requestSpecialist(); }} type="button">
              {isRequestingHandoff ? "Requesting a specialist…" : "Talk to a person"}
            </button>
          ) : null}
        </div>
      </header>

      <aside className={styles.consultation} aria-labelledby="return-exchange-heading">
        <h2 id="return-exchange-heading">Return or exchange consultation</h2>
        <p id="return-exchange-boundary">Ask a person about your options in this chat. This does not confirm eligibility, approve a return or exchange, issue a shipping label, arrange a replacement, or refund a payment.</p>
        {!control || (control.status === "OPEN" && control.controlMode === "AI") ? (
          <button className={styles.handoffButton}
            aria-describedby="return-exchange-boundary"
            disabled={!handoffAvailable || isLoadingConversation || isSending || isRequestingHandoff}
            onClick={() => { void requestSpecialist(); }} type="button">
            {isRequestingHandoff ? "Requesting a specialist…" : "Talk to a person about a return or exchange"}
          </button>
        ) : null}
        {!handoffAvailable && (!control || (control.status === "OPEN" && control.controlMode === "AI"))
          ? <p>Return and exchange consultation is currently unavailable. No consultation has been requested.</p> : null}
        {control?.status === "OPEN" && (control.controlMode === "QUEUED" || control.controlMode === "HUMAN")
          ? <p>Describe your return or exchange question in the conversation below. A specialist must verify order facts before advising on your options.</p> : null}
      </aside>

      <SavedAddressStatusCard status={addressStatus} loading={isCheckingAddresses} error={addressError}
        onCheck={() => { void checkSavedAddresses(); }} onConsult={() => { void requestSpecialist(); }}
        consultationAvailable={handoffAvailable && (!control || (control.status === "OPEN" && control.controlMode === "AI"))}
        consultationPending={isRequestingHandoff}
        consultationActive={control?.status === "OPEN" && (control.controlMode === "QUEUED" || control.controlMode === "HUMAN")}
        consultationClosed={control?.status === "CLOSED"} />
      <RecentOrderReferencesCard result={recentOrders} loading={isFindingOrders} error={recentOrdersError} onFind={() => { void findRecentOrders(); }} />

      <div aria-busy={isLoadingConversation || isSending} aria-live="polite" className={styles.transcript} role="log">
        {isLoadingConversation ? <p className={styles.loading}>Loading your conversation…</p> : null}
        {!isLoadingConversation && messages.length === 0 ? (
          <div className={styles.emptyState}>
            <h2>Start a conversation</h2>
            <p>Ask about an order, delivery, or refund. A support specialist will guide you through the next step.</p>
          </div>
        ) : null}
        {messages.map((message) => {
          const messageTime = formatMessageTime(message.createdAt);
          const isCustomer = message.sender === "customer";
          const isSpecialist = message.sender === "specialist";
          const workflow = message.refundWorkflow;
          const cancellationRequest = message.cancellationRequest;
          return (
            <article
              aria-label={isCustomer ? "Your message" : isSpecialist ? "Support specialist message" : "Support assistant message"}
              className={`${styles.message} ${isCustomer ? styles.messageCustomer : styles.messageAssistant}`}
              key={message.messageId}
            >
              <span className={styles.messageLabel}>{isCustomer ? "You" : isSpecialist ? "Support specialist" : "Support assistant"}</span>
              <p className={styles.bubble}>{message.text}</p>
              {messageTime ? <time dateTime={message.createdAt}>{messageTime}</time> : null}
              {workflow ? (
                <aside className={styles.workflowCard}>
                  <strong>Your refund request is ready to review</strong>
                  <p>View the current status and any next action before a refund is submitted.</p>
                  <a href={`/refunds/${encodeURIComponent(workflow.workflowId)}`}>View refund request</a>
                </aside>
              ) : null}
              {cancellationRequest && isCustomer === false ? <CancellationReviewAction
                orderReference={cancellationRequest.orderReference}
                loading={cancellationReviewLoading}
                error={cancellationReviewError?.orderReference === cancellationRequest.orderReference
                  ? cancellationReviewError.message : undefined}
                onReview={() => { void reviewCancellation(cancellationRequest.orderReference); }}
              /> : null}
            </article>
          );
        })}
      </div>

      {control?.status !== "CLOSED" ? <form className={styles.composer} noValidate onSubmit={submit}>
        <label className={styles.composerLabel} htmlFor="support-message">Your message</label>
        <textarea
          aria-describedby="support-message-count"
          disabled={isSending || isRequestingHandoff}
          id="support-message"
          maxLength={MAX_CUSTOMER_MESSAGE_LENGTH}
          onChange={(event) => updateDraft(event.target.value)}
          placeholder="For example, where is my order, or what is the return policy?"
          required
          rows={4}
          value={draft}
        />
        <details className={styles.orderReference}>
          <summary>Add an order reference if you have one</summary>
          <label htmlFor="support-order-reference">
            Order reference
            <input
              disabled={isSending || isRequestingHandoff}
              id="support-order-reference"
              maxLength={ORDER_REFERENCE_LIMIT}
              onChange={(event) => setOrderReference(event.target.value)}
              placeholder="For example, QXB4NEW2EPG6YJ7Q"
              type="text"
              value={orderReference}
            />
          </label>
        </details>
        {errorMessage ? <p className={styles.error} role="alert">{errorMessage}</p> : null}
        {clarification ? <p className={styles.clarification} role="status">{clarification}</p> : null}
        <div className={styles.composerFooter}>
          <span className={styles.characterCount} id="support-message-count">{draft.length}/{MAX_CUSTOMER_MESSAGE_LENGTH.toLocaleString()}</span>
          <button className={`cso-primary-button ${styles.sendButton}`} disabled={isSending || isLoadingConversation || isRequestingHandoff} type="submit">
            {isSending ? "Sending…" : "Send message"}
          </button>
        </div>
      </form> : null}
    </section>
  );
}
