# @operator/projectkit

**The standalone project-signal interface.** Turns any repo into a *testbed* that emits
work for an agent fleet — through a clean, published contract that is **not** wired into
control-plane or mesh.

It is the missing runtime half of the decoupling: where `@operator/types` is the cp/mesh
boundary contract, `projectkit` is the **project-facing** capability — the event contract,
a sink-agnostic emitter SDK, and the context-handoff protocol — owning **nothing** of mesh.

```
 testbeds (chess, nhl, learn, sitelayer, winwar, sandolab)
     │  emit ProjectEvent / CaptureEnvelope        ← import @operator/projectkit (no mesh)
     ▼
 projectkit  ── the contract + SDK + handoff       ← imports nothing from cp/mesh (fail-closed test)
     ▲  subscribe (one HttpSink, optional HMAC)
     │
 control-plane + mesh   ── one subscriber, replaceable, self-hostable
```

## Depend on this (testbeds + mesh)

This package is **not published to a registry** — it's consumed as a **git-tag dependency**
(stays private + git-based, no npm/registry infra). Pin a Bitbucket tag in the consumer's
`package.json`:

```jsonc
// package.json
"dependencies": {
  "@operator/projectkit": "bitbucket:taylor_sando/projectkit#v0.9.2"
}
```

```sh
npm install   # the `prepare` script builds dist/ on install (git deps run prepare, not prepack)
```

Use **`#v0.5.1` or later** for git-dep consumption — earlier tags lack the `prepare`
hook, so `dist/` wouldn't build on install. All 6 testbeds
(chess/nhl/learn/sitelayer/winwar/sandolab) currently pin **`#v0.9.0`** (carries
`CONTRACT_VERSION 1.4.0` — addressed dispatch via `audience`/`assignee`/`acceptance`,
machine-readable Callback results — plus `bin/pull-executor.mjs`); the latest tag is
**`v0.9.2`** (`v0.9.1` fixes the npx binstub entry check; `v0.9.2` rejects
whitespace-only refs, no wire change). Subscribers narrow on `contract_version`, so a
consumer on an older tag keeps working — mesh already ingests `1.0.0` through `1.4.0`.

## Build it (developing projectkit itself)

```sh
npm install      # zero runtime deps; typescript is the only devDep
npm run build    # tsc → dist/
npm test         # build + node --test (contract + fail-closed invariant)
```

## Use it (a testbed)

```ts
import { createProjectSignal, HttpSink, NullSink } from '@operator/projectkit';

const url = process.env.SIGNAL_SINK_URL;                       // mesh is just a URL
const signal = createProjectSignal({
  projectKey: 'chess',
  sink: url ? new HttpSink({ url, sign: signHmac }) : new NullSink(),
});

await signal.emit({ event_type: 'chess.drill.completed', outcome: 'succeeded' });
```

`SIGNAL_SINK_URL` unset ⇒ `NullSink` ⇒ capture off, app unaffected. The project never
depends on the subscriber being present.

## Handoff protocol (replaces the hand-written `.md` ritual)

```sh
npx handoff new --project sitelayer --out handoff.json   # scaffold a structured handoff
npx handoff validate handoff.json                        # schema-check it
npx handoff show handoff.json                            # render the human markdown view
npx handoff resume handoff.json                          # print the paste-ready next-agent prompt
```

## local-executor (a second REAL dispatch backend)

`bin/local-executor.mjs` is a standalone, zero-dependency HTTP executor for the
DISPATCH-direction contract — the non-mesh backend that makes the One-Line
Boundary Test executable against something real. It speaks the same two routes
mesh's door speaks (`POST /api/projectkit/concerns`, `GET
/api/projectkit/concerns/:pollRef`), but instead of minting a task it REALLY
RUNS each accepted Concern as a local one-shot process and drives the Callback
through `accepted → running → succeeded|failed` with the process's real output.

```sh
npx local-executor                                  # PORT=8790, safe echo stub
LOCAL_EXECUTOR_CMD='claude -p "$CONCERN_TITLE — $CONCERN_SUMMARY"' npx local-executor
```

Point any testbed at it by changing ONE url (e.g.
`MESH_CONCERN_DISPATCH_URL=http://127.0.0.1:8790/api/projectkit/concerns`) —
the Concern / Ack / Callback shapes do not change. The executor command gets
the Concern via env (`CONCERN_REF/KIND/TITLE/SUMMARY/PROJECT_KEY/INPUTS_JSON`)
and the full Concern JSON on stdin; exit 0 ⇒ `succeeded`, non-zero ⇒ `failed`;
a stdout line `::artifact::<kind>::<ref>` becomes a `CallbackArtifact`.
Idempotent on `(project_key, concern_ref)` with the same deterministic `pkc_`
poll handle mesh mints. Auth is off by default for local use; set
`LOCAL_EXECUTOR_HMAC_SECRET_HEX` (+ optional `LOCAL_EXECUTOR_HMAC_COMPONENT`)
to require the same component-HMAC headers `meshHmacSigner` produces.
`test/local-executor.test.mjs` carries the executable swap test.

## Surface

- `@operator/projectkit` — everything (one-import convenience)
- `@operator/projectkit/contract` — just the wire types + `validateProjectEvent`
- `@operator/projectkit/handoff` — just the handoff protocol
- `@operator/projectkit/git-ref-sink` — `GitRefSink` (node-only): deliver the same envelope to an append-only git ref instead of HTTP. The boundary test made concrete — git-as-substrate proves mesh is a swappable subscriber, not the owner.
- `@operator/projectkit/artifact-sink` — `ArtifactSink` (also re-exported from the root barrel; browser-safe): where capture-dock MEDIA (audio/video/screenshots) goes, the analogue of `EventSink` for blobs. `NullArtifactSink` returns the inline ref (`inline:<kind>:<sessionId>`) and is capture-off-safe; `HttpArtifactSink` PUTs/POSTs bytes to a blob store with HMAC injected, never baked in. Mesh is just one artifact sink.
- `schemas/project-event.schema.json`, `schemas/handoff.schema.json` — cross-language mirrors (Go/etc.)

## The contract

See [CONTRACT.md](./CONTRACT.md) — the versioned interface Agents B and C pin to.

## The invariant

`test/invariant.test.mjs` fails the build if any `src/` file imports from `mesh`,
`control-plane`, or `@operator/types`, or if a runtime dependency is added. The seam stays clean
by construction.
