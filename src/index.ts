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

export {
  CONTRACT_VERSION,
  validateProjectEvent,
  type ProjectKey,
  type EventDomain,
  type EventOutcome,
  type Sensitivity,
  type RedactionStatus,
  type ProjectEvent,
  type ProjectEventEnvelope,
  type CaptureEnvelope,
  type CaptureEnvelopePickedElement,
  type CaptureEnvelopeNetworkCapture,
  type CaptureEnvelopeProperties,
} from './contract.js';

export {
  NullSink,
  MemorySink,
  ConsoleSink,
  HttpSink,
  FanoutSink,
  type EventSink,
  type SinkResult,
  type SignFn,
  type HttpSinkOptions,
} from './sink.js';

export {
  NullArtifactSink,
  MemoryArtifactSink,
  HttpArtifactSink,
  FanoutArtifactSink,
  inlineArtifactRef,
  type Artifact,
  type ArtifactSink,
  type ArtifactSinkResult,
  type HttpArtifactSinkOptions,
} from './artifact-sink.js';

export {
  validateWorkRequest,
  type WorkIntent,
  type WorkPriority,
  type WorkRequest,
  type WorkRequestEnvelope,
} from './work.js';

export {
  validateLogRecord,
  type LogLevel,
  type LogRecord,
  type LogEnvelope,
} from './log.js';

export {
  WORK_ITEM_STATUSES,
  WORK_ITEM_LANES,
  WORK_ITEM_SEVERITIES,
  TERMINAL_STATUSES,
  WORK_LIFECYCLE_EVENT_TYPES,
  WORK_ACTOR_KINDS,
  REVERSIBILITY_WINDOW_SECONDS_BY_SEVERITY,
  DEFAULT_REVERSIBILITY_WINDOW_SECONDS,
  reversibilityWindowForSeverity,
  createWorkItem,
  applyWorkEvent,
  evaluatePromotion,
  laneForStatus,
  isReversible,
  reversalExpiresAtMs,
  workItemStatusToCallbackStatus,
  severityToPriority,
  validateWorkItem,
  transitionWorkItem,
  IllegalTransitionError,
  MemoryWorkItemStore,
  type WorkItemStatus,
  type WorkItemLane,
  type WorkItemSeverity,
  type WorkLifecycleEventType,
  type WorkActorKind,
  type WorkItem,
  type WorkLifecycleEvent,
  type CreateWorkItemInput,
  type ApplyResult,
  type PromotionPolicy,
  type PromotionDecision,
  type WorkItemFilter,
  type WorkItemStore,
} from './worklifecycle.js';

export {
  validateConcern,
  validateCallback,
  NullDispatchAdapter,
  MemoryDispatchAdapter,
  HttpDispatchAdapter,
  type CallbackMode,
  type ConcernCallback,
  type ConcernPriority,
  type Concern,
  type DispatchEnvelope,
  type Ack,
  type CallbackStatus,
  type CallbackArtifact,
  type Callback,
  type DispatchAdapter,
  type DispatchSignFn,
  type HttpDispatchAdapterOptions,
} from './dispatch.js';

export {
  createProjectSignal,
  type ProjectSignal,
  type ProjectSignalConfig,
  type EmitInput,
  type WorkRequestInput,
  type LogRecordInput,
  type ConcernInput,
} from './client.js';

export {
  HANDOFF_VERSION,
  validateHandoff,
  serializeHandoff,
  parseHandoff,
  handoffToMarkdown,
  handoffToResumePrompt,
  newHandoff,
  type Handoff,
  type HandoffEnvironment,
  type HandoffTask,
  type HandoffGotcha,
  type HandoffLink,
  type GotchaSeverity,
} from './handoff.js';
