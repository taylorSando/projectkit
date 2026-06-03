/**
 * projectkit — the LOG surface (v1.2.0).
 *
 * A `ProjectEvent` says "this happened" and a `WorkRequest` says "do this".
 * `LogRecord` is the FIFTH capability: structured LOGGING as a first-class
 * contract surface. Before v1.2.0 there was no published way for a testbed to
 * ship a structured log line to the flywheel — logging was either dropped on
 * the floor or stuffed, untyped, into a generic event payload. With
 * `LogRecord` a testbed emits a typed, leveled, redaction-aware log line and
 * routes it through the SAME EventSink — mesh stays just-a-URL, one replaceable
 * subscriber, never the owner.
 *
 * Same invariants as the rest of projectkit: imports NOTHING from control-plane,
 * mesh, or @operator/types; pure + dependency-free. mesh is ONE possible
 * subscriber that ingests a LogRecord — never the owner of the log.
 *
 * Wire stability rule: once a level literal or field has shipped, do NOT change
 * its meaning. Add a new optional field / new literal and bump CONTRACT_VERSION
 * per semver. The companion JSON Schema (schemas/log-record.schema.json) is the
 * Go-side mirror.
 */

import type { ProjectKey, Sensitivity, RedactionStatus } from './contract.js';

/**
 * Severity of a log line. A CLOSED, ordered set so a subscriber can threshold
 * (e.g. ship `warn` and above). No open string fallback: a level is a routing
 * primitive, not a project-specific extra — keep it narrow.
 *
 * - `debug` — verbose, dev-only diagnostics.
 * - `info`  — normal operational signal.
 * - `warn`  — something unexpected but recoverable.
 * - `error` — an operation failed.
 * - `fatal` — unrecoverable; the surface/process is going down.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * `LogRecord` — one structured log line a testbed emits through the contract.
 * The common fields give a subscriber enough to threshold, attribute, and
 * correlate a log line WITHOUT knowing the project internally.
 */
export interface LogRecord {
  /** Equals CONTRACT_VERSION at emit time. A subscriber narrows on this. */
  schema_version: string;
  /** Emitting project. Open string — no closed roster. */
  project_key: ProjectKey;
  /** ISO-8601 timestamp the log line occurred. */
  occurred_at: string;
  /** Severity. Subscribers threshold on this. */
  level: LogLevel;
  /** The human-readable log message. */
  message: string;

  // --- attribution / correlation ----------------------------------------
  /** Logical logger/module name, e.g. "worker.qbo" or "ui.takeoff". */
  logger?: string;
  /** Where in the testbed the log originated (route, surface, subsystem). */
  source_surface?: string;
  /** Correlates a series of log lines to one session/request. */
  session_id?: string;

  // --- error detail ------------------------------------------------------
  /** Stable machine code for an error log (level error/fatal), e.g. "E_TIMEOUT". */
  error_code?: string;
  /** Human-readable error detail accompanying error_code. */
  error_message?: string;

  // --- structured extras -------------------------------------------------
  /** Structured key/value context a subscriber may index. Keep it small + flat. */
  fields?: Record<string, unknown>;

  // --- governance --------------------------------------------------------
  sensitivity?: Sensitivity;
  redaction_status?: RedactionStatus;
}

/**
 * `LogEnvelope` — the transport wrapper for one or more log records. Mirrors
 * `ProjectEventEnvelope` / `WorkRequestEnvelope`: a sink delivers it; a
 * subscriber acknowledges it. `contract_version` is what subscribers pin to.
 */
export interface LogEnvelope {
  contract_version: string;
  project_key: ProjectKey;
  /** ISO-8601 when the batch was flushed by the producer. */
  emitted_at: string;
  producer: { name: string; version?: string };
  records: LogRecord[];
  /** Optional idempotency key so a subscriber can dedupe retries. */
  delivery_id?: string;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'fatal'];

/**
 * Validate a LogRecord against the contract. Returns a list of problems; an
 * empty list means valid. Pure, dependency-free — usable in a fail-closed
 * producer or a subscriber gate. Mirrors `validateProjectEvent`.
 */
export function validateLogRecord(o: unknown): string[] {
  const problems: string[] = [];
  if (typeof o !== 'object' || o === null) return ['log record is not an object'];
  const r = o as Record<string, unknown>;
  const reqString = (k: string) => {
    if (typeof r[k] !== 'string' || (r[k] as string).length === 0) {
      problems.push(`missing/invalid required string field: ${k}`);
    }
  };
  reqString('schema_version');
  reqString('project_key');
  reqString('occurred_at');
  reqString('level');
  reqString('message');
  if (typeof r['occurred_at'] === 'string' && Number.isNaN(Date.parse(r['occurred_at'] as string))) {
    problems.push('occurred_at is not a parseable ISO-8601 timestamp');
  }
  if (typeof r['level'] === 'string' && !LOG_LEVELS.includes(r['level'] as LogLevel)) {
    problems.push(`level must be one of: ${LOG_LEVELS.join(', ')}`);
  }
  if (r['fields'] !== undefined && (typeof r['fields'] !== 'object' || r['fields'] === null)) {
    problems.push('fields, when present, must be an object');
  }
  return problems;
}
