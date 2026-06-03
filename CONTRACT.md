# projectkit contract — v1.1.0

> This is the published interface Agents B (testbeds) and C (flywheel) pin to.
> Pin a caret range: `"@operator/projectkit": "^0.2.0"` (package), contract
> semver `1.1.0`. Breaking the wire shape requires a major bump + a migration note here.

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
envelopes against `schemas/project-event.schema.json` (the Go-side mirror of `src/contract.ts`).
It is a subscriber: replaceable, self-hostable, not in the project's dependency graph.

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
