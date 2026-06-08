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
const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'];
/**
 * Validate a LogRecord against the contract. Returns a list of problems; an
 * empty list means valid. Pure, dependency-free — usable in a fail-closed
 * producer or a subscriber gate. Mirrors `validateProjectEvent`.
 */
export function validateLogRecord(o) {
    const problems = [];
    if (typeof o !== 'object' || o === null)
        return ['log record is not an object'];
    const r = o;
    const reqString = (k) => {
        if (typeof r[k] !== 'string' || r[k].length === 0) {
            problems.push(`missing/invalid required string field: ${k}`);
        }
    };
    reqString('schema_version');
    reqString('project_key');
    reqString('occurred_at');
    reqString('level');
    reqString('message');
    if (typeof r['occurred_at'] === 'string' && Number.isNaN(Date.parse(r['occurred_at']))) {
        problems.push('occurred_at is not a parseable ISO-8601 timestamp');
    }
    if (typeof r['level'] === 'string' && !LOG_LEVELS.includes(r['level'])) {
        problems.push(`level must be one of: ${LOG_LEVELS.join(', ')}`);
    }
    if (r['fields'] !== undefined && (typeof r['fields'] !== 'object' || r['fields'] === null)) {
        problems.push('fields, when present, must be an object');
    }
    return problems;
}
//# sourceMappingURL=log.js.map