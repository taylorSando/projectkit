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
import { CONTRACT_VERSION, validateProjectEvent, } from './contract.js';
import { validateWorkRequest, } from './work.js';
import { validateLogRecord, } from './log.js';
import { validateConcern, NullDispatchAdapter, } from './dispatch.js';
const defaultNow = () => new Date().toISOString();
export function createProjectSignal(config) {
    const now = config.now ?? defaultNow;
    const producer = config.producer ?? { name: '@operator/projectkit', version: CONTRACT_VERSION };
    const dispatchAdapter = config.dispatchAdapter ?? new NullDispatchAdapter();
    const onError = config.onError ??
        ((r) => console.warn(`[projectkit] sink ${r.sink} failed: ${r.error ?? r.status}`));
    const materialize = (input) => {
        const event = {
            ...config.defaults,
            ...input,
            schema_version: CONTRACT_VERSION,
            project_key: input.project_key ?? config.projectKey,
            occurred_at: input.occurred_at ?? now(),
        };
        const problems = validateProjectEvent(event);
        if (problems.length > 0) {
            const msg = `[projectkit] invalid event ${event.event_type}: ${problems.join('; ')}`;
            if (config.strict)
                throw new Error(msg);
            onError({ ok: false, sink: 'validation', error: msg }, buildEnvelope([event]));
        }
        return event;
    };
    const buildEnvelope = (events) => ({
        contract_version: CONTRACT_VERSION,
        project_key: config.projectKey,
        emitted_at: now(),
        producer,
        events,
        ...(config.deliveryId ? { delivery_id: config.deliveryId() } : {}),
    });
    const materializeWorkRequest = (input) => {
        const req = {
            ...input,
            schema_version: CONTRACT_VERSION,
            project_key: input.project_key ?? config.projectKey,
            requested_at: input.requested_at ?? now(),
        };
        const problems = validateWorkRequest(req);
        if (problems.length > 0) {
            const msg = `[projectkit] invalid work request ${req.title}: ${problems.join('; ')}`;
            if (config.strict)
                throw new Error(msg);
            onError({ ok: false, sink: 'validation', error: msg }, buildEnvelope([]));
        }
        return req;
    };
    const buildWorkEnvelope = (inputs) => ({
        contract_version: CONTRACT_VERSION,
        project_key: config.projectKey,
        emitted_at: now(),
        producer,
        requests: inputs.map(materializeWorkRequest),
        ...(config.deliveryId ? { delivery_id: config.deliveryId() } : {}),
    });
    const materializeLogRecord = (input) => {
        const record = {
            ...input,
            schema_version: CONTRACT_VERSION,
            project_key: input.project_key ?? config.projectKey,
            occurred_at: input.occurred_at ?? now(),
        };
        const problems = validateLogRecord(record);
        if (problems.length > 0) {
            const msg = `[projectkit] invalid log record (${record.level}): ${problems.join('; ')}`;
            if (config.strict)
                throw new Error(msg);
            onError({ ok: false, sink: 'validation', error: msg }, buildEnvelope([]));
        }
        return record;
    };
    const buildLogEnvelope = (inputs) => ({
        contract_version: CONTRACT_VERSION,
        project_key: config.projectKey,
        emitted_at: now(),
        producer,
        records: inputs.map(materializeLogRecord),
        ...(config.deliveryId ? { delivery_id: config.deliveryId() } : {}),
    });
    const materializeConcern = (input) => {
        const concern = {
            ...input,
            schema_version: CONTRACT_VERSION,
            project_key: input.project_key ?? config.projectKey,
            dispatched_at: input.dispatched_at ?? now(),
        };
        const problems = validateConcern(concern);
        if (problems.length > 0) {
            const msg = `[projectkit] invalid concern ${concern.title}: ${problems.join('; ')}`;
            if (config.strict)
                throw new Error(msg);
            onError({ ok: false, sink: 'validation', error: msg }, buildEnvelope([]));
        }
        return concern;
    };
    const buildDispatchEnvelope = (inputs) => ({
        contract_version: CONTRACT_VERSION,
        project_key: config.projectKey,
        dispatched_at: now(),
        producer,
        concerns: inputs.map(materializeConcern),
        ...(config.deliveryId ? { delivery_id: config.deliveryId() } : {}),
    });
    const send = async (inputs) => {
        const events = inputs.map(materialize);
        const envelope = buildEnvelope(events);
        const result = await config.sink.deliver(envelope);
        if (!result.ok)
            onError(result, envelope);
        return result;
    };
    const sendDispatch = async (inputs) => {
        const envelope = buildDispatchEnvelope(inputs);
        const ack = await dispatchAdapter.dispatch(envelope);
        if (!ack.ok) {
            onError({ ok: false, sink: ack.adapter, status: ack.status, error: ack.error }, buildEnvelope([]));
        }
        return ack;
    };
    return {
        projectKey: config.projectKey,
        contractVersion: CONTRACT_VERSION,
        emit: (event) => send([event]),
        emitBatch: (events) => send(events),
        capture: (envelope, eventType = `${config.projectKey}.page.captured`) => send([
            {
                event_type: eventType,
                domain: 'capture',
                outcome: 'succeeded',
                sensitivity: envelope.sensitivity === 'private' ? 'private' : 'internal',
                payload: { capture_envelope: envelope },
            },
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
                },
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
                },
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
//# sourceMappingURL=client.js.map