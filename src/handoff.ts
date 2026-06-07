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

export const HANDOFF_VERSION = '1.0.0' as const;

export interface HandoffEnvironment {
  /** Repo path or name, e.g. "/path/to/repo" or "myorg/myrepo". */
  repo?: string;
  remote?: string;
  /** Non-negotiable rules the next agent must obey (HOME prefix, no-prod, …). */
  hard_rules: string[];
}

export interface HandoffTask {
  title: string;
  /** Ordered, copy-pasteable steps. */
  steps: string[];
}

export type GotchaSeverity = 'info' | 'warn' | 'blocker';

export interface HandoffGotcha {
  note: string;
  severity?: GotchaSeverity;
}

export interface HandoffLink {
  label: string;
  /** A path, URL, file:line, ticket, or doc ref. */
  ref: string;
}

export interface Handoff {
  handoff_version: string;
  /** Emitting project. Open string — same key space as the event contract. */
  project_key: string;
  title: string;
  /** ISO-8601 creation time. */
  created_at: string;
  from_agent?: string;
  /** One-paragraph "where we are / what you're taking over". */
  summary: string;
  environment: HandoffEnvironment;
  /** Verifiable current-state bullets (SHAs, live URLs, what's landed). */
  live_state: string[];
  /** The single next action, if there is an obvious one. */
  immediate_task?: HandoffTask;
  /** The repeatable build→verify→land procedure for this repo. */
  procedure?: string[];
  gotchas: HandoffGotcha[];
  /** Things that need the operator's explicit go — do NOT do blindly. */
  operator_gated?: string[];
  links?: HandoffLink[];
  /**
   * Optional explicit paste-ready prompt. If omitted, handoffToResumePrompt()
   * derives one from the structure.
   */
  resume_prompt?: string;
}

/** Validate a Handoff. Returns problems; empty == valid. */
export function validateHandoff(o: unknown): string[] {
  const problems: string[] = [];
  if (typeof o !== 'object' || o === null) return ['handoff is not an object'];
  const h = o as Record<string, unknown>;
  const reqStr = (k: string) => {
    if (typeof h[k] !== 'string' || (h[k] as string).length === 0) problems.push(`missing/invalid string: ${k}`);
  };
  reqStr('handoff_version');
  reqStr('project_key');
  reqStr('title');
  reqStr('created_at');
  reqStr('summary');
  if (typeof h['created_at'] === 'string' && Number.isNaN(Date.parse(h['created_at'] as string))) {
    problems.push('created_at is not a parseable ISO-8601 timestamp');
  }
  const env = h['environment'] as Record<string, unknown> | undefined;
  if (!env || typeof env !== 'object') problems.push('missing environment');
  else if (!Array.isArray(env['hard_rules'])) problems.push('environment.hard_rules must be an array');
  if (!Array.isArray(h['live_state'])) problems.push('live_state must be an array');
  if (!Array.isArray(h['gotchas'])) problems.push('gotchas must be an array');
  return problems;
}

/** Canonical JSON serialization (stable key order via explicit pick). */
export function serializeHandoff(h: Handoff): string {
  return JSON.stringify(h, null, 2) + '\n';
}

/** Parse + validate. Throws on invalid input. */
export function parseHandoff(json: string): Handoff {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (err) {
    throw new Error(`handoff is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const problems = validateHandoff(obj);
  if (problems.length > 0) throw new Error(`invalid handoff: ${problems.join('; ')}`);
  return obj as Handoff;
}

/** Render the human-readable markdown view (replaces the hand-written .md). */
export function handoffToMarkdown(h: Handoff): string {
  const lines: string[] = [];
  lines.push(`# ${h.title}`, '');
  lines.push(h.summary, '');
  lines.push(`> Handoff v${h.handoff_version} · project \`${h.project_key}\`` +
    (h.from_agent ? ` · from ${h.from_agent}` : '') + ` · ${h.created_at}`, '');

  lines.push('## 0. Environment & hard rules');
  if (h.environment.repo) lines.push(`- Repo: \`${h.environment.repo}\`` + (h.environment.remote ? ` (${h.environment.remote})` : ''));
  for (const r of h.environment.hard_rules) lines.push(`- ${r}`);
  lines.push('');

  lines.push('## 1. Live state');
  for (const s of h.live_state) lines.push(`- ${s}`);
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
    for (const o of h.operator_gated) lines.push(`- ${o}`);
    lines.push('');
  }

  if (h.links && h.links.length) {
    lines.push('## Links');
    for (const l of h.links) lines.push(`- ${l.label}: ${l.ref}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Derive the paste-ready prompt the operator hands to the next agent. */
export function handoffToResumePrompt(h: Handoff): string {
  if (h.resume_prompt) return h.resume_prompt;
  const parts: string[] = [];
  parts.push(`You are taking over ${h.title} (project: ${h.project_key}). ${h.summary}`);
  if (h.environment.hard_rules.length) {
    parts.push('\nHARD RULES (obey exactly):\n' + h.environment.hard_rules.map((r) => `- ${r}`).join('\n'));
  }
  if (h.live_state.length) {
    parts.push('\nLIVE STATE:\n' + h.live_state.map((s) => `- ${s}`).join('\n'));
  }
  if (h.immediate_task) {
    parts.push(
      `\nDO THIS FIRST — ${h.immediate_task.title}:\n` +
        h.immediate_task.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    );
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
export function newHandoff(project_key: string, title: string, now: () => string = () => new Date().toISOString()): Handoff {
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
