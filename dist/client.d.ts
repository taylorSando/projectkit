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
import { type ProjectEvent, type ProjectEventEnvelope, type ProjectKey, type CaptureEnvelope } from './contract.js';
import { type WorkRequest, type WorkRequestEnvelope } from './work.js';
import { type LogLevel, type LogRecord, type LogEnvelope } from './log.js';
import { type Concern, type DispatchEnvelope, type DispatchAdapter, type Ack } from './dispatch.js';
import type { EventSink, SinkResult } from './sink.js';
/** Everything except the fields the SDK stamps for you. */
export type EmitInput = Omit<ProjectEvent, 'schema_version' | 'project_key' | 'occurred_at'> & Partial<Pick<ProjectEvent, 'occurred_at' | 'project_key'>>;
/** A work request minus the fields the SDK stamps for you. */
export type WorkRequestInput = Omit<WorkRequest, 'schema_version' | 'project_key' | 'requested_at'> & Partial<Pick<WorkRequest, 'requested_at' | 'project_key'>>;
/**
 * A log record minus the fields the SDK stamps for you. `level` and `message`
 * are required; the rest (logger, source_surface, error_code, fields, …) are
 * optional. `project_key`/`occurred_at` may be supplied to override the stamp.
 */
export type LogRecordInput = Omit<LogRecord, 'schema_version' | 'project_key' | 'occurred_at'> & Partial<Pick<LogRecord, 'occurred_at' | 'project_key'>>;
/** A concern minus the fields the SDK stamps for you. */
export type ConcernInput = Omit<Concern, 'schema_version' | 'project_key' | 'dispatched_at'> & Partial<Pick<Concern, 'dispatched_at' | 'project_key'>>;
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
    producer?: {
        name: string;
        version?: string;
    };
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
export declare function createProjectSignal(config: ProjectSignalConfig): ProjectSignal;
//# sourceMappingURL=client.d.ts.map