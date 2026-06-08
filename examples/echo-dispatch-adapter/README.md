# echo-dispatch-adapter — the non-mesh boundary-test executor

A ~150-line Node HTTP server that is a **second, non-mesh** dispatch executor for
the `@operator/projectkit` contract. It exists to prove the operator's
**One-Line Boundary Test** end-to-end against a real backend that is **not mesh**:

> You can swap mesh for a different dispatch adapter without changing the
> Probe / Concern / Dispatch / Callback shapes.

It imports **nothing** from control-plane or mesh — only the published contract
(`validateConcern` / `validateCallback`). It speaks the same two routes mesh's
dispatch backend speaks, so a testbed swaps mesh for it by changing **one URL**.

## Routes

| Method | Path | What |
|--------|------|------|
| `POST` | `/api/projectkit/concerns` | Accept a `DispatchEnvelope`, validate every `Concern` with `validateConcern`, store it, return the projectkit `Ack` (with `poll_ref`). |
| `GET`  | `/api/projectkit/concerns/:pollRef` | Serve the poll/`Callback` shape, keyed by `concern_ref`. |
| `GET`  | `/__captured` | Introspection: every envelope + ack this process has seen. |
| `GET`  | `/healthz` | Liveness. |

## Run

```bash
npm install                         # resolves @operator/projectkit from the git-ref
PORT=8799 HOST=127.0.0.1 node server.mjs
```

## The swap (proven against chess)

```bash
# point a live testbed at THIS adapter instead of mesh — one URL:
export MESH_CONCERN_DISPATCH_URL=http://127.0.0.1:8799/api/projectkit/concerns
# promote a triaged work-item to the `agent` lane in chess; chess dispatches a
# Concern, this adapter validates + acks it, the shapes are byte-identical to
# what it dispatches at mesh. Then restore the URL to mesh.
```

The captured `Concern` + `Ack` (identical `schema_version` / `kind` /
`concern_ref` / `source_event_ref`) are the executable global-boundary-test
evidence: mesh was swapped for a non-mesh backend with **zero shape change**.
