import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transitionHandoff, HandoffConflictError } from '../src/handoff-state.js';

const ai = { status: 'OPEN' as const, controlMode: 'AI' as const, controlVersion: 1, handoffSessionId: null, assignedStaffId: null };
test('complete handoff advances control versions and requires the exact live session owner', () => {
  const queued = transitionHandoff(ai, 'request', 1, 'session-1');
  assert.deepEqual(queued, { ...ai, controlMode: 'QUEUED', controlVersion: 2, handoffSessionId: 'session-1' });
  const human = transitionHandoff(queued, 'claim', 2, 'session-1', 'staff-1');
  assert.deepEqual(human, { ...queued, controlMode: 'HUMAN', controlVersion: 3, assignedStaffId: 'staff-1' });
  assert.deepEqual(transitionHandoff(human, 'reply', 3, 'session-1', 'staff-1'), human);
  assert.deepEqual(transitionHandoff(human, 'return_to_ai', 3, 'session-1', 'staff-1'), { ...ai, controlVersion: 4 });
  assert.deepEqual(transitionHandoff(human, 'close', 3, 'session-1', 'staff-1'), { ...human, status: 'CLOSED', controlVersion: 4 });
});
test('stale versions, sessions, different assignees and wrong state never gain control', () => {
  const queued = transitionHandoff(ai, 'request', 1, 'session-1');
  const human = transitionHandoff(queued, 'claim', 2, 'session-1', 'staff-1');
  for (const [state, action, version, session, staff] of [
    [ai, 'request', 0, 'session-1'], [queued, 'request', 2, 'session-1'],
    [queued, 'claim', 1, 'session-1', 'staff-1'], [queued, 'claim', 2, 'other', 'staff-1'],
    [human, 'claim', 3, 'session-1', 'staff-2'], [human, 'reply', 3, 'session-1', 'staff-2'],
    [human, 'close', 3, 'other', 'staff-1'], [human, 'return_to_ai', 2, 'session-1', 'staff-1'],
    [{ ...human, status: 'CLOSED' }, 'reply', 3, 'session-1', 'staff-1'],
  ] as const) assert.throws(() => transitionHandoff(state, action, version, session, staff), HandoffConflictError);
});
