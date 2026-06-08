/**
 * projectkit — the context-handoff protocol.
 *
 * Today an agent hands off by writing a markdown file by hand (e.g.
 * `.<project>-handoff-<date>.md`) and the operator pastes a
 * prompt. This productizes that: a structured, validatable Handoff that any
 * agent in any repo can emit and the next agent can ingest + resume — with a
 * deterministic `resume_prompt` derived from the structure.
 *
 * The section model is lifted directly from the real artifacts:
 *   environment & hard rules → live state → immediate task → proven procedure
 *   → gotchas → operator-gated follow-ups → links.
 *
 * Dependency-free and self-contained, like the rest of the contract.
 */
export const HANDOFF_VERSION = '1.0.0';
/** Validate a Handoff. Returns problems; empty == valid. */
export function validateHandoff(o) {
    const problems = [];
    if (typeof o !== 'object' || o === null)
        return ['handoff is not an object'];
    const h = o;
    const reqStr = (k) => {
        if (typeof h[k] !== 'string' || h[k].length === 0)
            problems.push(`missing/invalid string: ${k}`);
    };
    reqStr('handoff_version');
    reqStr('project_key');
    reqStr('title');
    reqStr('created_at');
    reqStr('summary');
    if (typeof h['created_at'] === 'string' && Number.isNaN(Date.parse(h['created_at']))) {
        problems.push('created_at is not a parseable ISO-8601 timestamp');
    }
    const env = h['environment'];
    if (!env || typeof env !== 'object')
        problems.push('missing environment');
    else if (!Array.isArray(env['hard_rules']))
        problems.push('environment.hard_rules must be an array');
    if (!Array.isArray(h['live_state']))
        problems.push('live_state must be an array');
    if (!Array.isArray(h['gotchas']))
        problems.push('gotchas must be an array');
    return problems;
}
/** Canonical JSON serialization (stable key order via explicit pick). */
export function serializeHandoff(h) {
    return JSON.stringify(h, null, 2) + '\n';
}
/** Parse + validate. Throws on invalid input. */
export function parseHandoff(json) {
    let obj;
    try {
        obj = JSON.parse(json);
    }
    catch (err) {
        throw new Error(`handoff is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const problems = validateHandoff(obj);
    if (problems.length > 0)
        throw new Error(`invalid handoff: ${problems.join('; ')}`);
    return obj;
}
/** Render the human-readable markdown view (replaces the hand-written .md). */
export function handoffToMarkdown(h) {
    const lines = [];
    lines.push(`# ${h.title}`, '');
    lines.push(h.summary, '');
    lines.push(`> Handoff v${h.handoff_version} · project \`${h.project_key}\`` +
        (h.from_agent ? ` · from ${h.from_agent}` : '') + ` · ${h.created_at}`, '');
    lines.push('## 0. Environment & hard rules');
    if (h.environment.repo)
        lines.push(`- Repo: \`${h.environment.repo}\`` + (h.environment.remote ? ` (${h.environment.remote})` : ''));
    for (const r of h.environment.hard_rules)
        lines.push(`- ${r}`);
    lines.push('');
    lines.push('## 1. Live state');
    for (const s of h.live_state)
        lines.push(`- ${s}`);
    lines.push('');
    if (h.immediate_task) {
        lines.push(`## 2. Immediate task — ${h.immediate_task.title}`);
        h.immediate_task.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
        lines.push('');
    }
    if (h.procedure && h.procedure.length) {
        lines.push('## 3. Procedure');
        h.procedure.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
        lines.push('');
    }
    lines.push('## 4. Gotchas');
    for (const g of h.gotchas) {
        const tag = g.severity && g.severity !== 'info' ? `**[${g.severity.toUpperCase()}]** ` : '';
        lines.push(`- ${tag}${g.note}`);
    }
    lines.push('');
    if (h.operator_gated && h.operator_gated.length) {
        lines.push('## 5. Operator-gated (do NOT do blindly)');
        for (const o of h.operator_gated)
            lines.push(`- ${o}`);
        lines.push('');
    }
    if (h.links && h.links.length) {
        lines.push('## Links');
        for (const l of h.links)
            lines.push(`- ${l.label}: ${l.ref}`);
        lines.push('');
    }
    return lines.join('\n');
}
/** Derive the paste-ready prompt the operator hands to the next agent. */
export function handoffToResumePrompt(h) {
    if (h.resume_prompt)
        return h.resume_prompt;
    const parts = [];
    parts.push(`You are taking over ${h.title} (project: ${h.project_key}). ${h.summary}`);
    if (h.environment.hard_rules.length) {
        parts.push('\nHARD RULES (obey exactly):\n' + h.environment.hard_rules.map((r) => `- ${r}`).join('\n'));
    }
    if (h.live_state.length) {
        parts.push('\nLIVE STATE:\n' + h.live_state.map((s) => `- ${s}`).join('\n'));
    }
    if (h.immediate_task) {
        parts.push(`\nDO THIS FIRST — ${h.immediate_task.title}:\n` +
            h.immediate_task.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'));
    }
    if (h.gotchas.length) {
        parts.push('\nGOTCHAS:\n' + h.gotchas.map((g) => `- ${g.severity ? `[${g.severity}] ` : ''}${g.note}`).join('\n'));
    }
    if (h.operator_gated && h.operator_gated.length) {
        parts.push('\nOPERATOR-GATED (do NOT do without the user saying so):\n' + h.operator_gated.map((o) => `- ${o}`).join('\n'));
    }
    return parts.join('\n');
}
/** Convenience: a minimal valid Handoff scaffold. */
export function newHandoff(project_key, title, now = () => new Date().toISOString()) {
    return {
        handoff_version: HANDOFF_VERSION,
        project_key,
        title,
        created_at: now(),
        summary: '',
        environment: { hard_rules: [] },
        live_state: [],
        gotchas: [],
    };
}
//# sourceMappingURL=handoff.js.map