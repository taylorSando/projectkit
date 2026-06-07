/**
 * projectkit — the WORK-ITEM LIFECYCLE surface (v1.4.0).
 *
 * A `WorkRequest` (work.ts) says "I am ASKING for work". A `Concern` (dispatch.ts)
 * says "RUN this and call back". This module is the missing MIDDLE: the durable
 * *lifecycle* of a work item between request and result — the state machine, the
 * promotion gate, the reversibility window, and the append-only event log a
 * testbed needs to run its OWN triage queue.
 *
 * WHY THIS EXISTS. The proven implementation of this lifecycle lived ENTIRELY
 * inside sitelayer's `context_work_items` Postgres app code (~2.6k lines:
 * an 11-state machine, 5 lanes, severity→reversibility windows, a handoff event
 * log, a status→Callback map). Every other testbed that wants to "act like
 * sitelayer" — own a triage surface, gate dispatch, accept/reverse a result —
 * would otherwise re-implement that machine by hand. This module lifts the
 * BEHAVIOR (pure, storage-agnostic) into the published contract so a testbed
 * adopts the architecture without sitelayer's plumbing: it brings its OWN
 * storage via the `WorkItemStore` port (sqlite, Firestore, a Map, …) and its
 * own UI. mesh remains one possible dispatch adapter — never the owner.
 *
 * Same invariants as the rest of projectkit: imports ONLY from ./contract.js,
 * ./dispatch.js, ./work.js (so the fail-closed invariant + zero-runtime-deps
 * hold); pure + dependency-free. No DB, no http, no env, no mesh.
 *
 * NOTE ON VERSIONING: this adds local lifecycle BEHAVIOR + app-internal types
 * (`WorkItem`, `WorkLifecycleEvent`); it introduces NO new transport envelope
 * that crosses the wire, so `CONTRACT_VERSION` is unchanged (a Go subscriber
 * pins to the same 1.3.0 wire shapes). Only the package minor bumps.
 *
 * Wire/behavior stability rule: once a status/lane/event literal or a transition
 * has shipped, do NOT change its meaning. Add a new literal/optional field and
 * bump the package version per semver. The transition table below is the SINGLE
 * edit site for the machine — mirror it, don't fork it.
 */

import type { ProjectKey } from './contract.js';
import type { CallbackStatus } from './dispatch.js';
import type { WorkIntent, WorkPriority } from './work.js';

// ---------------------------------------------------------------------------
// Vocabulary — the published lifecycle alphabet (mirrors sitelayer, now canonical here)
// ---------------------------------------------------------------------------

/**
 * The states a work item moves through. Terminal states are `resolved`,
 * `wont_do`, and `reversed`; `reopened` re-enters the machine from `resolved`.
 * An agent can drive an item to `review_ready` but NEVER to a terminal success
 * on its own — see `applyWorkEvent` (the human-acceptance gate).
 */
export const WORK_ITEM_STATUSES = [
  'new',
  'triaged',
  'agent_running',
  'human_assigned',
  'review_ready',
  'review_stale',
  'proposal_expired',
  'resolved',
  'reopened',
  'wont_do',
  'reversed',
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/** Who, if anyone, is allowed to act. `triage` = waiting on a human; `done` = closed. */
export const WORK_ITEM_LANES = ['triage', 'human', 'agent', 'both', 'done'] as const;
export type WorkItemLane = (typeof WORK_ITEM_LANES)[number];

export const WORK_ITEM_SEVERITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type WorkItemSeverity = (typeof WORK_ITEM_SEVERITIES)[number];

/** Statuses from which no further transition is allowed (except `resolved`→reopen/reverse). */
export const TERMINAL_STATUSES: readonly WorkItemStatus[] = ['resolved', 'wont_do', 'reversed'];

/**
 * The append-only lifecycle events. A subset (`agent.*`, `human.*`,
 * `resolution.*`, `work_item.reversed`) drives the state machine; the rest are
 * annotations that append to the log without moving state. Generalized from
 * sitelayer's `HANDOFF_EVENT_TYPES` (the sitelayer-only entries —
 * support_packet/github/handoff_packet — are dropped; `evidence.attached`
 * is the portable replacement).
 */
export const WORK_LIFECYCLE_EVENT_TYPES = [
  'work_item.created',
  'work_item.updated',
  'work_item.status_changed',
  'message.added',
  'evidence.attached',
  'agent.dispatch_requested',
  'agent.dispatch_acknowledged',
  'agent.message_received',
  'agent.artifact_attached',
  'agent.proposal_ready',
  'agent.completed',
  'human.assigned',
  'human.review_requested',
  'human.reviewed',
  'resolution.accepted',
  'resolution.reopened',
  'work_item.reversed',
] as const;
export type WorkLifecycleEventType = (typeof WORK_LIFECYCLE_EVENT_TYPES)[number];

export const WORK_ACTOR_KINDS = ['user', 'agent', 'system', 'external'] as const;
export type WorkActorKind = (typeof WORK_ACTOR_KINDS)[number];

// ---------------------------------------------------------------------------
// Reversibility window — severity → seconds (mirrors mesh tasks.reversibility_window_seconds)
// ---------------------------------------------------------------------------

export const REVERSIBILITY_WINDOW_SECONDS_BY_SEVERITY: Record<WorkItemSeverity, number> = {
  urgent: 3600, // 1h
  high: 21600, // 6h
  normal: 86400, // 24h
  low: 604800, // 7d
};

export const DEFAULT_REVERSIBILITY_WINDOW_SECONDS = 86400;

export function reversibilityWindowForSeverity(severity: WorkItemSeverity | null | undefined): number {
  if (severity && severity in REVERSIBILITY_WINDOW_SECONDS_BY_SEVERITY) {
    return REVERSIBILITY_WINDOW_SECONDS_BY_SEVERITY[severity];
  }
  return DEFAULT_REVERSIBILITY_WINDOW_SECONDS;
}

// ---------------------------------------------------------------------------
// The data — storage-agnostic WorkItem + lifecycle event
// ---------------------------------------------------------------------------

/**
 * A durable unit of work a testbed owns. Deliberately storage-agnostic: no
 * company_id, no support_packet_id, no DB columns — an app maps this onto its
 * own table/collection (sqlite, Firestore, …) via a `WorkItemStore`. Anything
 * app-specific rides in `metadata`.
 */
export interface WorkItem {
  /** App-assigned stable id. The handle a subscriber correlates + calls back on. */
  id: string;
  project_key: ProjectKey;
  title: string;
  summary: string | null;
  status: WorkItemStatus;
  lane: WorkItemLane;
  severity: WorkItemSeverity | null;
  /** What is being asked for (reuses the WorkRequest intent vocabulary). */
  intent: WorkIntent | null;

  // --- routing / attribution -------------------------------------------
  route_path: string | null;
  entity_kind: string | null;
  entity_id: string | null;
  /** Pointer back to the originating ProjectEvent / capture / WorkRequest. */
  source_event_ref: string | null;

  // --- lifecycle stamps -------------------------------------------------
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  reversed_at: string | null;
  reversibility_window_seconds: number;

  metadata: Record<string, unknown>;
}

/**
 * One append-only entry in a work item's history. State-changing events carry
 * an intrinsic target (derived by the reducer); `work_item.status_changed` /
 * `work_item.updated` carry an explicit `to_status`/`to_lane` for the manual
 * override path (a human flipping the lane, marking won't-do, …).
 */
export interface WorkLifecycleEvent {
  /** Store-assigned; omit when constructing a new event. */
  id?: string;
  work_item_id: string;
  type: WorkLifecycleEventType;
  actor_kind: WorkActorKind;
  actor_ref?: string | null;
  occurred_at: string;
  /** Manual-override target (only honored on status_changed / updated). */
  to_status?: WorkItemStatus;
  to_lane?: WorkItemLane;
  payload?: Record<string, unknown>;
  /** Producer-stable dedupe key so a retried event never double-applies. */
  idempotency_key?: string | null;
}

export interface CreateWorkItemInput {
  id: string;
  project_key: ProjectKey;
  title: string;
  summary?: string | null;
  severity?: WorkItemSeverity | null;
  intent?: WorkIntent | null;
  lane?: WorkItemLane;
  route_path?: string | null;
  entity_kind?: string | null;
  entity_id?: string | null;
  source_event_ref?: string | null;
  reversibilityWindowSeconds?: number | null;
  metadata?: Record<string, unknown>;
}

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

function cleanText(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Build a fresh WorkItem in `new` / `triage` — the only entry point. Default
 * lane is `triage` (waiting on a human): creation NEVER auto-dispatches. The
 * reversibility window defaults from severity unless explicitly given.
 */
export function createWorkItem(input: CreateWorkItemInput, now?: string): WorkItem {
  const title = cleanText(input.title);
  if (!input.id) throw new Error('createWorkItem: id is required');
  if (!title) throw new Error('createWorkItem: title is required');
  if (input.severity && !WORK_ITEM_SEVERITIES.includes(input.severity)) {
    throw new Error(`createWorkItem: invalid severity ${input.severity}`);
  }
  const lane = input.lane ?? 'triage';
  if (!WORK_ITEM_LANES.includes(lane)) throw new Error(`createWorkItem: invalid lane ${lane}`);
  const ts = nowIso(now);
  const window =
    typeof input.reversibilityWindowSeconds === 'number' && Number.isFinite(input.reversibilityWindowSeconds)
      ? Math.max(0, Math.floor(input.reversibilityWindowSeconds))
      : reversibilityWindowForSeverity(input.severity ?? null);
  return {
    id: input.id,
    project_key: input.project_key,
    title,
    summary: cleanText(input.summary),
    status: 'new',
    lane,
    severity: input.severity ?? null,
    intent: input.intent ?? null,
    route_path: cleanText(input.route_path),
    entity_kind: cleanText(input.entity_kind),
    entity_id: cleanText(input.entity_id),
    source_event_ref: cleanText(input.source_event_ref),
    created_at: ts,
    updated_at: ts,
    resolved_at: null,
    reversed_at: null,
    reversibility_window_seconds: window,
    metadata: input.metadata ?? {},
  };
}

// ---------------------------------------------------------------------------
// Reversibility check
// ---------------------------------------------------------------------------

/** Epoch-ms at which a work item's reversibility window closes. */
export function reversalExpiresAtMs(item: WorkItem): number {
  return Date.parse(item.created_at) + item.reversibility_window_seconds * 1000;
}

/**
 * True if the item can still be reversed at `now`: it is not already
 * reversed/declined, and the window from `created_at` has not closed.
 */
export function isReversible(item: WorkItem, now?: string): boolean {
  if (item.status === 'reversed' || item.status === 'wont_do') return false;
  return Date.parse(nowIso(now)) < reversalExpiresAtMs(item);
}

// ---------------------------------------------------------------------------
// The state machine — the heart
// ---------------------------------------------------------------------------

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: WorkItemStatus,
    readonly event: WorkLifecycleEventType,
    detail?: string,
  ) {
    super(`illegal transition from "${from}" on "${event}"${detail ? `: ${detail}` : ''}`);
    this.name = 'IllegalTransitionError';
  }
}

/** The canonical lane an item should sit in for a given status. */
export function laneForStatus(status: WorkItemStatus, fallback: WorkItemLane): WorkItemLane {
  switch (status) {
    case 'new':
    case 'triaged':
    case 'reopened':
      return 'triage';
    case 'agent_running':
      return 'agent';
    case 'human_assigned':
      return 'human';
    case 'review_ready':
    case 'review_stale':
    case 'proposal_expired':
      return 'both';
    case 'resolved':
    case 'wont_do':
    case 'reversed':
      return 'done';
    default:
      return fallback;
  }
}

interface TransitionResult {
  status: WorkItemStatus;
  lane: WorkItemLane;
  resolved?: boolean;
  reversed?: boolean;
}

/**
 * Pure transition table. Given the current item + an event, returns the next
 * status/lane (or throws `IllegalTransitionError`). This is the SINGLE source
 * of truth for the machine — mirrors sitelayer's documented transitions:
 *   agent.completed / agent.proposal_ready → review_ready (NEVER resolved)
 *   resolution.accepted                    → resolved (the human gate)
 *   work_item.reversed                     → reversed (only within the window)
 */
function deriveTransition(item: WorkItem, event: WorkLifecycleEvent, now: string): TransitionResult {
  const cur = item.status;
  const ev = event.type;

  if (TERMINAL_STATUSES.includes(cur)) {
    if (ev === 'resolution.reopened' && cur === 'resolved') return { status: 'reopened', lane: 'triage' };
    if (ev === 'work_item.reversed' && cur === 'resolved') {
      if (!isReversible(item, now)) throw new IllegalTransitionError(cur, ev, 'reversibility window closed');
      return { status: 'reversed', lane: 'done', reversed: true };
    }
    throw new IllegalTransitionError(cur, ev, 'item is terminal');
  }

  switch (ev) {
    case 'work_item.created':
      return { status: 'new', lane: 'triage' };

    // Annotations: append to the log, do not move state.
    case 'message.added':
    case 'evidence.attached':
    case 'agent.message_received':
    case 'agent.artifact_attached':
    case 'human.reviewed':
      return { status: cur, lane: item.lane };

    // Manual override path (human triage flip, mark won't-do, etc.).
    case 'work_item.status_changed':
    case 'work_item.updated': {
      const status = event.to_status ?? cur;
      if (!WORK_ITEM_STATUSES.includes(status)) {
        throw new IllegalTransitionError(cur, ev, `unknown target status ${status}`);
      }
      const lane = event.to_lane ?? laneForStatus(status, item.lane);
      if (!WORK_ITEM_LANES.includes(lane)) throw new IllegalTransitionError(cur, ev, `unknown lane ${lane}`);
      const out: TransitionResult = { status, lane };
      if (status === 'resolved') out.resolved = true;
      if (status === 'reversed') {
        if (!isReversible(item, now)) throw new IllegalTransitionError(cur, ev, 'reversibility window closed');
        out.reversed = true;
      }
      return out;
    }

    case 'agent.dispatch_requested':
    case 'agent.dispatch_acknowledged':
      // Stay in `both` if a human is co-watching, else pure `agent`.
      return { status: 'agent_running', lane: item.lane === 'both' ? 'both' : 'agent' };

    // THE GATE: an agent reaches review_ready, never a terminal success.
    case 'agent.proposal_ready':
    case 'agent.completed':
      return { status: 'review_ready', lane: 'both' };

    case 'human.assigned':
      return { status: 'human_assigned', lane: 'human' };

    case 'human.review_requested':
      return { status: 'review_ready', lane: item.lane === 'agent' ? 'both' : item.lane };

    case 'resolution.accepted':
      return { status: 'resolved', lane: 'done', resolved: true };

    case 'resolution.reopened':
      return { status: 'reopened', lane: 'triage' };

    case 'work_item.reversed':
      if (!isReversible(item, now)) throw new IllegalTransitionError(cur, ev, 'reversibility window closed');
      return { status: 'reversed', lane: 'done', reversed: true };

    default:
      throw new IllegalTransitionError(cur, ev, 'unknown event type');
  }
}

export interface ApplyResult {
  item: WorkItem;
  transition: { from: WorkItemStatus; to: WorkItemStatus; laneFrom: WorkItemLane; laneTo: WorkItemLane };
}

/**
 * Apply one lifecycle event to a work item. PURE: returns a new item, never
 * mutates the input, never touches a clock unless `now` is omitted. Throws
 * `IllegalTransitionError` for a disallowed move so a caller fails closed.
 */
export function applyWorkEvent(item: WorkItem, event: WorkLifecycleEvent, now?: string): ApplyResult {
  const ts = nowIso(now);
  const t = deriveTransition(item, event, ts);
  const next: WorkItem = {
    ...item,
    status: t.status,
    lane: t.lane,
    updated_at: ts,
    resolved_at: t.resolved ? (item.resolved_at ?? ts) : item.resolved_at,
    reversed_at: t.reversed ? (item.reversed_at ?? ts) : item.reversed_at,
  };
  return {
    item: next,
    transition: { from: item.status, to: next.status, laneFrom: item.lane, laneTo: next.lane },
  };
}

// ---------------------------------------------------------------------------
// The promotion gate — capture ≠ dispatch (default CLOSED)
// ---------------------------------------------------------------------------

/**
 * The auditable inputs that decide whether a triaged item becomes agent work.
 * Collapses sitelayer's three scattered env gates into one pure decision.
 */
export interface PromotionPolicy {
  /** Operator-enabled auto-dispatch flag (sitelayer: CAPTURE_AUTH_AUTO_DISPATCH). */
  autoDispatch?: boolean;
  /** Is the requesting actor a trusted role allowed to auto-dispatch? */
  trustedActor?: boolean;
  /** Is a dispatch backend actually configured (sitelayer: MESH_WORK_REQUEST_DISPATCH_URL)? */
  hasDispatchBackend?: boolean;
}

export interface PromotionDecision {
  promote: boolean;
  toLane: WorkItemLane;
  reason: string;
}

/**
 * Decide whether to auto-promote a `triage` item to an agent lane. DEFAULT
 * (no policy / autoDispatch off) → do NOT act; the item waits for a human to
 * flip the lane via a `work_item.status_changed` event. Promotion fires ONLY
 * when auto-dispatch is on, the actor is trusted, AND a backend exists — the
 * `promotion_decision.v1` rule, expressed as a total pure function.
 */
export function evaluatePromotion(item: WorkItem, policy: PromotionPolicy = {}): PromotionDecision {
  if (item.lane !== 'triage') {
    return { promote: false, toLane: item.lane, reason: 'already routed (not in triage)' };
  }
  if (!policy.autoDispatch) return { promote: false, toLane: 'triage', reason: 'auto-dispatch disabled (default)' };
  if (!policy.trustedActor) return { promote: false, toLane: 'triage', reason: 'actor not trusted for auto-dispatch' };
  if (!policy.hasDispatchBackend) return { promote: false, toLane: 'triage', reason: 'no dispatch backend configured' };
  return { promote: true, toLane: 'agent', reason: 'auto-dispatch policy satisfied' };
}

// ---------------------------------------------------------------------------
// Boundary mappings — internal status → published Callback vocabulary
// ---------------------------------------------------------------------------

/**
 * Map an internal lifecycle status to the published `CallbackStatus` (the
 * 5-value adapter-agnostic vocabulary in dispatch.ts). This is the load-bearing
 * boundary translation: the Callback shape must not change when the dispatch
 * adapter changes. Total — collapses the internal-only states to their closest
 * published meaning. (This is the canonical home of sitelayer's
 * `workItemStatusToCallbackStatus`.)
 */
export function workItemStatusToCallbackStatus(status: WorkItemStatus | string | null | undefined): CallbackStatus | null {
  switch (status) {
    case 'new':
    case 'triaged':
    case 'human_assigned':
    case 'reopened':
      return 'accepted';
    case 'agent_running':
    case 'review_ready':
    case 'review_stale':
    case 'proposal_expired':
      return 'running';
    case 'resolved':
      return 'succeeded';
    case 'wont_do':
      return 'failed';
    case 'reversed':
      return 'cancelled';
    default:
      return null;
  }
}

/** Map severity → the published WorkRequest/Concern priority vocabulary (1:1, default normal). */
export function severityToPriority(severity: WorkItemSeverity | string | null | undefined): WorkPriority {
  switch (severity) {
    case 'low':
    case 'normal':
    case 'high':
    case 'urgent':
      return severity;
    default:
      return 'normal';
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate a WorkItem against the contract. Empty array == valid. Mirrors validateWorkRequest. */
export function validateWorkItem(o: unknown): string[] {
  const problems: string[] = [];
  if (typeof o !== 'object' || o === null) return ['work item is not an object'];
  const r = o as Record<string, unknown>;
  const reqString = (k: string) => {
    if (typeof r[k] !== 'string' || (r[k] as string).length === 0) problems.push(`missing/invalid required string field: ${k}`);
  };
  reqString('id');
  reqString('project_key');
  reqString('title');
  reqString('created_at');
  if (typeof r['status'] !== 'string' || !WORK_ITEM_STATUSES.includes(r['status'] as WorkItemStatus)) {
    problems.push(`status must be one of: ${WORK_ITEM_STATUSES.join(', ')}`);
  }
  if (typeof r['lane'] !== 'string' || !WORK_ITEM_LANES.includes(r['lane'] as WorkItemLane)) {
    problems.push(`lane must be one of: ${WORK_ITEM_LANES.join(', ')}`);
  }
  if (r['severity'] != null && !WORK_ITEM_SEVERITIES.includes(r['severity'] as WorkItemSeverity)) {
    problems.push(`severity, when present, must be one of: ${WORK_ITEM_SEVERITIES.join(', ')}`);
  }
  if (typeof r['created_at'] === 'string' && Number.isNaN(Date.parse(r['created_at'] as string))) {
    problems.push('created_at is not a parseable ISO-8601 timestamp');
  }
  if (typeof r['reversibility_window_seconds'] !== 'number') {
    problems.push('reversibility_window_seconds must be a number');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The storage port — each testbed brings its own (sqlite / Firestore / …)
// ---------------------------------------------------------------------------

export interface WorkItemFilter {
  status?: WorkItemStatus;
  lane?: WorkItemLane;
  entity_kind?: string;
  entity_id?: string;
  limit?: number;
  offset?: number;
}

/**
 * The persistence boundary. An app implements this over its own store; the
 * lifecycle logic above never touches a database. This is the seam that lets a
 * testbed "act like sitelayer" without using sitelayer's Postgres.
 */
export interface WorkItemStore {
  create(item: WorkItem): Promise<WorkItem>;
  get(id: string): Promise<WorkItem | null>;
  update(item: WorkItem): Promise<WorkItem>;
  list(filter?: WorkItemFilter): Promise<WorkItem[]>;
  appendEvent(event: WorkLifecycleEvent): Promise<WorkLifecycleEvent>;
  listEvents(workItemId: string): Promise<WorkLifecycleEvent[]>;
}

/**
 * In-memory reference store. For tests, local dev, and as the shape a real
 * adapter mirrors — exactly like `MemorySink` / `MemoryDispatchAdapter`.
 * Dependency-free (a Map); not for production persistence.
 */
export class MemoryWorkItemStore implements WorkItemStore {
  readonly items = new Map<string, WorkItem>();
  readonly events = new Map<string, WorkLifecycleEvent[]>();
  private seq = 0;

  async create(item: WorkItem): Promise<WorkItem> {
    if (this.items.has(item.id)) throw new Error(`work item ${item.id} already exists`);
    this.items.set(item.id, item);
    return item;
  }
  async get(id: string): Promise<WorkItem | null> {
    return this.items.get(id) ?? null;
  }
  async update(item: WorkItem): Promise<WorkItem> {
    if (!this.items.has(item.id)) throw new Error(`work item ${item.id} not found`);
    this.items.set(item.id, item);
    return item;
  }
  async list(filter: WorkItemFilter = {}): Promise<WorkItem[]> {
    let rows = [...this.items.values()];
    if (filter.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter.lane) rows = rows.filter((r) => r.lane === filter.lane);
    if (filter.entity_kind) rows = rows.filter((r) => r.entity_kind === filter.entity_kind);
    if (filter.entity_id) rows = rows.filter((r) => r.entity_id === filter.entity_id);
    rows.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
    const offset = filter.offset ?? 0;
    return filter.limit != null ? rows.slice(offset, offset + filter.limit) : rows.slice(offset);
  }
  async appendEvent(event: WorkLifecycleEvent): Promise<WorkLifecycleEvent> {
    const log = this.events.get(event.work_item_id) ?? [];
    // Idempotency: a repeated key returns the prior event, never double-applies.
    if (event.idempotency_key) {
      const prior = log.find((e) => e.idempotency_key === event.idempotency_key);
      if (prior) return prior;
    }
    const stored: WorkLifecycleEvent = { ...event, id: event.id ?? `evt_${++this.seq}` };
    log.push(stored);
    this.events.set(event.work_item_id, log);
    return stored;
  }
  async listEvents(workItemId: string): Promise<WorkLifecycleEvent[]> {
    return [...(this.events.get(workItemId) ?? [])];
  }
}

/**
 * The one call an app route makes: load → apply the pure reducer → persist the
 * new item AND append the event, atomically from the caller's view. Returns the
 * updated item + the stored event. Storage-agnostic — drives any `WorkItemStore`.
 *
 * Idempotency: if the event carries an `idempotency_key` that was already
 * applied, the store returns the prior event and the item is returned unchanged.
 */
export async function transitionWorkItem(
  store: WorkItemStore,
  workItemId: string,
  event: Omit<WorkLifecycleEvent, 'work_item_id'>,
  now?: string,
): Promise<{ item: WorkItem; event: WorkLifecycleEvent } | null> {
  const current = await store.get(workItemId);
  if (!current) return null;
  const fullEvent: WorkLifecycleEvent = { ...event, work_item_id: workItemId };

  // Short-circuit on a replayed idempotency key BEFORE applying the reducer.
  if (fullEvent.idempotency_key) {
    const prior = (await store.listEvents(workItemId)).find((e) => e.idempotency_key === fullEvent.idempotency_key);
    if (prior) return { item: current, event: prior };
  }

  const { item } = applyWorkEvent(current, fullEvent, now);
  const saved = await store.update(item);
  const storedEvent = await store.appendEvent(fullEvent);
  return { item: saved, event: storedEvent };
}
