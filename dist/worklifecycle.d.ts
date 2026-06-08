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
/**
 * The states a work item moves through. Terminal states are `resolved`,
 * `wont_do`, and `reversed`; `reopened` re-enters the machine from `resolved`.
 * An agent can drive an item to `review_ready` but NEVER to a terminal success
 * on its own — see `applyWorkEvent` (the human-acceptance gate).
 */
export declare const WORK_ITEM_STATUSES: readonly ["new", "triaged", "agent_running", "human_assigned", "review_ready", "review_stale", "proposal_expired", "resolved", "reopened", "wont_do", "reversed"];
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
/** Who, if anyone, is allowed to act. `triage` = waiting on a human; `done` = closed. */
export declare const WORK_ITEM_LANES: readonly ["triage", "human", "agent", "both", "done"];
export type WorkItemLane = (typeof WORK_ITEM_LANES)[number];
export declare const WORK_ITEM_SEVERITIES: readonly ["low", "normal", "high", "urgent"];
export type WorkItemSeverity = (typeof WORK_ITEM_SEVERITIES)[number];
/** Statuses from which no further transition is allowed (except `resolved`→reopen/reverse). */
export declare const TERMINAL_STATUSES: readonly WorkItemStatus[];
/**
 * The append-only lifecycle events. A subset (`agent.*`, `human.*`,
 * `resolution.*`, `work_item.reversed`) drives the state machine; the rest are
 * annotations that append to the log without moving state. Generalized from
 * sitelayer's `HANDOFF_EVENT_TYPES` (the sitelayer-only entries —
 * support_packet/github/handoff_packet — are dropped; `evidence.attached`
 * is the portable replacement).
 */
export declare const WORK_LIFECYCLE_EVENT_TYPES: readonly ["work_item.created", "work_item.updated", "work_item.status_changed", "message.added", "evidence.attached", "agent.dispatch_requested", "agent.dispatch_acknowledged", "agent.message_received", "agent.artifact_attached", "agent.proposal_ready", "agent.completed", "human.assigned", "human.review_requested", "human.reviewed", "resolution.accepted", "resolution.reopened", "work_item.reversed"];
export type WorkLifecycleEventType = (typeof WORK_LIFECYCLE_EVENT_TYPES)[number];
export declare const WORK_ACTOR_KINDS: readonly ["user", "agent", "system", "external"];
export type WorkActorKind = (typeof WORK_ACTOR_KINDS)[number];
export declare const REVERSIBILITY_WINDOW_SECONDS_BY_SEVERITY: Record<WorkItemSeverity, number>;
export declare const DEFAULT_REVERSIBILITY_WINDOW_SECONDS = 86400;
export declare function reversibilityWindowForSeverity(severity: WorkItemSeverity | null | undefined): number;
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
    route_path: string | null;
    entity_kind: string | null;
    entity_id: string | null;
    /** Pointer back to the originating ProjectEvent / capture / WorkRequest. */
    source_event_ref: string | null;
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
/**
 * Build a fresh WorkItem in `new` / `triage` — the only entry point. Default
 * lane is `triage` (waiting on a human): creation NEVER auto-dispatches. The
 * reversibility window defaults from severity unless explicitly given.
 */
export declare function createWorkItem(input: CreateWorkItemInput, now?: string): WorkItem;
/** Epoch-ms at which a work item's reversibility window closes. */
export declare function reversalExpiresAtMs(item: WorkItem): number;
/**
 * True if the item can still be reversed at `now`: it is not already
 * reversed/declined, and the window from `created_at` has not closed.
 */
export declare function isReversible(item: WorkItem, now?: string): boolean;
export declare class IllegalTransitionError extends Error {
    readonly from: WorkItemStatus;
    readonly event: WorkLifecycleEventType;
    constructor(from: WorkItemStatus, event: WorkLifecycleEventType, detail?: string);
}
/** The canonical lane an item should sit in for a given status. */
export declare function laneForStatus(status: WorkItemStatus, fallback: WorkItemLane): WorkItemLane;
export interface ApplyResult {
    item: WorkItem;
    transition: {
        from: WorkItemStatus;
        to: WorkItemStatus;
        laneFrom: WorkItemLane;
        laneTo: WorkItemLane;
    };
}
/**
 * Apply one lifecycle event to a work item. PURE: returns a new item, never
 * mutates the input, never touches a clock unless `now` is omitted. Throws
 * `IllegalTransitionError` for a disallowed move so a caller fails closed.
 */
export declare function applyWorkEvent(item: WorkItem, event: WorkLifecycleEvent, now?: string): ApplyResult;
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
export declare function evaluatePromotion(item: WorkItem, policy?: PromotionPolicy): PromotionDecision;
/**
 * Map an internal lifecycle status to the published `CallbackStatus` (the
 * 5-value adapter-agnostic vocabulary in dispatch.ts). This is the load-bearing
 * boundary translation: the Callback shape must not change when the dispatch
 * adapter changes. Total — collapses the internal-only states to their closest
 * published meaning. (This is the canonical home of sitelayer's
 * `workItemStatusToCallbackStatus`.)
 */
export declare function workItemStatusToCallbackStatus(status: WorkItemStatus | string | null | undefined): CallbackStatus | null;
/** Map severity → the published WorkRequest/Concern priority vocabulary (1:1, default normal). */
export declare function severityToPriority(severity: WorkItemSeverity | string | null | undefined): WorkPriority;
/** Validate a WorkItem against the contract. Empty array == valid. Mirrors validateWorkRequest. */
export declare function validateWorkItem(o: unknown): string[];
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
export declare class MemoryWorkItemStore implements WorkItemStore {
    readonly items: Map<string, WorkItem>;
    readonly events: Map<string, WorkLifecycleEvent[]>;
    private seq;
    create(item: WorkItem): Promise<WorkItem>;
    get(id: string): Promise<WorkItem | null>;
    update(item: WorkItem): Promise<WorkItem>;
    list(filter?: WorkItemFilter): Promise<WorkItem[]>;
    appendEvent(event: WorkLifecycleEvent): Promise<WorkLifecycleEvent>;
    listEvents(workItemId: string): Promise<WorkLifecycleEvent[]>;
}
/**
 * The one call an app route makes: load → apply the pure reducer → persist the
 * new item AND append the event, atomically from the caller's view. Returns the
 * updated item + the stored event. Storage-agnostic — drives any `WorkItemStore`.
 *
 * Idempotency: if the event carries an `idempotency_key` that was already
 * applied, the store returns the prior event and the item is returned unchanged.
 */
export declare function transitionWorkItem(store: WorkItemStore, workItemId: string, event: Omit<WorkLifecycleEvent, 'work_item_id'>, now?: string): Promise<{
    item: WorkItem;
    event: WorkLifecycleEvent;
} | null>;
//# sourceMappingURL=worklifecycle.d.ts.map