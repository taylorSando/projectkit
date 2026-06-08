/**
 * projectkit — GitRefSink. An {@link EventSink} that persists envelopes to an
 * append-only git ref instead of an HTTP endpoint, using only git's object
 * store (no working tree, no server, no daemon).
 *
 * WHY THIS EXISTS — the boundary test made concrete. The decoupling invariant
 * is "mesh is ONE subscriber, never the owner: you can swap mesh for a different
 * dispatch adapter without the testbeds changing." An HttpSink pointed at mesh
 * and a GitRefSink pointed at a ref deliver the *byte-identical* envelope
 * (`JSON.stringify(envelope)`); the only difference is the transport. Git as the
 * substrate proves mesh is not the owner — the signal lives in a ref any
 * subscriber (mesh, a CI job, another agent cell) can `git fetch` and replay.
 *
 * NODE-ONLY: this uses `node:child_process`, so — like `mesh-hmac` — it is NOT
 * re-exported from the browser-safe barrel (`index.ts`). Import it via the
 * '@operator/projectkit/git-ref-sink' subpath.
 *
 * The log: the ref (default `refs/operator/signals`) holds a commit whose tree
 * contains one file (default `signals.jsonl`); each delivery appends one JSON
 * line and adds one commit (parent = prior tip), so `git log <ref>` is the
 * delivery history and `git cat-file -p <ref>:<file>` is the full event stream.
 * Concurrent writers are handled by compare-and-swap on `update-ref` with a
 * bounded retry. (Each append rewrites the cumulative blob — fine for the
 * operator-scale signal volume this targets; a high-volume producer would shard
 * the file by date or read via commit-walk instead.)
 */
import type { ProjectEventEnvelope } from './contract.js';
import type { EventSink, SinkResult } from './sink.js';
export interface GitRefSinkOptions {
    /** Repo whose object store backs the log. Default `'.'` (current directory). */
    repoDir?: string;
    /** Ref holding the append-only log. Default `refs/operator/signals`. */
    ref?: string;
    /** File inside the ref's tree that holds the JSONL. Default `signals.jsonl`. */
    file?: string;
    /** Identity stamped on the log commits. Defaults to a projectkit identity. */
    identity?: {
        name: string;
        email: string;
    };
    /**
     * Max compare-and-swap retries under concurrent writers. Each retry re-reads
     * the tip and rebuilds, so set this >= the number of cells that may write the
     * same ref at once. Default 10.
     */
    maxRetries?: number;
    /** Sink name for diagnostics. Default `git(<ref>)`. */
    name?: string;
}
/** Persists each envelope as one JSONL line appended to a dedicated git ref. */
export declare class GitRefSink implements EventSink {
    readonly name: string;
    private readonly base;
    private readonly ref;
    private readonly file;
    private readonly maxRetries;
    constructor(opts?: GitRefSinkOptions);
    deliver(envelope: ProjectEventEnvelope): Promise<SinkResult>;
    private tryAppend;
    private git;
}
//# sourceMappingURL=git-ref-sink.d.ts.map