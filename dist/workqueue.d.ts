import type { Ack, Callback } from './dispatch.js';
import { type WorkItem, type WorkItemLane, type WorkItemSeverity, type WorkItemStatus, type WorkLifecycleEvent, type WorkLifecycleEventType } from './worklifecycle.js';
export declare const WORK_QUEUE_COLUMNS: readonly [{
    readonly id: "triage";
    readonly label: "Triage";
    readonly statuses: readonly ["new", "triaged", "reopened"];
}, {
    readonly id: "agent";
    readonly label: "Agent";
    readonly statuses: readonly ["agent_running"];
}, {
    readonly id: "review";
    readonly label: "Human Review";
    readonly statuses: readonly ["human_assigned", "review_ready", "review_stale", "proposal_expired"];
}, {
    readonly id: "done";
    readonly label: "Done";
    readonly statuses: readonly ["resolved", "wont_do", "reversed"];
}];
export type WorkQueueColumnId = (typeof WORK_QUEUE_COLUMNS)[number]['id'];
export declare const WORK_ITEM_STATUS_LABELS: Record<WorkItemStatus, string>;
export declare const WORK_ITEM_LANE_LABELS: Record<WorkItemLane, string>;
export declare const WORK_ITEM_SEVERITY_LABELS: Record<WorkItemSeverity, string>;
export type WorkItemTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';
export declare const WORK_ITEM_STATUS_TONES: Record<WorkItemStatus, WorkItemTone>;
export type WorkQueueActionId = 'send_to_agent' | 'assign_human' | 'request_review' | 'accept_resolution' | 'reopen' | 'reverse' | 'wont_do';
export interface WorkQueueAction {
    id: WorkQueueActionId;
    label: string;
    event_type: WorkLifecycleEventType;
    to_status?: WorkItemStatus;
    to_lane?: WorkItemLane;
    enabled: boolean;
    disabled_reason?: string;
    primary?: boolean;
    destructive?: boolean;
}
export interface WorkQueueActionPolicy {
    canDispatch?: boolean;
    canAssignHuman?: boolean;
    canRequestReview?: boolean;
    canAccept?: boolean;
    canReopen?: boolean;
    canReverse?: boolean;
    canDecline?: boolean;
    now?: string;
}
export declare function columnForWorkItem(item: Pick<WorkItem, 'status' | 'lane'>): WorkQueueColumnId;
export declare function groupWorkItemsByColumn<T extends Pick<WorkItem, 'status' | 'lane'>>(items: readonly T[]): Record<WorkQueueColumnId, T[]>;
export declare function actionsForWorkItem(item: WorkItem, policy?: WorkQueueActionPolicy): WorkQueueAction[];
export declare const WORK_ITEM_DISPATCH_STATES: readonly ["not_requested", "local_only", "requested", "accepted_pollable", "accepted_unpollable", "running", "review_ready", "closed", "failed", "cancelled"];
export type WorkItemDispatchState = (typeof WORK_ITEM_DISPATCH_STATES)[number];
export interface WorkItemDispatchProjection {
    state: WorkItemDispatchState;
    label: string;
    detail?: string;
    ack?: Ack;
    callback_status?: Callback['status'];
    poll_ref?: string;
    concern_ref?: string;
}
export declare function deriveWorkItemDispatchState(item: WorkItem, events?: readonly WorkLifecycleEvent[]): WorkItemDispatchProjection;
export interface WorkItemArtifactRef {
    kind: string;
    ref: string;
    url?: string;
    content_type?: string;
    byte_size?: number;
    duration_ms?: number;
    source: 'work_request' | 'callback' | 'event';
}
export declare function extractWorkItemArtifacts(item: WorkItem, events?: readonly WorkLifecycleEvent[]): WorkItemArtifactRef[];
export declare function assertWorkQueueVocabularyCoherent(): void;
//# sourceMappingURL=workqueue.d.ts.map