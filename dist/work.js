/**
 * projectkit — the WORK-REQUEST surface (v1.1.0).
 *
 * A `ProjectEvent` says "this happened". A `WorkRequest` says "I, the testbed,
 * am ASKING for work to be done". This is the missing contract surface: before
 * v1.1.0 the derivation of work from a capture lived ENTIRELY inside mesh + the
 * capture-task skill's untyped `operator_intent` decision tree. A testbed could
 * not REQUEST work through the contract; it could only emit an event and hope a
 * subscriber inferred intent. With `WorkRequest`, a testbed states the intent
 * as a TYPED field and routes it through the SAME sink — mesh stays just-a-URL.
 *
 * Same invariants as the rest of projectkit: imports NOTHING from control-plane,
 * mesh, or @operator/types; pure + dependency-free. mesh is ONE possible
 * subscriber that turns a WorkRequest into a task — never the owner of intent.
 *
 * Wire stability rule: once an intent literal or field has shipped, do NOT
 * change its meaning. Add a new optional field / new literal and bump
 * CONTRACT_VERSION per semver. The companion JSON Schema
 * (schemas/work-request.schema.json) is the Go-side mirror.
 */
/**
 * Validate a WorkRequest against the contract. Returns a list of problems; an
 * empty list means valid. Pure, dependency-free — usable in a fail-closed
 * producer or a subscriber gate. Mirrors `validateProjectEvent`.
 */
export function validateWorkRequest(o) {
    const problems = [];
    if (typeof o !== 'object' || o === null)
        return ['work request is not an object'];
    const r = o;
    const reqString = (k) => {
        if (typeof r[k] !== 'string' || r[k].length === 0) {
            problems.push(`missing/invalid required string field: ${k}`);
        }
    };
    reqString('schema_version');
    reqString('project_key');
    reqString('requested_at');
    reqString('request_ref');
    reqString('intent');
    reqString('title');
    if (typeof r['requested_at'] === 'string' && Number.isNaN(Date.parse(r['requested_at']))) {
        problems.push('requested_at is not a parseable ISO-8601 timestamp');
    }
    for (const k of ['audience', 'assignee']) {
        if (r[k] !== undefined && (typeof r[k] !== 'string' || r[k].length === 0)) {
            problems.push(`${k}, when present, must be a non-empty string`);
        }
    }
    if (r['acceptance'] !== undefined) {
        if (!Array.isArray(r['acceptance']) || r['acceptance'].some((a) => typeof a !== 'string')) {
            problems.push('acceptance, when present, must be an array of strings');
        }
    }
    if (r['links'] !== undefined) {
        if (!Array.isArray(r['links']) || r['links'].some((a) => typeof a !== 'string')) {
            problems.push('links, when present, must be an array of strings');
        }
    }
    if (r['payload'] !== undefined && (typeof r['payload'] !== 'object' || r['payload'] === null)) {
        problems.push('payload, when present, must be an object');
    }
    return problems;
}
//# sourceMappingURL=work.js.map