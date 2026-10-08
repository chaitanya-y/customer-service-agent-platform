export type DeliveryIssueCategory = 'MISSING' | 'WRONG' | 'DAMAGED' | 'DELAYED';
export type DeliveryIssueReportStatus = 'RECEIVED' | 'CLAIMED' | 'ACKNOWLEDGED' | 'REVIEW_CLOSED';

/** Internal/staff representation. Never serialize this object to a customer. */
export type DeliveryIssueReport = Readonly<{
  reportId: string;
  tenantId: string;
  environmentId: string;
  customerId: string;
  conversationId: string;
  orderReference: string;
  category: DeliveryIssueCategory;
  status: DeliveryIssueReportStatus;
  version: number;
  assignedStaffId?: string;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  acknowledgedAt?: string;
  closedAt?: string;
}>;

/** The only report projection permitted on customer reads. */
export type CustomerDeliveryIssueReport = Readonly<Pick<
  DeliveryIssueReport,
  'reportId' | 'orderReference' | 'category' | 'status' | 'createdAt' | 'updatedAt'
>>;

export type DeliveryIssueReportAuditEvent = Readonly<{
  eventId: string;
  reportId: string;
  eventType: 'REPORT_RECEIVED' | 'REPORT_CLAIMED' | 'REPORT_ACKNOWLEDGED' | 'REPORT_REVIEW_CLOSED';
  occurredAt: string;
  actorType: 'CUSTOMER' | 'HUMAN';
  actorId: string;
  reportVersion: number;
}>;

export function toCustomerDeliveryIssueReport(report: DeliveryIssueReport): CustomerDeliveryIssueReport {
  return {
    reportId: report.reportId,
    orderReference: report.orderReference,
    category: report.category,
    status: report.status,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
  };
}
