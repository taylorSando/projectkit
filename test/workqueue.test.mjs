import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionsForWorkItem,
  assertWorkQueueVocabularyCoherent,
  callbackStatusToLifecycleEventType,
  callbackToLifecycleEvent,
  columnForWorkItem,
  createWorkItem,
  deriveWorkItemDispatchState,
  extractWorkItemArtifacts,
  groupWorkItemsByColumn,
  WORK_ITEM_STATUSES,
} from '../dist/index.js';

const T0 = '2026-06-24T12:00:00.000Z';

function item(over = {}) {
  return createWorkItem(
    {
      id: over.id ?? 'wi_1',
      project_key: 'chess',
      title: 'Captured issue',
      severity: 'normal',
      metadata: {
        work_request_payload: {
          artifacts: [
            { kind: 'audio', ref: '/api/artifacts/a1', content_type: 'audio/webm', byte_size: 100 },
            { kind: 'video', ref: '/api/artifacts/v1', content_type: 'video/webm', duration_ms: 1500 },
          ],
        },
      },
      ...over,
    },
    T0,
  );
}

test('work queue vocabulary covers every lifecycle status', () => {
  assertWorkQueueVocabularyCoherent();
  const seen = new Set();
  for (const status of WORK_ITEM_STATUSES) {
    seen.add(columnForWorkItem({ status, lane: 'triage' }));
  }
  assert.deepEqual([...seen].sort(), ['agent', 'done', 'review', 'triage']);
});

test('work queue grouping and action projection are lifecycle-driven', () => {
  const grouped = groupWorkItemsByColumn([
    item({ id: 'a' }),
    item({ id: 'b', lane: 'agent' }),
    { ...item({ id: 'c' }), status: 'review_ready', lane: 'both' },
    { ...item({ id: 'd' }), status: 'resolved', lane: 'done' },
  ]);
  assert.equal(grouped.triage.length, 2);
  assert.equal(grouped.review.length, 1);
  assert.equal(grouped.done.length, 1);

  const actions = actionsForWorkItem(item());
  assert.ok(actions.some((action) => action.id === 'send_to_agent' && action.event_type === 'work_item.status_changed'));
  assert.ok(actions.some((action) => action.id === 'wont_do' && action.destructive));
});

test('dispatch projection distinguishes requested, accepted, and local-only states', () => {
  const base = { ...item(), status: 'agent_running', lane: 'agent' };
  assert.equal(deriveWorkItemDispatchState(base, []).state, 'requested');
  assert.equal(
    deriveWorkItemDispatchState(base, [
      {
        work_item_id: base.id,
        type: 'agent.dispatch_requested',
        actor_kind: 'system',
        occurred_at: T0,
        payload: { ack: { ok: true, adapter: 'mesh', accepted: 0, concern_ref: 'c1' } },
      },
    ]).state,
    'local_only',
  );
  assert.equal(
    deriveWorkItemDispatchState(base, [
      {
        work_item_id: base.id,
        type: 'agent.dispatch_requested',
        actor_kind: 'system',
        occurred_at: T0,
        payload: { ack: { ok: true, adapter: 'mesh', accepted: 1, concern_ref: 'c1', poll_ref: 'p1' } },
      },
    ]).state,
    'accepted_pollable',
  );
});

test('callback projection preserves the human review gate', () => {
  assert.equal(callbackStatusToLifecycleEventType('succeeded'), 'agent.completed');
  assert.equal(callbackStatusToLifecycleEventType('failed'), 'message.added');
  const event = callbackToLifecycleEvent('wi_1', {
    schema_version: '1.4.0',
    concern_ref: 'c1',
    status: 'succeeded',
    completed_at: T0,
  });
  assert.equal(event.type, 'agent.completed');
  assert.equal(event.work_item_id, 'wi_1');
  assert.equal(event.payload.callback.status, 'succeeded');
});

test('artifact extraction reads work request and callback artifacts without duplicates', () => {
  const artifacts = extractWorkItemArtifacts(item(), [
    {
      work_item_id: 'wi_1',
      type: 'agent.completed',
      actor_kind: 'agent',
      occurred_at: T0,
      payload: {
        callback: {
          schema_version: '1.4.0',
          concern_ref: 'c1',
          status: 'succeeded',
          artifacts: [{ kind: 'report', ref: 'report://1' }],
        },
      },
    },
  ]);
  assert.deepEqual(
    artifacts.map((artifact) => artifact.kind).sort(),
    ['audio', 'report', 'video'],
  );
});
