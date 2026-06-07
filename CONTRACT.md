# projectkit contract — v1.3.0

> This is the published interface Agents B (testbeds) and C (flywheel) pin to.
> Pin a caret range: `"@operator/projectkit": "^0.4.0"` (package), contract
> semver `1.3.0`. Breaking the wire shape requires a major bump + a migration note here.

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

## Concern / Dispatch / Callback — v1.3.0

Every surface above is **EMIT-direction**: a testbed says *"this happened"* (`ProjectEvent`),
*"do this"* (`WorkRequest`), or *"log this"* (`LogRecord`) and FORGETS — fire-and-forget
through an `EventSink`. v1.3.0 adds the **DISPATCH direction**: the OTHER half of the
**One-Line Boundary Test**. A testbed DISPATCHES a unit of work for execution and receives a
`Callback` result back. Before v1.3.0 this lived ENTIRELY inside each testbed's own
mesh-shaped routes — nhl's `/api/nhl/dispatch` + `/api/workflows` polling, sitelayer's
mesh-dispatcher — so **mesh was the baked-in owner of dispatch and poll**. With `Concern` /
`DispatchEnvelope` / `Callback` a testbed dispatches through a sink-agnostic `DispatchAdapter`,
so **mesh becomes ONE swappable dispatch adapter** behind a URL, exactly like `EventSink` made
mesh one sink.

**The boundary test:** a testbed can swap mesh for ANOTHER `DispatchAdapter` (a local
executor, a different fleet, a `NullDispatchAdapter`) WITHOUT changing the `Concern` /
`DispatchEnvelope` / `Callback` shapes it produces and consumes. mesh is never in the
testbed's dependency graph — that is the seam.

```ts
import { createProjectSignal, HttpDispatchAdapter, NullDispatchAdapter } from '@operator/projectkit';

const dispatchUrl = process.env.DISPATCH_ADAPTER_URL;   // mesh is just this URL
const signal = createProjectSignal({
  projectKey: 'nhl',
  sink,                                                  // emit direction (unchanged)
  dispatchAdapter: dispatchUrl
    ? new HttpDispatchAdapter({ url: dispatchUrl, sign: (body) => signHmac(body) })  // HMAC injected
    : new NullDispatchAdapter(),                         // unset → dispatch is OFF, app keeps working
});

const ack = await signal.dispatch({
  concern_ref: 'lineup-opt-9f3a',         // producer-stable idempotency key; keys the Callback back
  kind: 'execute',                        // open string: execute | research | review
  title: 'Optimize tonight\'s lineup',
  inputs: { slate: '2026-06-03' },
  callback: { mode: 'poll' },             // or { url, mode: 'webhook' }
});
// ack.poll_ref (poll mode) or a later Callback POST (webhook mode) carries the result.
```

`dispatch`/`dispatchBatch` route a `DispatchEnvelope` (the Go-side wire mirror is
`signal.buildDispatchEnvelope([...])`) through the injected `DispatchAdapter`. The eventual
RESULT arrives as a `Callback` (validated with `validateCallback`), keyed by `concern_ref`.
`emit` / `log` / `requestWork` are unchanged; dispatch is **inert under the default
`NullDispatchAdapter`** (dispatch off, the app keeps working).

### Concern — required fields

| field | type | notes |
|---|---|---|
| `schema_version` | string | equals `1.3.0` at dispatch (SDK-stamped) |
| `project_key` | string | OPEN string — no closed roster (SDK-stamped) |
| `dispatched_at` | string | ISO-8601 (SDK-stamped) |
| `concern_ref` | string | producer-stable idempotency key — adapter dedupes + keys the Callback back |
| `kind` | string | open string; well-known `execute` \| `research` \| `review` |
| `title` | string | short title for the unit of work |

Optional: `summary`, `inputs` (object map), `callback` (`{ url?, mode? }` where `mode` is
`webhook` \| `poll` \| open), `priority`, `source_event_ref`, `sensitivity`. See `src/dispatch.ts`
and `schemas/concern.schema.json` (the `DispatchEnvelope` cross-language mirror).

### Callback — required fields

| field | type | notes |
|---|---|---|
| `schema_version` | string | equals `1.3.0` at callback |
| `concern_ref` | string | the Concern this is the result for |
| `status` | string | `accepted` \| `running` \| `succeeded` \| `failed` \| `cancelled` (CLOSED set) |

Optional: `outputs` (object map), `artifacts[]` (`{ kind, ref }`), `error`, `completed_at`. See
`src/dispatch.ts` and `schemas/callback.schema.json` for the cross-language mirror.

`HttpDispatchAdapter` (POSTs the `DispatchEnvelope` to a URL, HMAC injected) and
`NullDispatchAdapter` (accepts + drops) are the dispatch-side analogues of `HttpSink` and
`NullSink`. `MemoryDispatchAdapter` collects in memory for tests. `mesh` is just one
`HttpDispatchAdapter`.

## Artifact sinks — where dock MEDIA goes (v1.4.0)

`EventSink` is where structured EVENTS go; `ArtifactSink` is where capture-dock MEDIA
(audio/video/screenshots) goes. An `Artifact` is `{ kind, sessionId, contentType, bytes
(Uint8Array) | ref, metadata? }`; `put(artifact)` returns an `ArtifactSinkResult`
(`{ ok, sink, ref?, status?, error? }`) mirroring `SinkResult` conventions.

- `NullArtifactSink` — persists nothing, returns the inline ref `inline:<kind>:<sessionId>`.
  This formalizes today's dock default and is **capture-off-safe**: the dock keeps working
  with no blob store wired.
- `HttpArtifactSink` — PUTs (or POSTs) the raw bytes to a configurable blob-store URL,
  content-type from the artifact, with HMAC/auth INJECTED via `sign` (never baked in) and a
  `timeoutMs` default of 8000 — exactly like `HttpSink`. `mesh` is just one `HttpArtifactSink`.
- `MemoryArtifactSink` / `FanoutArtifactSink` are the test / tee analogues of `MemorySink` /
  `FanoutSink`.

See `src/artifact-sink.ts`. Browser-safe (uses only `fetch`/`Uint8Array`), so it is exported
from the package root and also from the `@operator/projectkit/artifact-sink` subpath.

## Handoff protocol — v1.0.0

A structured replacement for hand-written `.<repo>-handoff-*.md` files. Sections:
environment & hard rules → live state → immediate task → procedure → gotchas →
operator-gated → links. CLI: `handoff new|validate|show|resume`. `handoff resume <file>`
prints the paste-ready next-agent prompt derived from the structure.

## Versioning rules

- Additive (new optional field / new event literal) → minor.
- Breaking (rename/retype/remove a shipped field, change a literal's meaning) → major + a
  dated migration note appended below. Subscribers tolerate old + new across a rollout
  (expand/backfill/contract).

### Migration log
- `1.4.0` (2026-06-06) — ADDITIVE: add the ARTIFACT-SINK surface (`src/artifact-sink.ts`:
  `Artifact`, `ArtifactSink`, `ArtifactSinkResult`, `inlineArtifactRef`, plus
  `NullArtifactSink` / `MemoryArtifactSink` / `HttpArtifactSink` / `FanoutArtifactSink` and
  `HttpArtifactSinkOptions`), re-exported from the package root and the
  `@operator/projectkit/artifact-sink` subpath. This is the MEDIA analogue of `EventSink`:
  the capture dock can now STORE blob media (audio/video/screenshots) through a sink-agnostic
  `ArtifactSink` instead of only returning the inline ref `inline:<kind>:<sessionId>`.
  `NullArtifactSink` formalizes that inline-ref default (capture-off-safe); `HttpArtifactSink`
  PUTs/POSTs bytes to a configurable blob store with HMAC injected via `sign` (never baked in),
  so mesh becomes ONE swappable artifact sink, exactly as it is one `EventSink`. No existing
  field, type, or behavior changed; the fail-closed invariant covers the new file (zero runtime
  deps, no mesh/control-plane/@operator/types import). Package `0.5.1` → `0.6.0`.
- `1.3.0` (2026-06-03) — ADDITIVE: add the DISPATCH-DIRECTION surface (`src/dispatch.ts`:
  `Concern`, `DispatchEnvelope`, `Ack`, `Callback`, `CallbackArtifact`, `DispatchAdapter`,
  `validateConcern`, `validateCallback`, plus `HttpDispatchAdapter` / `NullDispatchAdapter` /
  `MemoryDispatchAdapter`) + `ProjectSignal.dispatch` / `dispatchBatch` / `buildDispatchEnvelope`
  routed through an injected `DispatchAdapter` (config `dispatchAdapter`, default
  `NullDispatchAdapter`, inert until a host wires one) + `schemas/concern.schema.json` +
  `schemas/callback.schema.json` Go-side mirrors. This is the OTHER half of the One-Line Boundary
  Test: a testbed dispatches a unit of work for execution and gets a Callback result, so mesh
  becomes ONE swappable dispatch adapter instead of owning the dispatch/poll routes (nhl
  `/api/nhl/dispatch` + `/api/workflows`, sitelayer mesh-dispatcher). `emit` / `log` / `requestWork`
  unchanged. No existing field changed; subscribers tolerate `1.0.0`–`1.3.0` (the project-event +
  work-request schemas' `contract_version` enums widened to include `1.3.0`). Package `0.3.0` → `0.4.0`.
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
