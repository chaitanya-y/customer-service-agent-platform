import assert from 'node:assert/strict';
import { test } from 'node:test';
// The simulator already ships better-sqlite3; this test needs no extra type package.
const Database = require('better-sqlite3') as new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): { run(): void; get(): { count: number } | undefined };
  close(): void;
};

import { ZeroTotalCancellationMarker1760000000000 } from '../src/migrations/1760000000000-ZeroTotalCancellationMarker';
import { ZeroTotalCancellationScope1760000000001 } from '../src/migrations/1760000000001-ZeroTotalCancellationScope';

test('marker migration enforces one operation per order and does not need a live database', async () => {
  const database = new Database(':memory:');
  try {
    const runner = { async query(sql: string) { database.exec(sql); } };
    await new ZeroTotalCancellationMarker1760000000000().up(runner);
    await new ZeroTotalCancellationScope1760000000001().up(runner);
    database.prepare(`INSERT INTO cso_zero_total_cancellation_marker
      (operation_id,order_id,tenant_id,environment_id,customer_id,order_reference,facts_digest,workflow_id,preview_id,preview_expires_at,policy_version,idempotency_key,status)
      VALUES ('one','9','tenant','local','7','TEST','digest','workflow','preview','2099-01-01T00:00:00.000Z','NO_PAYMENT_ZERO_TOTAL_V1','key','PENDING')`).run();
    assert.throws(() => database.prepare(`INSERT INTO cso_zero_total_cancellation_marker
      (operation_id,order_id,tenant_id,environment_id,customer_id,order_reference,facts_digest,workflow_id,preview_id,preview_expires_at,policy_version,idempotency_key,status)
      VALUES ('two','9','tenant','local','7','TEST','digest','workflow','preview','2099-01-01T00:00:00.000Z','NO_PAYMENT_ZERO_TOTAL_V1','key','PENDING')`).run());
    await new ZeroTotalCancellationMarker1760000000000().down(runner);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='cso_zero_total_cancellation_marker'").get()?.count, 0);
  } finally { database.close(); }
});
