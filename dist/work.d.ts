/**
 * projectkit — the WORK-REQUEST surface (v1.1.0).
 *
 * A `ProjectEvent` says "this happened". A `WorkRequest` says "I, the testbed,
 * am ASKING for work to be done". This is the missing contract surface: before
 * v1.1.0 the derivation of work from a capture lived ENTIRELY inside mesh + the
 * capture-task skill's untyped `operator_intent` decision tree. A testbed could
 * not REQUEST work through the contract; it could only emit an event and hope a
 * subscriber inferred intent. With `WorkRequest`, a testbed states the intent
 * as a TYPED field and routes it through the SAME sink — mesh stays just-a-URL.
 *
 * Same invariants as the rest of projectkit: imports NOTHING from control-plane,
 * mesh, or @operator/types; pure + dependency-free. mesh is ONE possible
 * subscriber that turns a WorkRequest into a task — never the owner of intent.
 *
 * Wire stability rule: once an intent literal or field has shipped, do NOT
 * change its meaning. Add a new optional field / new literal and bump
 * CONTRACT_VERSION per semver. The companion JSON Schema
 * (schemas/work-request.schema.json) is the Go-side mirror.
 */
import type { ProjectKey, Sensitivity } from './contract.js';
/**
 * What the testbed is asking for. A CLOSED set of well-known intents plus an
 * open `string` fallback so a project can name a domain-specific intent without
 * a contract bump. A subscriber narrows on the known literals and routes the
 * rest to a default lane.
 *
 * - `fix`              — something is broken; make it work.
 * - `investigate`     — diagnose / root-cause without necessarily fixing yet.
 * - `replicate`       — reproduce a reported behavior/bug.
 * - `review`          — look over a change/state and give a verdict.
 * - `research`        — open-ended inquiry, not tied to a defect.
 * - `capture-followup`— derived from a capture; collapses the skill's untyped
 *                       `operator_intent` decision tree into this typed field.
 */
export type WorkIntent = 'fix' | 'investigate' | 'replicate' | 'review' | 'research' | 'capture-followup' | string;
export type WorkPriority = 'low' | 'normal' | 'high' | 'urgent' | string;
/**
 * `WorkRequest` — one unit of requested work a testbed emits through the
 * contract. The common fields give a subscriber enough to create, attribute,
 * and route a task WITHOUT knowing the project internally.
 */
export interface WorkRequest {
    /** Equals CONTRACT_VERSION at emit time. A subscriber narrows on this. */
    schema_version: string;
    /** Requesting project. Open string — no closed roster. */
    project_key: ProjectKey;
    /** ISO-8601 timestamp the request was made. */
    requested_at: string;
    /**
     * Producer-stable idempotency key. A subscriber dedupes retries on this so
     * the same request never mints two tasks.
     */
    request_ref: string;
    /** What the testbed is asking for. Typed; collapses the old intent guesswork. */
    intent: WorkIntent;
    /** Short human-readable title for the task. */
    title: string;
    summary?: string;
    priority?: WorkPriority;
    acceptance?: string[];
    route_path?: string;
    entity_kind?: string;
    entity_id?: string | number | null;
    /**
     * Pointer back to the originating ProjectEvent/capture (e.g. its
     * delivery_id, event ref, or capture_session_id). For a `capture-followup`
     * this is what links the request to the captured moment.
     */
    source_event_ref?: string;
    sensitivity?: Sensitivity;
    links?: string[];
    /** Project-specific extras a subscriber may ignore. Keep it small + flat. */
    payload?: Record<string, unknown>;
}
/**
 * `WorkRequestEnvelope` — the transport wrapper for one or more requests.
 * Mirrors `ProjectEventEnvelope`: a sink delivers it; a subscriber
 * acknowledges it. `contract_version` is what subscribers pin to.
 */
export interface WorkRequestEnvelope {
    contract_version: string;
    project_key: ProjectKey;
    /** ISO-8601 when the batch was flushed by the producer. */
    emitted_at: string;
    producer: {
        name: string;
        version?: string;
    };
    requests: WorkRequest[];
    /** Optional idempotency key so a subscriber can dedupe retries. */
    delivery_id?: string;
}
/**
 * Validate a WorkRequest against the contract. Returns a list of problems; an
 * empty list means valid. Pure, dependency-free — usable in a fail-closed
 * producer or a subscriber gate. Mirrors `validateProjectEvent`.
 */
export declare function validateWorkRequest(o: unknown): string[];
//# sourceMappingURL=work.d.ts.map