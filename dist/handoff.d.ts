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
export declare const HANDOFF_VERSION: "1.0.0";
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
export declare function validateHandoff(o: unknown): string[];
/** Canonical JSON serialization (stable key order via explicit pick). */
export declare function serializeHandoff(h: Handoff): string;
/** Parse + validate. Throws on invalid input. */
export declare function parseHandoff(json: string): Handoff;
/** Render the human-readable markdown view (replaces the hand-written .md). */
export declare function handoffToMarkdown(h: Handoff): string;
/** Derive the paste-ready prompt the operator hands to the next agent. */
export declare function handoffToResumePrompt(h: Handoff): string;
/** Convenience: a minimal valid Handoff scaffold. */
export declare function newHandoff(project_key: string, title: string, now?: () => string): Handoff;
//# sourceMappingURL=handoff.d.ts.map