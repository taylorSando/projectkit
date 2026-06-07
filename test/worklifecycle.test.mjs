import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkItem,
  applyWorkEvent,
  evaluatePromotion,
  isReversible,
  laneForStatus,
  workItemStatusToCallbackStatus,
  severityToPriority,
  reversibilityWindowForSeverity,
  validateWorkItem,
  transitionWorkItem,
  IllegalTransitionError,
  MemoryWorkItemStore,
  WORK_ITEM_STATUSES,
  TERMINAL_STATUSES,
} from '../dist/index.js';

const T0 = '2026-06-07T12:00:00.000Z';
const plus = (ms) => new Date(Date.parse(T0) + ms).toISOString();

function newItem(over = {}) {
  return createWorkItem(
    { id: 'wi_1', project_key: 'chess', title: 'Puzzle hint button does nothing', severity: 'normal', ...over },
    T0,
  );
}

test('createWorkItem starts in new/triage and never auto-dispatches', () => {
  const item = newItem();
  assert.equal(item.status, 'new');
  assert.equal(item.lane, 'triage');
  assert.equal(item.resolved_at, null);
  assert.equal(item.reversibility_window_seconds, 86400); // normal
  assert.deepEqual(validateWorkItem(item), []);
});

test('createWorkItem requires id + title and validates severity', () => {
  assert.throws(() => createWorkItem({ id: '', project_key: 'chess', title: 'x' }), /id is required/);
  assert.throws(() => createWorkItem({ id: 'a', project_key: 'chess', title: '  ' }), /title is required/);
  assert.throws(
    () => createWorkItem({ id: 'a', project_key: 'chess', title: 'x', severity: 'sev1' }),
    /invalid severity/,
  );
});

test('reversibility window follows severity', () => {
  assert.equal(reversibilityWindowForSeverity('urgent'), 3600);
  assert.equal(reversibilityWindowForSeverity('high'), 21600);
  assert.equal(reversibilityWindowForSeverity('low'), 604800);
  assert.equal(reversibilityWindowForSeverity(null), 86400);
  assert.equal(reversibilityWindowForSeverity('nonsense'), 86400);
});

test('THE GATE: agent.completed reaches review_ready, NEVER resolved', () => {
  let item = newItem();
  ({ item } = applyWorkEvent(item, mk('agent.dispatch_requested', 'agent'), plus(1000)));
  assert.equal(item.status, 'agent_running');
  ({ item } = applyWorkEvent(item, mk('agent.completed', 'agent'), plus(2000)));
  assert.equal(item.status, 'review_ready');
  assert.equal(item.lane, 'both');
  assert.equal(item.resolved_at, null, 'agent must not stamp resolved_at');
});

test('human acceptance is what resolves it', () => {
  let item = newItem();
  ({ item } = applyWorkEvent(item, mk('agent.completed', 'agent'), plus(1000)));
  ({ item } = applyWorkEvent(item, mk('resolution.accepted', 'user'), plus(2000)));
  assert.equal(item.status, 'resolved');
  assert.equal(item.lane, 'done');
  assert.equal(item.resolved_at, plus(2000));
});

test('manual override path: human flips lane / marks wont_do via status_changed', () => {
  let item = newItem();
  // human promotes to agent lane
  ({ item } = applyWorkEvent(item, { ...mk('work_item.status_changed', 'user'), to_status: 'triaged', to_lane: 'agent' }, plus(500)));
  assert.equal(item.status, 'triaged');
  assert.equal(item.lane, 'agent');
  // human declines
  ({ item } = applyWorkEvent(item, { ...mk('work_item.status_changed', 'user'), to_status: 'wont_do' }, plus(900)));
  assert.equal(item.status, 'wont_do');
  assert.equal(item.lane, 'done');
});

test('reversal works inside the window and is refused outside it', () => {
  let item = newItem(); // 24h window
  ({ item } = applyWorkEvent(item, mk('agent.completed', 'agent'), plus(1000)));
  ({ item } = applyWorkEvent(item, mk('resolution.accepted', 'user'), plus(2000)));
  assert.ok(isReversible(item, plus(3000)));
  ({ item } = applyWorkEvent(item, mk('work_item.reversed', 'user'), plus(3000)));
  assert.equal(item.status, 'reversed');
  assert.equal(item.reversed_at, plus(3000));

  // a fresh resolved item, now past the window, cannot be reversed
  let late = newItem();
  ({ item: late } = applyWorkEvent(late, mk('resolution.accepted', 'user'), plus(1000)));
  assert.equal(isReversible(late, plus(86400_000 + 5000)), false);
  assert.throws(
    () => applyWorkEvent(late, mk('work_item.reversed', 'user'), plus(86400_000 + 5000)),
    IllegalTransitionError,
  );
});

test('terminal items reject further transitions (except resolved→reopen/reverse)', () => {
  let item = newItem();
  ({ item } = applyWorkEvent(item, { ...mk('work_item.status_changed', 'user'), to_status: 'wont_do' }, plus(500)));
  assert.throws(() => applyWorkEvent(item, mk('agent.completed', 'agent'), plus(600)), IllegalTransitionError);

  let resolved = newItem();
  ({ item: resolved } = applyWorkEvent(resolved, mk('resolution.accepted', 'user'), plus(500)));
  const re = applyWorkEvent(resolved, mk('resolution.reopened', 'user'), plus(600));
  assert.equal(re.item.status, 'reopened');
  assert.equal(re.item.lane, 'triage');
});

test('annotation events do not move state', () => {
  let item = newItem();
  ({ item } = applyWorkEvent(item, mk('agent.dispatch_requested', 'agent'), plus(100)));
  const before = item.status;
  ({ item } = applyWorkEvent(item, mk('agent.message_received', 'agent'), plus(200)));
  assert.equal(item.status, before);
  assert.equal(item.status, 'agent_running');
});

test('promotion gate is default-CLOSED and only opens on the full policy', () => {
  const item = newItem();
  assert.equal(evaluatePromotion(item).promote, false);
  assert.equal(evaluatePromotion(item, { autoDispatch: true }).promote, false);
  assert.equal(evaluatePromotion(item, { autoDispatch: true, trustedActor: true }).promote, false);
  const open = evaluatePromotion(item, { autoDispatch: true, trustedActor: true, hasDispatchBackend: true });
  assert.equal(open.promote, true);
  assert.equal(open.toLane, 'agent');
});

test('status → published Callback vocabulary is total and correct at the seam', () => {
  assert.equal(workItemStatusToCallbackStatus('new'), 'accepted');
  assert.equal(workItemStatusToCallbackStatus('agent_running'), 'running');
  assert.equal(workItemStatusToCallbackStatus('review_ready'), 'running');
  assert.equal(workItemStatusToCallbackStatus('resolved'), 'succeeded');
  assert.equal(workItemStatusToCallbackStatus('wont_do'), 'failed');
  assert.equal(workItemStatusToCallbackStatus('reversed'), 'cancelled');
  assert.equal(workItemStatusToCallbackStatus('garbage'), null);
  // every real status maps to a published value (totality)
  for (const s of WORK_ITEM_STATUSES) assert.ok(workItemStatusToCallbackStatus(s) !== null, `unmapped: ${s}`);
});

test('severity → priority is 1:1 with a normal default', () => {
  assert.equal(severityToPriority('urgent'), 'urgent');
  assert.equal(severityToPriority(null), 'normal');
  assert.equal(severityToPriority('weird'), 'normal');
});

test('laneForStatus + TERMINAL_STATUSES are coherent', () => {
  assert.equal(laneForStatus('resolved', 'triage'), 'done');
  assert.equal(laneForStatus('agent_running', 'triage'), 'agent');
  assert.deepEqual([...TERMINAL_STATUSES].sort(), ['resolved', 'reversed', 'wont_do']);
});

test('MemoryWorkItemStore + transitionWorkItem drive the full loop with idempotency', async () => {
  const store = new MemoryWorkItemStore();
  await store.create(newItem());

  const r1 = await transitionWorkItem(store, 'wi_1', { ...mkBare('agent.completed', 'agent'), idempotency_key: 'k1' }, plus(1000));
  assert.equal(r1.item.status, 'review_ready');

  // replaying the same idempotency key does not double-apply or advance state
  const r2 = await transitionWorkItem(store, 'wi_1', { ...mkBare('agent.completed', 'agent'), idempotency_key: 'k1' }, plus(1500));
  assert.equal(r2.item.status, 'review_ready');
  assert.equal((await store.listEvents('wi_1')).length, 1, 'idempotent event appended once');

  const r3 = await transitionWorkItem(store, 'wi_1', mkBare('resolution.accepted', 'user'), plus(2000));
  assert.equal(r3.item.status, 'resolved');

  assert.equal(await transitionWorkItem(store, 'missing', mkBare('resolution.accepted', 'user'), plus(3000)), null);
  const open = await store.list({ status: 'resolved' });
  assert.equal(open.length, 1);
});

// helpers
function mk(type, actor_kind) {
  return { work_item_id: 'wi_1', type, actor_kind, occurred_at: T0 };
}
function mkBare(type, actor_kind) {
  return { type, actor_kind, occurred_at: T0 };
}
