/**
 * projectkit — the project-facing event + capture contract.
 *
 * This is the published interface that TESTBED projects (chess, nhl, learn,
 * sitelayer, winwar, sandolab, …) emit through. It is intentionally
 * SELF-CONTAINED: it imports nothing — not control-plane, not mesh, not
 * @operator/types. mesh is just one possible subscriber/sink (see ./sink).
 *
 * Wire stability rule: once a field or event-type literal has shipped, do
 * NOT change its meaning. Add a new optional field / new literal instead and
 * bump CONTRACT_VERSION per semver. The companion JSON Schema
 * (schemas/project-event.schema.json) is the cross-language mirror so a Go
 * subscriber (mesh) validates against the same shape.
 */
/** Semver of this contract. Subscribers pin a `^` range; producers stamp it on every event. */
export const CONTRACT_VERSION = '1.4.0';
/**
 * Validate a ProjectEvent against the contract. Returns a list of problems;
 * an empty list means valid. Pure, dependency-free — usable in a fail-closed
 * producer or a subscriber gate.
 */
export function validateProjectEvent(e) {
    const problems = [];
    if (typeof e !== 'object' || e === null)
        return ['event is not an object'];
    const ev = e;
    const reqString = (k) => {
        if (typeof ev[k] !== 'string' || ev[k].length === 0) {
            problems.push(`missing/invalid required string field: ${k}`);
        }
    };
    reqString('schema_version');
    reqString('event_type');
    reqString('project_key');
    reqString('occurred_at');
    if (typeof ev['occurred_at'] === 'string' && Number.isNaN(Date.parse(ev['occurred_at']))) {
        problems.push('occurred_at is not a parseable ISO-8601 timestamp');
    }
    if (ev['payload'] !== undefined && (typeof ev['payload'] !== 'object' || ev['payload'] === null)) {
        problems.push('payload, when present, must be an object');
    }
    return problems;
}
//# sourceMappingURL=contract.js.map