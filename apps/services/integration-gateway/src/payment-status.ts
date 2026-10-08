import type { CommerceOrder, CommerceProvider, Money } from './commerce.js';
import type { OrderAccessContext } from './trusted-context.js';

type PaymentStatus = 'PAID' | 'PARTIALLY_PAID' | 'AUTHORIZED' | 'DECLINED' | 'NOT_RECORDED' | 'UNCERTAIN';
type RefundStatus = 'NONE' | 'PENDING' | 'PARTIALLY_REFUNDED' | 'PARTIALLY_REFUNDED_WITH_PENDING' | 'REFUNDED' | 'FAILED' | 'UNCERTAIN';

function validMoney(value: Money, currency: string, allowZero = false): boolean {
  return value?.currency === currency && Number.isSafeInteger(value.amountMinor) &&
    (allowZero ? value.amountMinor >= 0 : value.amountMinor > 0);
}

export function toPaymentStatus(order: CommerceOrder): {
  schemaVersion: '1'; reference: string; paymentStatus: PaymentStatus; refundStatus: RefundStatus;
} {
  if (typeof order.reference !== 'string' || order.reference.length < 1 || order.reference.length > 100) {
    throw new Error('Invalid payment status source');
  }

  const result = (paymentStatus: PaymentStatus, refundStatus: RefundStatus) => ({
    schemaVersion: '1' as const, reference: order.reference, paymentStatus, refundStatus,
  });
  const uncertain = () => result('UNCERTAIN', 'UNCERTAIN');
  const total = order.total;
  if (!total || typeof total.currency !== 'string' || !/^[A-Z]{3}$/u.test(total.currency) ||
      !validMoney(total, total.currency) || !Array.isArray(order.payments)) return uncertain();

  let settled = 0;
  let authorized = 0;
  let declined = 0;
  let recordedRefunds = 0;
  let pendingRefunds = 0;
  let failedRefunds = 0;
  const paymentIds = new Set<string>();
  const refundIds = new Set<string>();
  for (const payment of order.payments) {
    if (!payment || typeof payment.id !== 'string' || !payment.id.trim() || paymentIds.has(payment.id) ||
        !validMoney(payment.amount, total.currency) || !Array.isArray(payment.refunds)) return uncertain();
    paymentIds.add(payment.id);
    switch (payment.status) {
      case 'Settled': settled += payment.amount.amountMinor; break;
      case 'Authorized': authorized += 1; break;
      case 'Declined': declined += 1; break;
      default: return uncertain();
    }
    if (!Number.isSafeInteger(settled) || settled > total.amountMinor) return uncertain();
    if (payment.status !== 'Settled' && payment.refunds.length > 0) return uncertain();

    let paymentRefundTotal = 0;
    for (const refund of payment.refunds) {
      if (!refund || typeof refund.id !== 'string' || !refund.id.trim() || refundIds.has(refund.id) ||
          !validMoney(refund.amount, total.currency)) return uncertain();
      refundIds.add(refund.id);
      switch (refund.status) {
        case 'Settled':
        case 'Completed': recordedRefunds += refund.amount.amountMinor; paymentRefundTotal += refund.amount.amountMinor; break;
        case 'Pending':
        case 'Processing':
        case 'Submitted': pendingRefunds += refund.amount.amountMinor; paymentRefundTotal += refund.amount.amountMinor; break;
        case 'Failed':
        case 'Cancelled': failedRefunds += 1; break;
        default: return uncertain();
      }
      if (!Number.isSafeInteger(paymentRefundTotal) || paymentRefundTotal > payment.amount.amountMinor ||
          !Number.isSafeInteger(recordedRefunds) || !Number.isSafeInteger(pendingRefunds)) return uncertain();
    }
  }

  const paymentStatus: PaymentStatus = settled === total.amountMinor ? 'PAID'
    : settled > 0 ? 'PARTIALLY_PAID'
      : authorized > 0 ? 'AUTHORIZED'
        : declined === order.payments.length && declined > 0 ? 'DECLINED' : 'NOT_RECORDED';
  const refundStatus: RefundStatus = recordedRefunds > 0 && pendingRefunds > 0 ? 'PARTIALLY_REFUNDED_WITH_PENDING'
    : recordedRefunds === settled && recordedRefunds > 0 ? 'REFUNDED'
      : recordedRefunds > 0 ? 'PARTIALLY_REFUNDED'
        : pendingRefunds > 0 ? 'PENDING'
          : failedRefunds > 0 ? 'FAILED' : 'NONE';
  return result(paymentStatus, refundStatus);
}

export function createGetPaymentStatus(commerceProvider: CommerceProvider) {
  return async (orderReference: string, accessContext: OrderAccessContext) => {
    const order = await commerceProvider.getOrderByReference(orderReference);
    if (!order?.customer || order.customer.id !== accessContext.subjectCustomerId) return null;
    if (order.reference !== orderReference) throw new Error('Invalid payment status source');
    return toPaymentStatus(order);
  };
}

export type GetPaymentStatus = ReturnType<typeof createGetPaymentStatus>;
