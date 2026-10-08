import { fileURLToPath } from "node:url";

import { Worker } from "@temporalio/worker";

import type { RefundWorkflowActivities } from "./refund-workflow-activities.js";
import type { ZeroTotalCancellationActivities } from './zero-total-cancellation-activities.js';
import type { AuthorizedDummyCancellationActivities } from './authorized-dummy-cancellation-activities.js';

type RefundWorkerOptions = Readonly<{
  taskQueue: string;
  activities: RefundWorkflowActivities & ZeroTotalCancellationActivities & AuthorizedDummyCancellationActivities;
  temporalAddress?: string;
}>;

/** Starts a worker host after its Gateway-backed activities are composed. */
export async function runRefundWorker({
  taskQueue,
  activities,
  temporalAddress,
}: RefundWorkerOptions): Promise<void> {
  const worker = await Worker.create({
    workflowsPath: resolveWorkflowsPath(import.meta.url),
    activities,
    taskQueue,
    ...(temporalAddress === undefined ? {} : { connectionOptions: { address: temporalAddress } }),
  });

  await worker.run();
}

export function resolveWorkflowsPath(workerModuleUrl: string): string {
  const extension = fileURLToPath(workerModuleUrl).endsWith('.ts') ? '.ts' : '.js';
  return fileURLToPath(new URL(`./workflows${extension}`, workerModuleUrl));
}
