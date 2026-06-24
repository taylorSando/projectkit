import { isReversible, laneForStatus, WORK_ITEM_LANES, WORK_ITEM_SEVERITIES, WORK_ITEM_STATUSES, } from './worklifecycle.js';
export const WORK_QUEUE_COLUMNS = [
    { id: 'triage', label: 'Triage', statuses: ['new', 'triaged', 'reopened'] },
    { id: 'agent', label: 'Agent', statuses: ['agent_running'] },
    { id: 'review', label: 'Human Review', statuses: ['human_assigned', 'review_ready', 'review_stale', 'proposal_expired'] },
    { id: 'done', label: 'Done', statuses: ['resolved', 'wont_do', 'reversed'] },
];
export const WORK_ITEM_STATUS_LABELS = {
    new: 'New',
    triaged: 'Triaged',
    agent_running: 'Agent running',
    human_assigned: 'Human assigned',
    review_ready: 'Review ready',
    review_stale: 'Review stale',
    proposal_expired: 'Proposal expired',
    resolved: 'Resolved',
    reopened: 'Reopened',
    wont_do: "Won't do",
    reversed: 'Reversed',
};
export const WORK_ITEM_LANE_LABELS = {
    triage: 'Triage',
    human: 'Human',
    agent: 'Agent',
    both: 'Review',
    done: 'Done',
};
export const WORK_ITEM_SEVERITY_LABELS = {
    low: 'Low',
    normal: 'Normal',
    high: 'High',
    urgent: 'Urgent',
};
export const WORK_ITEM_STATUS_TONES = {
    new: 'neutral',
    triaged: 'info',
    agent_running: 'info',
    human_assigned: 'warning',
    review_ready: 'warning',
    review_stale: 'danger',
    proposal_expired: 'danger',
    resolved: 'success',
    reopened: 'warning',
    wont_do: 'neutral',
    reversed: 'danger',
};
export function columnForWorkItem(item) {
    for (const column of WORK_QUEUE_COLUMNS) {
        if (column.statuses.includes(item.status))
            return column.id;
    }
    const lane = laneForStatus(item.status, item.lane);
    if (lane === 'agent')
        return 'agent';
    if (lane === 'human' || lane === 'both')
        return 'review';
    if (lane === 'done')
        return 'done';
    return 'triage';
}
export function groupWorkItemsByColumn(items) {
    const grouped = { triage: [], agent: [], review: [], done: [] };
    for (const item of items)
        grouped[columnForWorkItem(item)].push(item);
    return grouped;
}
export function actionsForWorkItem(item, policy = {}) {
    const actions = [];
    const allow = (key, fallback = true) => policy[key] !== false && fallback;
    const disabled = (enabled, reason) => ({ enabled, ...(enabled ? {} : { disabled_reason: reason ?? 'not allowed' }) });
    const add = (action) => {
        actions.push({ ...action, enabled: action.enabled ?? true });
    };
    if (item.status === 'resolved') {
        const canReopen = allow('canReopen');
        add({
            id: 'reopen',
            label: 'Reopen',
            event_type: 'resolution.reopened',
            primary: true,
            ...disabled(canReopen, 'reopen not allowed'),
        });
        const canReverse = allow('canReverse') && isReversible(item, policy.now);
        add({
            id: 'reverse',
            label: 'Reverse',
            event_type: 'work_item.reversed',
            destructive: true,
            ...disabled(canReverse, canReverse ? undefined : 'reversibility window closed'),
        });
        return actions;
    }
    if (item.status === 'wont_do' || item.status === 'reversed')
        return actions;
    if (['new', 'triaged', 'reopened', 'agent_running', 'human_assigned', 'review_ready', 'review_stale', 'proposal_expired'].includes(item.status)) {
        const canDispatch = allow('canDispatch');
        add({
            id: 'send_to_agent',
            label: item.status === 'agent_running' ? 'Retry agent' : 'Send to agent',
            event_type: 'work_item.status_changed',
            to_status: 'triaged',
            to_lane: 'agent',
            primary: ['new', 'triaged', 'reopened'].includes(item.status),
            ...disabled(canDispatch, 'agent dispatch not allowed'),
        });
    }
    if (['new', 'triaged', 'reopened', 'agent_running'].includes(item.status)) {
        const canAssign = allow('canAssignHuman');
        add({
            id: 'assign_human',
            label: 'Assign human',
            event_type: 'human.assigned',
            ...disabled(canAssign, 'human assignment not allowed'),
        });
    }
    if (item.status === 'agent_running' || item.status === 'human_assigned') {
        const canRequest = allow('canRequestReview');
        add({
            id: 'request_review',
            label: 'Request review',
            event_type: 'human.review_requested',
            ...disabled(canRequest, 'review request not allowed'),
        });
    }
    if (item.status === 'review_ready' || item.status === 'review_stale' || item.status === 'proposal_expired') {
        const canAccept = allow('canAccept');
        add({
            id: 'accept_resolution',
            label: 'Accept',
            event_type: 'resolution.accepted',
            primary: true,
            ...disabled(canAccept, 'acceptance not allowed'),
        });
        const canReopen = allow('canReopen');
        add({
            id: 'reopen',
            label: 'Reopen',
            event_type: 'resolution.reopened',
            ...disabled(canReopen, 'reopen not allowed'),
        });
    }
    if (!['resolved', 'wont_do', 'reversed'].includes(item.status)) {
        const canDecline = allow('canDecline');
        add({
            id: 'wont_do',
            label: "Won't do",
            event_type: 'work_item.status_changed',
            to_status: 'wont_do',
            to_lane: 'done',
            destructive: true,
            ...disabled(canDecline, 'decline not allowed'),
        });
    }
    return actions;
}
export const WORK_ITEM_DISPATCH_STATES = [
    'not_requested',
    'local_only',
    'requested',
    'accepted_pollable',
    'accepted_unpollable',
    'running',
    'review_ready',
    'closed',
    'failed',
    'cancelled',
];
export function deriveWorkItemDispatchState(item, events = []) {
    const callback = latestCallback(events);
    if (callback?.status === 'failed')
        return callbackProjection('failed', 'Callback failed', callback);
    if (callback?.status === 'cancelled')
        return callbackProjection('cancelled', 'Callback cancelled', callback);
    if (item.status === 'resolved' || item.status === 'wont_do' || item.status === 'reversed') {
        return { state: 'closed', label: WORK_ITEM_STATUS_LABELS[item.status] };
    }
    if (item.status === 'review_ready' || callback?.status === 'succeeded') {
        return callbackProjection('review_ready', 'Ready for review', callback);
    }
    if (callback?.status === 'running')
        return callbackProjection('running', 'Agent running', callback);
    const dispatch = latestDispatchEvent(events);
    if (!dispatch) {
        return item.status === 'agent_running'
            ? { state: 'requested', label: 'Dispatch requested', detail: 'No dispatch ack event is recorded.' }
            : { state: 'not_requested', label: 'Not dispatched' };
    }
    const payload = objectValue(dispatch.payload);
    if (payload && payload['dispatched'] === false) {
        return { state: 'local_only', label: 'Local only', detail: stringValue(payload['reason']) ?? 'Dispatch did not leave the app.' };
    }
    const ack = ackFromPayload(payload);
    const accepted = ack?.accepted ?? numberValue(payload?.['accepted']);
    const pollRef = ack?.poll_ref ?? stringValue(payload?.['poll_ref']);
    const concernRef = ack?.concern_ref ?? stringValue(payload?.['concern_ref']);
    if (ack?.ok === false) {
        return {
            state: 'local_only',
            label: 'Dispatch failed',
            detail: ack.error ?? 'Adapter returned a negative ack.',
            ack,
            concern_ref: concernRef,
        };
    }
    if (typeof accepted === 'number' && accepted <= 0) {
        return {
            state: 'local_only',
            label: 'Not accepted',
            detail: ack?.error ?? 'Adapter accepted zero concerns.',
            ack,
            concern_ref: concernRef,
        };
    }
    if (pollRef) {
        return { state: 'accepted_pollable', label: 'Accepted', detail: 'Poll handle available.', ack, poll_ref: pollRef, concern_ref: concernRef };
    }
    if (typeof accepted === 'number' && accepted > 0) {
        return { state: 'accepted_unpollable', label: 'Accepted', detail: 'No poll handle was returned.', ack, concern_ref: concernRef };
    }
    return { state: 'requested', label: 'Dispatch requested', ack, concern_ref: concernRef };
}
export function extractWorkItemArtifacts(item, events = []) {
    const artifacts = [];
    const seen = new Set();
    const push = (artifact) => {
        if (!artifact)
            return;
        const key = `${artifact.source}:${artifact.kind}:${artifact.ref}`;
        if (seen.has(key))
            return;
        seen.add(key);
        artifacts.push(artifact);
    };
    for (const raw of findArtifactArrays(item.metadata)) {
        for (const value of raw)
            push(toArtifactRef(value, 'work_request'));
    }
    for (const event of events) {
        const payload = objectValue(event.payload);
        if (!payload)
            continue;
        const callback = objectValue(payload['callback']);
        const callbackArtifacts = Array.isArray(callback?.['artifacts']) ? callback['artifacts'] : undefined;
        if (callbackArtifacts) {
            for (const value of callbackArtifacts)
                push(toArtifactRef(value, 'callback'));
        }
        for (const raw of findArtifactArrays(payload)) {
            for (const value of raw)
                push(toArtifactRef(value, event.type === 'agent.artifact_attached' ? 'callback' : 'event'));
        }
    }
    return artifacts;
}
function latestDispatchEvent(events) {
    return [...events]
        .filter((event) => event.type === 'agent.dispatch_requested' || event.type === 'agent.dispatch_acknowledged')
        .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))[0] ?? null;
}
function latestCallback(events) {
    for (const event of [...events].sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))) {
        const payload = objectValue(event.payload);
        const callback = objectValue(payload?.['callback']);
        const status = stringValue(callback?.['status']);
        if (status === 'accepted' || status === 'running' || status === 'succeeded' || status === 'failed' || status === 'cancelled') {
            return callback;
        }
    }
    return null;
}
function callbackProjection(state, label, callback) {
    return {
        state,
        label,
        ...(callback?.status ? { callback_status: callback.status } : {}),
        ...(callback?.concern_ref ? { concern_ref: callback.concern_ref } : {}),
        ...(callback?.error ? { detail: callback.error } : {}),
    };
}
function ackFromPayload(payload) {
    const direct = objectValue(payload?.['ack']);
    const nested = objectValue(payload?.['dispatch']);
    const candidate = direct ?? nested ?? payload;
    if (!candidate)
        return undefined;
    if (typeof candidate['ok'] !== 'boolean' && typeof candidate['accepted'] !== 'number' && typeof candidate['poll_ref'] !== 'string') {
        return undefined;
    }
    return {
        ok: typeof candidate['ok'] === 'boolean' ? candidate['ok'] : true,
        adapter: stringValue(candidate['adapter']) ?? 'unknown',
        ...(stringValue(candidate['concern_ref']) ? { concern_ref: stringValue(candidate['concern_ref']) } : {}),
        ...(numberValue(candidate['accepted']) !== undefined ? { accepted: numberValue(candidate['accepted']) } : {}),
        ...(stringValue(candidate['poll_ref']) ? { poll_ref: stringValue(candidate['poll_ref']) } : {}),
        ...(numberValue(candidate['status']) !== undefined ? { status: numberValue(candidate['status']) } : {}),
        ...(stringValue(candidate['error']) ? { error: stringValue(candidate['error']) } : {}),
    };
}
function findArtifactArrays(root) {
    const arrays = [];
    const visit = (value, depth) => {
        if (depth > 4)
            return;
        if (Array.isArray(value))
            return;
        const obj = objectValue(value);
        if (!obj)
            return;
        const raw = obj['artifacts'];
        if (Array.isArray(raw))
            arrays.push(raw);
        for (const key of ['work_request_payload', 'payload', 'capture', 'evidence', 'media']) {
            if (obj[key] !== undefined)
                visit(obj[key], depth + 1);
        }
    };
    visit(root, 0);
    return arrays;
}
function toArtifactRef(value, source) {
    const obj = objectValue(value);
    if (!obj)
        return null;
    const ref = stringValue(obj['ref']) ??
        stringValue(obj['url']) ??
        stringValue(obj['href']) ??
        stringValue(obj['path']) ??
        stringValue(obj['artifact_ref']) ??
        stringValue(obj['artifact_id']) ??
        stringValue(obj['id']);
    if (!ref)
        return null;
    const kind = stringValue(obj['kind']) ?? kindFromContentType(stringValue(obj['content_type']) ?? stringValue(obj['contentType'])) ?? 'artifact';
    const url = stringValue(obj['url']) ?? (ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('/') ? ref : undefined);
    return {
        kind,
        ref,
        ...(url ? { url } : {}),
        ...(stringValue(obj['content_type']) ?? stringValue(obj['contentType']) ? { content_type: stringValue(obj['content_type']) ?? stringValue(obj['contentType']) } : {}),
        ...(numberValue(obj['byte_size']) ?? numberValue(obj['byteSize']) ?? numberValue(obj['size']) !== undefined
            ? { byte_size: numberValue(obj['byte_size']) ?? numberValue(obj['byteSize']) ?? numberValue(obj['size']) }
            : {}),
        ...(numberValue(obj['duration_ms']) ?? numberValue(obj['durationMs']) !== undefined
            ? { duration_ms: numberValue(obj['duration_ms']) ?? numberValue(obj['durationMs']) }
            : {}),
        source,
    };
}
function kindFromContentType(contentType) {
    if (!contentType)
        return undefined;
    if (contentType.startsWith('image/'))
        return 'image';
    if (contentType.startsWith('audio/'))
        return 'audio';
    if (contentType.startsWith('video/'))
        return 'video';
    return undefined;
}
function objectValue(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}
function stringValue(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function numberValue(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function assertWorkQueueVocabularyCoherent() {
    for (const status of WORK_ITEM_STATUSES)
        columnForWorkItem({ status, lane: laneForStatus(status, 'triage') });
    for (const lane of WORK_ITEM_LANES) {
        if (!WORK_ITEM_LANE_LABELS[lane])
            throw new Error(`missing lane label: ${lane}`);
    }
    for (const severity of WORK_ITEM_SEVERITIES) {
        if (!WORK_ITEM_SEVERITY_LABELS[severity])
            throw new Error(`missing severity label: ${severity}`);
    }
}
//# sourceMappingURL=workqueue.js.map