export type HandoffState = {
  status: 'OPEN' | 'CLOSED'; controlMode: 'AI' | 'QUEUED' | 'HUMAN'; controlVersion: number;
  handoffSessionId: string | null; assignedStaffId: string | null;
};
export type HandoffAction = 'request' | 'claim' | 'reply' | 'return_to_ai' | 'close';
export class HandoffConflictError extends Error { constructor() { super('Conversation control changed'); } }
export function transitionHandoff(state: HandoffState, action: HandoffAction, version: number, session: string, staff?: string): HandoffState {
  if (state.status !== 'OPEN' || state.controlVersion !== version || !Number.isSafeInteger(version) || version >= Number.MAX_SAFE_INTEGER) throw new HandoffConflictError();
  if (action === 'request') {
    if (state.controlMode !== 'AI') throw new HandoffConflictError();
    return { ...state, controlMode: 'QUEUED', controlVersion: version + 1, handoffSessionId: session, assignedStaffId: null };
  }
  if (!staff || state.handoffSessionId !== session) throw new HandoffConflictError();
  if (action === 'claim') {
    if (state.controlMode !== 'QUEUED' || state.assignedStaffId !== null) throw new HandoffConflictError();
    return { ...state, controlMode: 'HUMAN', controlVersion: version + 1, assignedStaffId: staff };
  }
  if (state.controlMode !== 'HUMAN' || state.assignedStaffId !== staff) throw new HandoffConflictError();
  if (action === 'reply') return state;
  if (action === 'return_to_ai') return { ...state, controlMode: 'AI', controlVersion: version + 1, handoffSessionId: null, assignedStaffId: null };
  return { ...state, status: 'CLOSED', controlVersion: version + 1 };
}
