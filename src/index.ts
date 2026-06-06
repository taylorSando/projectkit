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
