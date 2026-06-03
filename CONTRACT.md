# projectkit contract — v1.2.0

> This is the published interface Agents B (testbeds) and C (flywheel) pin to.
> Pin a caret range: `"@operator/projectkit": "^0.3.0"` (package), contract
> semver `1.2.0`. Breaking the wire shape requires a major bump + a migration note here.

## The seam (one inversion)

```
 LAYER 3  TESTBEDS    chess · nhl · learn · sitelayer · winwar · sandolab
                      emit ProjectEvent / CaptureEnvelope via the SDK  (no mesh import)
                                │  publish
                                ▼
 LAYER 2  projectkit  ProjectEventEnvelope + Handoff  ── this package, imports NOTHING from cp/mesh
                                ▲  subscribe (one HttpSink, optional HMAC)
                                │
 LAYER 1  FLYWHEEL    control-plane + mesh   →  ONE subscriber, not the owner
```

**Invariant (enforced by `test/invariant.test.mjs`, fail-closed):** projectkit imports nothing
from control-plane, mesh, or `@operator/types`, and declares zero runtime dependencies.

## What a testbed (Agent B) does

```ts
import { createProjectSignal, HttpSink, NullSink } from '@operator/projectkit';

const url = process.env.SIGNAL_SINK_URL;            // mesh is just this URL
const sink = url
  ? new HttpSink({ url, sign: (body) => signHmac(body) })  // HMAC injected by the host, never baked in
  : new NullSink();                                  // unset → capture is OFF, app keeps working

export const signal = createProjectSignal({
  projectKey: 'chess',
  sink,
  defaults: { environment: process.env.NODE_ENV, build_sha: process.env.BUILD_SHA },
});

await signal.emit({ event_type: 'chess.drill.completed', outcome: 'succeeded', count: 3 });
```

The testbed depends ONLY on the contract — never on the subscriber existing. That is the decoupling.

## What the flywheel (Agent C) does

mesh stops owning the capture wire types. It exposes an ingest URL and validates inbound
envelopes against the published cross-language mirrors of `src/contract.ts`:
`schemas/project-event.schema.json` (the event wire) and
`schemas/capture-envelope.schema.json` (the capture wire). It is a subscriber:
replaceable, self-hostable, not in the project's dependency graph.

## ProjectEvent — required fields (v1.0.0)

| field | type | notes |
|---|---|---|
| `schema_version` | string | equals `1.0.0` at emit |
| `event_type` | string | project-namespaced wire literal, e.g. `nhl.lineup.saved` |
| `project_key` | string | OPEN string — no closed roster (the old `OPERATOR_CONTROLLED_PROJECTS` coupling is gone) |
| `occurred_at` | string | ISO-8601 |

All other fields (domain, outcome, attribution, entity, workflow, measurement, governance,
`payload`) are optional and additive. See `src/contract.ts` for the full list and
`schemas/project-event.schema.json` for the cross-language mirror.

## WorkRequest — v1.1.0

A `ProjectEvent` says *"this happened."* A `WorkRequest` says *"I, the testbed, am ASKING
for work."* This is the missing seam: before v1.1.0 the derivation of work from a capture
lived ENTIRELY inside mesh + the capture-task skill's untyped `operator_intent` decision
tree, so a testbed could only emit an event and HOPE a subscriber inferred intent. With
`WorkRequest` a testbed states the intent as a **typed field** and routes it through the
**same sink** — mesh stays just-a-URL, one replaceable subscriber that turns a request into
a task, never the owner of intent.

```ts
import { createProjectSignal, HttpSink } from '@operator/projectkit';

const signal = createProjectSignal({ projectKey: 'sitelayer', sink });

await signal.requestWork({
  request_ref: 'cap-9f3a',            // producer-stable idempotency key
  intent: 'capture-followup',         // TYPED — collapses the old operator_intent guesswork
  title: 'Takeoff scale overlay resets on reload',
  source_event_ref: 'delivery-abc',   // points back to the originating event/capture
  acceptance: ['scale persists across reload'],
});
```

`requestWork` travels as a `<project>.work.requested` `ProjectEvent` (domain
`workflow_event`, outcome `requested`) carrying the typed `WorkRequest` in
`payload.work_request`, so **no sink has to change**. A subscriber that understands work
requests reads that payload (or validates the standalone `WorkRequestEnvelope` from
`signal.buildWorkEnvelope([...])`, the Go-side wire mirror).

### WorkRequest — required fields

| field | type | notes |
|---|---|---|
| `schema_version` | string | equals `1.1.0` at emit (SDK-stamped) |
| `project_key` | string | OPEN string — no closed roster (SDK-stamped) |
| `requested_at` | string | ISO-8601 (SDK-stamped) |
| `request_ref` | string | producer-stable idempotency key — a subscriber dedupes on this |
| `intent` | string | `fix` \| `investigate` \| `replicate` \| `review` \| `research` \| `capture-followup` \| open fallback |
| `title` | string | short task title |

Optional: `summary`, `priority`, `route_path`, `entity_kind`, `entity_id`,
`source_event_ref`, `payload`, `sensitivity`, `acceptance[]`, `links[]`. See `src/work.ts`
for the full list and `schemas/work-request.schema.json` for the cross-language mirror.

> A `capture-followup` WorkRequest with `source_event_ref` collapses the capture-task
> skill's untyped `operator_intent` decision tree into a single typed field: the testbed
> declares the intent at the source instead of mesh re-deriving it downstream.

## CaptureEnvelope — required fields (v1.0.0)

The "tab-to-task" capture unit (a captured moment on a surface). Its TS shape is the
`CaptureEnvelope` interface in `src/contract.ts`; the cross-language mirror is
`schemas/capture-envelope.schema.json` (so a Go or Python producer — e.g. the operator
capture pipeline — validates against the same wire). Required: `schema_version`, `url`,
`page_title`, `captured_at`, `host_id`, `screenshot_ref`, `dom_excerpt`, `selected_text`,
`picked_element`, `network_captures`, `library_hints`, `operator_intent`, `sensitivity`.
`additionalProperties` is `true` (like the project-event mirror) so a producer that emits a
superset of attribution fields still validates; cp-boundary fields (`probe_data`,
`operator_context_inbound`) stay opaque.

## LogRecord — v1.2.0

A `ProjectEvent` says *"this happened"* and a `WorkRequest` says *"do this."* `LogRecord` is
the FIFTH capability: structured LOGGING as a first-class contract surface. Before v1.2.0 a
testbed had no published way to ship a structured log line to the flywheel — logging was
either dropped on the floor or stuffed, untyped, into a generic event payload. With
`LogRecord` a testbed emits a typed, **leveled**, redaction-aware log line and routes it
through the **same sink** — mesh stays just-a-URL, one replaceable subscriber, never the
owner of the log.

```ts
import { createProjectSignal, HttpSink, NullSink } from '@operator/projectkit';

const signal = createProjectSignal({ projectKey: 'sitelayer', sink });

await signal.log('error', 'QBO sync failed', { company: 'la-operations', code: 'E_TIMEOUT' });
await signal.log('info', 'takeoff scale calibrated', { sheet: 3 });
```

`log` travels as a `<project>.log` `ProjectEvent` (domain `diagnostic`, or `runtime_error`
for `error`/`fatal`) carrying the typed `LogRecord` in `payload.log_record`, so **no sink has
to change** and it is **inert under `NullSink`** (logging is off, the app keeps working). A
subscriber that understands logs reads that payload (or validates the standalone `LogEnvelope`
from `signal.buildLogEnvelope([...])`, the Go-side wire mirror).

### LogRecord — required fields

| field | type | notes |
|---|---|---|
| `schema_version` | string | equals `1.2.0` at emit (SDK-stamped) |
| `project_key` | string | OPEN string — no closed roster (SDK-stamped) |
| `occurred_at` | string | ISO-8601 (SDK-stamped) |
| `level` | string | `debug` \| `info` \| `warn` \| `error` \| `fatal` (CLOSED set — a routing primitive) |
| `message` | string | the human-readable log line |

Optional: `logger`, `source_surface`, `session_id`, `error_code`, `error_message`,
`fields` (structured context), `sensitivity`, `redaction_status`. See `src/log.ts` for the
full list and `schemas/log-record.schema.json` for the cross-language mirror.

## Handoff protocol — v1.0.0

A structured replacement for hand-written `~/projects/.<repo>-handoff-*.md`. Sections:
environment & hard rules → live state → immediate task → procedure → gotchas →
operator-gated → links. CLI: `handoff new|validate|show|resume`. `handoff resume <file>`
prints the paste-ready next-agent prompt derived from the structure.

## Versioning rules

- Additive (new optional field / new event literal) → minor.
- Breaking (rename/retype/remove a shipped field, change a literal's meaning) → major + a
  dated migration note appended below. Subscribers tolerate old + new across a rollout
  (expand/backfill/contract).

### Migration log
- `1.2.0` (2026-06-03) — ADDITIVE: add the LogRecord surface (`src/log.ts`: `LogLevel`,
  `LogRecord`, `LogEnvelope`, `validateLogRecord`) + `ProjectSignal.log(level, message, fields?)`
  routing through the same EventSink (inert under `NullSink`) + `signal.buildLogEnvelope` +
  `schemas/log-record.schema.json` Go-side mirror. LOGGING becomes a first-class contract
  surface — a testbed can ship a typed, leveled log line instead of dropping it or stuffing it
  untyped into an event payload. No existing field changed; subscribers tolerate `1.0.0`,
  `1.1.0`, and `1.2.0` (the project-event + work-request schemas' `contract_version` enums
  widened to include `1.2.0`). Package `0.2.0` → `0.3.0`.
- `1.1.0` (2026-06-03) — ADDITIVE: add the WorkRequest surface (`src/work.ts`:
  `WorkRequest`, `WorkRequestEnvelope`, `validateWorkRequest`) + `ProjectSignal.requestWork`
  routing through the same EventSink + `schemas/work-request.schema.json` Go-side mirror.
  A testbed can now REQUEST work through the contract instead of mesh + the capture-task
  skill deriving it from an untyped `operator_intent`. No existing field changed; subscribers
  tolerate `1.0.0` and `1.1.0` (the project-event schema's `contract_version` widened from a
  `const` to an `enum`). Package `0.1.0` → `0.2.0`.
- `1.0.0` (2026-06-03) — initial extraction from `@operator/types` capture surface. `project_key`
  is now an open string (no roster). cp-boundary fields (`probe_data`, `operator_context_inbound`)
  are opaque `unknown` so the project-facing contract does not drag in the mesh integration types.
- `1.0.0` (2026-06-03, additive/no wire change) — published `schemas/capture-envelope.schema.json`
  so `CaptureEnvelope` (already owned in `src/contract.ts`) has ONE cross-language wire, matching
  the existing project-event mirror. No type changed; this only gives non-JS producers a single
  schema to validate against. The operator capture pipeline (`capture/lib/capture_envelope.py`)
  repoints its validator here from the stale `operator-types` copy.
