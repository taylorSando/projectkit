/**
 * projectkit — the 1-import SDK a testbed embeds. Sink-agnostic, no mesh
 * import. A project does:
 *
 *   import { createProjectSignal, HttpSink } from '@operator/projectkit';
 *   const signal = createProjectSignal({
 *     projectKey: 'chess',
 *     sink: new HttpSink({ url: process.env.SIGNAL_SINK_URL, sign: myHmac }),
 *   });
 *   await signal.emit({ event_type: 'chess.drill.completed', outcome: 'succeeded' });
 *
 * If SIGNAL_SINK_URL is unset, wire a NullSink and capture is simply off —
 * the project keeps working. That is the decoupling: the testbed depends on
 * the contract, never on the subscriber being present.
 */

import {
  CONTRACT_VERSION,
  validateProjectEvent,
  type ProjectEvent,
  type ProjectEventEnvelope,
  type ProjectKey,
  type CaptureEnvelope,
} from './contract.js';
import {
  validateWorkRequest,
  type WorkRequest,
  type WorkRequestEnvelope,
} from './work.js';
import {
  validateLogRecord,
  type LogLevel,
  type LogRecord,
  type LogEnvelope,
} from './log.js';
import {
  validateConcern,
  NullDispatchAdapter,
  type Concern,
  type DispatchEnvelope,
  type DispatchAdapter,
  type Ack,
} from './dispatch.js';
import type { EventSink, SinkResult } from './sink.js';

/** Everything except the fields the SDK stamps for you. */
export type EmitInput = Omit<ProjectEvent, 'schema_version' | 'project_key' | 'occurred_at'> &
  Partial<Pick<ProjectEvent, 'occurred_at' | 'project_key'>>;

/** A work request minus the fields the SDK stamps for you. */
export type WorkRequestInput = Omit<WorkRequest, 'schema_version' | 'project_key' | 'requested_at'> &
  Partial<Pick<WorkRequest, 'requested_at' | 'project_key'>>;

/**
 * A log record minus the fields the SDK stamps for you. `level` and `message`
 * are required; the rest (logger, source_surface, error_code, fields, …) are
 * optional. `project_key`/`occurred_at` may be supplied to override the stamp.
 */
export type LogRecordInput = Omit<LogRecord, 'schema_version' | 'project_key' | 'occurred_at'> &
  Partial<Pick<LogRecord, 'occurred_at' | 'project_key'>>;

/** A concern minus the fields the SDK stamps for you. */
export type ConcernInput = Omit<Concern, 'schema_version' | 'project_key' | 'dispatched_at'> &
  Partial<Pick<Concern, 'dispatched_at' | 'project_key'>>;

export interface ProjectSignalConfig {
  projectKey: ProjectKey;
  sink: EventSink;
  /**
   * The DISPATCH-direction adapter (the other half of the boundary test). A
   * testbed dispatches Concerns through this; mesh is just ONE implementation
   * (an HttpDispatchAdapter pointed at its dispatch URL). Defaults to a
   * NullDispatchAdapter so dispatch is OFF until a host wires one — exactly
   * like an unset SIGNAL_SINK_URL leaves emit on a NullSink.
   */
  dispatchAdapter?: DispatchAdapter;
  /** Defaults merged into every event (e.g. environment, build_sha). */
  defaults?: Partial<ProjectEvent>;
  producer?: { name: string; version?: string };
  /** Clock injection for tests. Defaults to () => new Date().toISOString(). */
  now?: () => string;
  /** Called when a delivery fails. Defaults to a console.warn. */
  onError?: (result: SinkResult, envelope: ProjectEventEnvelope) => void;
  /** If true, validation failures throw; otherwise they go to onError. Default false. */
  strict?: boolean;
  /** Optional monotonic counter source for delivery_id. */
  deliveryId?: () => string;
}

export interface ProjectSignal {
  readonly projectKey: ProjectKey;
  readonly contractVersion: string;
  /** Emit a single event. Resolves to the sink result (never throws unless strict). */
  emit(event: EmitInput): Promise<SinkResult>;
  /** Emit a pre-built batch. */
  emitBatch(events: EmitInput[]): Promise<SinkResult>;
  /** Deliver a capture envelope as a `*.captured` event carrying it in payload. */
  capture(envelope: CaptureEnvelope, eventType?: string): Promise<SinkResult>;
  /**
   * REQUEST WORK through the contract. A testbed states its intent as a typed
   * field and routes it through the SAME EventSink (mesh stays just-a-URL): the
   * request travels as a `*.work.requested` ProjectEvent carrying the typed
   * WorkRequest in `payload.work_request`, so no sink needs to change. A
   * subscriber that understands work requests reads the payload (or validates
   * the standalone WorkRequestEnvelope from `buildWorkEnvelope`).
   */
  requestWork(req: WorkRequestInput, eventType?: string): Promise<SinkResult>;
  /**
   * LOG through the contract. A testbed ships a typed, leveled, redaction-aware
   * log line and routes it through the SAME EventSink (mesh stays just-a-URL):
   * the line travels as a `*.log` ProjectEvent (domain `diagnostic`, or
   * `runtime_error` for error/fatal) carrying the typed LogRecord in
   * `payload.log_record`, so no sink needs to change. Inert under NullSink. A
   * subscriber that understands logs reads the payload (or validates the
   * standalone LogEnvelope from `buildLogEnvelope`).
   */
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): Promise<SinkResult>;
  /**
   * DISPATCH a unit of work for execution and get back an Ack (the
   * dispatch-direction half of the boundary test). Unlike `requestWork`
   * (fire-and-forget through the EventSink), this routes through the injected
   * `DispatchAdapter` — mesh is just ONE adapter behind a URL. The eventual
   * RESULT arrives later as a `Callback` (webhook POST or poll via
   * `Ack.poll_ref`), keyed by `concern_ref`. Inert under the default
   * NullDispatchAdapter (dispatch is off, the app keeps working).
   */
  dispatch(concern: ConcernInput): Promise<Ack>;
  /** Dispatch a pre-built batch of concerns through the DispatchAdapter. */
  dispatchBatch(concerns: ConcernInput[]): Promise<Ack>;
  /** Build (but do not send) the standalone DispatchEnvelope — the Go-side wire mirror. */
  buildDispatchEnvelope(concerns: ConcernInput[]): DispatchEnvelope;
  /** Build (but do not send) the wire event envelope — handy for inspection/tests. */
  build(events: EmitInput[]): ProjectEventEnvelope;
  /** Build (but do not send) the standalone WorkRequestEnvelope — the Go-side wire mirror. */
  buildWorkEnvelope(reqs: WorkRequestInput[]): WorkRequestEnvelope;
  /** Build (but do not send) the standalone LogEnvelope — the Go-side wire mirror. */
  buildLogEnvelope(records: LogRecordInput[]): LogEnvelope;
}

const defaultNow = () => new Date().toISOString();

export function createProjectSignal(config: ProjectSignalConfig): ProjectSignal {
  const now = config.now ?? defaultNow;
  const producer = config.producer ?? { name: '@operator/projectkit', version: CONTRACT_VERSION };
  const dispatchAdapter = config.dispatchAdapter ?? new NullDispatchAdapter();
  const onError =
    config.onError ??
    ((r: SinkResult) => console.warn(`[projectkit] sink ${r.sink} failed: ${r.error ?? r.status}`));

  const materialize = (input: EmitInput): ProjectEvent => {
    const event: ProjectEvent = {
      ...config.defaults,
      ...input,
      schema_version: CONTRACT_VERSION,
      project_key: input.project_key ?? config.projectKey,
      occurred_at: input.occurred_at ?? now(),
    };
    const problems = validateProjectEvent(event);
    if (problems.length > 0) {
      const msg = `[projectkit] invalid event ${event.event_type}: ${problems.join('; ')}`;
      if (config.strict) throw new Error(msg);
      onError({ ok: false, sink: 'validation', error: msg }, buildEnvelope([event]));
    }
    return event;
  };

  const buildEnvelope = (events: ProjectEvent[]): ProjectEventEnvelope => ({
    contract_version: CONTRACT_VERSION,
    project_key: config.projectKey,
    emitted_at: now(),
    producer,
    events,
    ...(config.deliveryId ? { delivery_id: config.deliveryId() } : {}),
  });

  const materializeWorkRequest = (input: WorkRequestInput): WorkRequest => {
    const req: WorkRequest = {
      ...input,
      schema_version: CONTRACT_VERSION,
      project_key: input.project_key ?? config.projectKey,
      requested_at: input.requested_at ?? now(),
    };
    const problems = validateWorkRequest(req);
    if (problems.length > 0) {
      const msg = `[projectkit] invalid work request ${req.title}: ${problems.join('; ')}`;
      if (config.strict) throw new Error(msg);
      onError({ ok: false, sink: 'validation', error: msg }, buildEnvelope([]));
    }
    return req;
  };

  const buildWorkEnvelope = (inputs: WorkRequestInput[]): WorkRequestEnvelope => ({
    contract_version: CONTRACT_VERSION,
    project_key: config.projectKey,
    emitted_at: now(),
    producer,
    requests: inputs.map(materializeWorkRequest),
    ...(config.deliveryId ? { delivery_id: config.deliveryId() } : {}),
  });

  const materializeLogRecord = (input: LogRecordInput): LogRecord => {
    const record: LogRecord = {
      ...input,
      schema_version: CONTRACT_VERSION,
      project_key: input.project_key ?? config.projectKey,
      occurred_at: input.occurred_at ?? now(),
    };
    const problems = validateLogRecord(record);
    if (problems.length > 0) {
      const msg = `[projectkit] invalid log record (${record.level}): ${problems.join('; ')}`;
      if (config.strict) throw new Error(msg);
      onError({ ok: false, sink: 'validation', error: msg }, buildEnvelope([]));
    }
    return record;
  };

  const buildLogEnvelope = (inputs: LogRecordInput[]): LogEnvelope => ({
    contract_version: CONTRACT_VERSION,
    project_key: config.projectKey,
    emitted_at: now(),
    producer,
    records: inputs.map(materializeLogRecord),
    ...(config.deliveryId ? { delivery_id: config.deliveryId() } : {}),
  });

  const materializeConcern = (input: ConcernInput): Concern => {
    const concern: Concern = {
      ...input,
      schema_version: CONTRACT_VERSION,
      project_key: input.project_key ?? config.projectKey,
      dispatched_at: input.dispatched_at ?? now(),
    };
    const problems = validateConcern(concern);
    if (problems.length > 0) {
      const msg = `[projectkit] invalid concern ${concern.title}: ${problems.join('; ')}`;
      if (config.strict) throw new Error(msg);
      onError({ ok: false, sink: 'validation', error: msg }, buildEnvelope([]));
    }
    return concern;
  };

  const buildDispatchEnvelope = (inputs: ConcernInput[]): DispatchEnvelope => ({
    contract_version: CONTRACT_VERSION,
    project_key: config.projectKey,
    dispatched_at: now(),
    producer,
    concerns: inputs.map(materializeConcern),
    ...(config.deliveryId ? { delivery_id: config.deliveryId() } : {}),
  });

  const send = async (inputs: EmitInput[]): Promise<SinkResult> => {
    const events = inputs.map(materialize);
    const envelope = buildEnvelope(events);
    const result = await config.sink.deliver(envelope);
    if (!result.ok) onError(result, envelope);
    return result;
  };

  const sendDispatch = async (inputs: ConcernInput[]): Promise<Ack> => {
    const envelope = buildDispatchEnvelope(inputs);
    const ack = await dispatchAdapter.dispatch(envelope);
    if (!ack.ok) {
      onError(
        { ok: false, sink: ack.adapter, status: ack.status, error: ack.error },
        buildEnvelope([]),
      );
    }
    return ack;
  };

  return {
    projectKey: config.projectKey,
    contractVersion: CONTRACT_VERSION,
    emit: (event) => send([event]),
    emitBatch: (events) => send(events),
    capture: (envelope, eventType = `${config.projectKey}.page.captured`) =>
      send([
        {
          event_type: eventType,
          domain: 'capture',
          outcome: 'succeeded',
          sensitivity: envelope.sensitivity === 'private' ? 'private' : 'internal',
          payload: { capture_envelope: envelope },
        } as EmitInput,
      ]),
    requestWork: async (req, eventType = `${config.projectKey}.work.requested`) => {
      const request = materializeWorkRequest(req);
      return send([
        {
          event_type: eventType,
          domain: 'workflow_event',
          outcome: 'requested',
          action: request.intent,
          summary: request.summary ?? request.title,
          route_path: request.route_path,
          entity_kind: request.entity_kind,
          entity_id: request.entity_id,
          reason: request.source_event_ref,
          sensitivity: request.sensitivity,
          payload: { work_request: request },
        } as EmitInput,
      ]);
    },
    log: async (level, message, fields) => {
      const record = materializeLogRecord({
        level,
        message,
        ...(fields !== undefined ? { fields } : {}),
      });
      return send([
        {
          event_type: `${config.projectKey}.log`,
          domain: level === 'error' || level === 'fatal' ? 'runtime_error' : 'diagnostic',
          outcome: level === 'error' || level === 'fatal' ? 'failed' : 'unknown',
          action: level,
          summary: record.message,
          error_code: record.error_code,
          error_message: record.error_message,
          sensitivity: record.sensitivity,
          redaction_status: record.redaction_status,
          payload: { log_record: record },
        } as EmitInput,
      ]);
    },
    dispatch: (concern) => sendDispatch([concern]),
    dispatchBatch: (concerns) => sendDispatch(concerns),
    buildDispatchEnvelope,
    build: (events) => buildEnvelope(events.map(materialize)),
    buildWorkEnvelope,
    buildLogEnvelope,
  };
}
