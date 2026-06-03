/**
 * projectkit — the project-facing event + capture contract.
 *
 * This is the published interface that TESTBED projects (chess, nhl, learn,
 * sitelayer, winwar, sandolab, …) emit through. It is intentionally
 * SELF-CONTAINED: it imports nothing — not control-plane, not mesh, not
 * @operator/types. mesh is just one possible subscriber/sink (see ./sink).
 *
 * Wire stability rule: once a field or event-type literal has shipped, do
 * NOT change its meaning. Add a new optional field / new literal instead and
 * bump CONTRACT_VERSION per semver. The companion JSON Schema
 * (schemas/project-event.schema.json) is the cross-language mirror so a Go
 * subscriber (mesh) validates against the same shape.
 */

/** Semver of this contract. Subscribers pin a `^` range; producers stamp it on every event. */
export const CONTRACT_VERSION = '1.2.0' as const;

/**
 * A project key is an OPEN string — a project self-identifies. This is the
 * whole point of the decoupling: there is no central, closed roster of
 * "controlled projects" the contract must know about (that coupling, the old
 * OPERATOR_CONTROLLED_PROJECTS roster, is exactly what we are breaking).
 */
export type ProjectKey = string;

/** Coarse classification of what kind of thing happened. */
export type EventDomain =
  | 'lifecycle'
  | 'navigation'
  | 'user_action'
  | 'workflow_state'
  | 'workflow_event'
  | 'entity_view'
  | 'entity_change'
  | 'capture'
  | 'runtime_error'
  | 'diagnostic';

/** How the thing turned out. Open-ended via `string` fallback at the edges. */
export type EventOutcome =
  | 'requested'
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'conflict'
  | 'cancelled'
  | 'skipped'
  | 'degraded'
  | 'unknown';

export type Sensitivity = 'public' | 'internal' | 'private';

export type RedactionStatus = 'raw' | 'redacted' | 'summary_only' | 'pointer_only';

/**
 * `ProjectEvent` — the canonical unit a testbed emits. Domain-specific
 * event_type strings (e.g. "chess.drill.completed", "winwar.turn.accepted")
 * keep their names; the common fields below give a subscriber enough to
 * route, attribute, and derive work without knowing the project internally.
 */
export interface ProjectEvent {
  /** Equals CONTRACT_VERSION at emit time. A subscriber narrows on this. */
  schema_version: string;
  /** Stable wire string, project-namespaced, e.g. "nhl.lineup.saved". */
  event_type: string;
  /** Emitting project. Open string — no closed roster. */
  project_key: ProjectKey;
  /** ISO-8601 timestamp the event occurred. */
  occurred_at: string;

  // --- classification ----------------------------------------------------
  domain?: EventDomain;
  outcome?: EventOutcome | string;

  // --- attribution / routing --------------------------------------------
  environment?: string;
  build_sha?: string;
  source_surface?: string;
  route_path?: string;
  route_name?: string;
  session_id?: string;
  actor_kind?: string;
  /** End-user/app principal in the testbed app, distinct from the operator. */
  principal_id?: string | number | null;
  /** Delegated/impersonated actor if acting as another user/entity. */
  acting_as?: string | number | null;

  // --- entity / workflow -------------------------------------------------
  entity_kind?: string;
  entity_id?: string | number | null;
  workflow_id?: string | number | null;
  state_before?: string;
  state_after?: string;

  // --- measurement -------------------------------------------------------
  action?: string;
  reason?: string;
  duration_ms?: number;
  count?: number;
  error_code?: string;
  error_message?: string;
  summary?: string;

  // --- governance --------------------------------------------------------
  sensitivity?: Sensitivity;
  redaction_status?: RedactionStatus;
  retention_class?: string;

  /** Project-specific extras a subscriber may ignore. Keep it small + flat. */
  payload?: Record<string, unknown>;
}

/**
 * `ProjectEventEnvelope` — the transport wrapper for one or more events.
 * A sink delivers this; a subscriber acknowledges it. The `contract_version`
 * here is what B/C pin to.
 */
export interface ProjectEventEnvelope {
  contract_version: string;
  project_key: ProjectKey;
  /** ISO-8601 when the batch was flushed by the producer. */
  emitted_at: string;
  producer: { name: string; version?: string };
  events: ProjectEvent[];
  /** Optional idempotency key so a subscriber can dedupe retries. */
  delivery_id?: string;
}

// --- Capture surface (re-homed, self-contained) --------------------------
// The capture envelope formerly lived in @operator/types and cross-imported
// the cp/mesh-boundary types (ControlPlaneCapture, OperatorContextPacket).
// Here those are deliberately OPAQUE (`unknown | null`) so the project-facing
// contract does not drag in the mesh integration surface. A subscriber that
// understands probe data can still read it; a project that doesn't produce it
// just leaves it null.

export interface CaptureEnvelopePickedElement {
  selector: string;
  outerHTML: string;
}

export interface CaptureEnvelopeNetworkCapture {
  method: string;
  url: string;
  status: number;
  content_type: string;
}

/**
 * `CaptureEnvelope` — a captured moment on a testbed surface (the
 * "tab-to-task" unit). Trimmed to the project-facing essentials; opaque
 * fields hold producer-specific blobs without coupling the contract to them.
 */
export interface CaptureEnvelope {
  schema_version: string;
  capture_session_id?: string | null;
  url: string;
  page_title: string;
  captured_at: string;
  host_id: string;
  /** Resolved project slug this capture attributes/dispatches to. */
  project_key?: ProjectKey | null;
  project_hint?: string | null;
  source_surface?: string | null;
  screenshot_ref: string;
  dom_excerpt: string;
  selected_text: string;
  picked_element: CaptureEnvelopePickedElement | null;
  network_captures: CaptureEnvelopeNetworkCapture[];
  library_hints: string[];
  operator_intent: string;
  sensitivity: Sensitivity | 'internal' | 'private';
  build_sha?: string | null;
  feature_flags?: string[];
  /** Opaque probe output, if a probe was mounted (cp-boundary; not typed here). */
  probe_data?: unknown | null;
  /** Opaque inbound operator-context packet (cp-boundary; not typed here). */
  operator_context_inbound?: unknown | null;
  /** Producer-emitted extras (producer/version/viewport/etc.). */
  meta?: Record<string, unknown>;
}

/** The wrapping shape a capture is persisted under. */
export interface CaptureEnvelopeProperties {
  capture_envelope: CaptureEnvelope;
}

/**
 * Validate a ProjectEvent against the contract. Returns a list of problems;
 * an empty list means valid. Pure, dependency-free — usable in a fail-closed
 * producer or a subscriber gate.
 */
export function validateProjectEvent(e: unknown): string[] {
  const problems: string[] = [];
  if (typeof e !== 'object' || e === null) return ['event is not an object'];
  const ev = e as Record<string, unknown>;
  const reqString = (k: string) => {
    if (typeof ev[k] !== 'string' || (ev[k] as string).length === 0) {
      problems.push(`missing/invalid required string field: ${k}`);
    }
  };
  reqString('schema_version');
  reqString('event_type');
  reqString('project_key');
  reqString('occurred_at');
  if (typeof ev['occurred_at'] === 'string' && Number.isNaN(Date.parse(ev['occurred_at'] as string))) {
    problems.push('occurred_at is not a parseable ISO-8601 timestamp');
  }
  if (ev['payload'] !== undefined && (typeof ev['payload'] !== 'object' || ev['payload'] === null)) {
    problems.push('payload, when present, must be an object');
  }
  return problems;
}
