/**
 * @operator/projectkit — the standalone project-signal interface.
 *
 * THE INVARIANT: this package imports nothing from control-plane or mesh.
 * Testbed projects depend on THIS; mesh SUBSCRIBES to it (as one HttpSink).
 * Enforced by test/invariant.test.mjs (fail-closed).
 *
 *   Layer 3 (testbeds)  --emit-->  projectkit contract  <--subscribe--  Layer 1 (mesh)
 *
 * One-import convenience surface; narrow imports available via
 * '@operator/projectkit/contract' and '@operator/projectkit/handoff'.
 */
export { CONTRACT_VERSION, validateProjectEvent, } from './contract.js';
export { NullSink, MemorySink, ConsoleSink, HttpSink, FanoutSink, } from './sink.js';
export { NullArtifactSink, MemoryArtifactSink, HttpArtifactSink, FanoutArtifactSink, inlineArtifactRef, } from './artifact-sink.js';
export { validateWorkRequest, } from './work.js';
export { validateLogRecord, } from './log.js';
export { WORK_ITEM_STATUSES, WORK_ITEM_LANES, WORK_ITEM_SEVERITIES, TERMINAL_STATUSES, WORK_LIFECYCLE_EVENT_TYPES, WORK_ACTOR_KINDS, REVERSIBILITY_WINDOW_SECONDS_BY_SEVERITY, DEFAULT_REVERSIBILITY_WINDOW_SECONDS, reversibilityWindowForSeverity, createWorkItem, applyWorkEvent, evaluatePromotion, laneForStatus, isReversible, reversalExpiresAtMs, workItemStatusToCallbackStatus, callbackStatusToLifecycleEventType, callbackToLifecycleEvent, severityToPriority, validateWorkItem, transitionWorkItem, IllegalTransitionError, MemoryWorkItemStore, } from './worklifecycle.js';
export { WORK_QUEUE_COLUMNS, WORK_ITEM_STATUS_LABELS, WORK_ITEM_LANE_LABELS, WORK_ITEM_SEVERITY_LABELS, WORK_ITEM_STATUS_TONES, WORK_ITEM_DISPATCH_STATES, columnForWorkItem, groupWorkItemsByColumn, actionsForWorkItem, deriveWorkItemDispatchState, extractWorkItemArtifacts, assertWorkQueueVocabularyCoherent, } from './workqueue.js';
export { validateConcern, validateCallback, readHttpAck, NullDispatchAdapter, MemoryDispatchAdapter, HttpDispatchAdapter, } from './dispatch.js';
export { createProjectSignal, } from './client.js';
export { HANDOFF_VERSION, validateHandoff, serializeHandoff, parseHandoff, handoffToMarkdown, handoffToResumePrompt, newHandoff, } from './handoff.js';
//# sourceMappingURL=index.js.map