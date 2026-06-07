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

import { spawn } from 'node:child_process';
import type { GitStreamError } from 'node:child_process';
import type { ProjectEventEnvelope } from './contract.js';
import type { EventSink, SinkResult } from './sink.js';

// `spawn` is typed by the ambient shim in src/node-shims.d.ts (the package
// intentionally ships no @types/node — see that file).

const ZERO_OID = '0000000000000000000000000000000000000000';

export interface GitRefSinkOptions {
  /** Repo whose object store backs the log. Default `'.'` (current directory). */
  repoDir?: string;
  /** Ref holding the append-only log. Default `refs/operator/signals`. */
  ref?: string;
  /** File inside the ref's tree that holds the JSONL. Default `signals.jsonl`. */
  file?: string;
  /** Identity stamped on the log commits. Defaults to a projectkit identity. */
  identity?: { name: string; email: string };
  /**
   * Max compare-and-swap retries under concurrent writers. Each retry re-reads
   * the tip and rebuilds, so set this >= the number of cells that may write the
   * same ref at once. Default 10.
   */
  maxRetries?: number;
  /** Sink name for diagnostics. Default `git(<ref>)`. */
  name?: string;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Persists each envelope as one JSONL line appended to a dedicated git ref. */
export class GitRefSink implements EventSink {
  readonly name: string;
  private readonly base: string[];
  private readonly ref: string;
  private readonly file: string;
  private readonly maxRetries: number;

  constructor(opts: GitRefSinkOptions = {}) {
    const repoDir = opts.repoDir ?? '.';
    this.ref = opts.ref ?? 'refs/operator/signals';
    this.file = opts.file ?? 'signals.jsonl';
    this.maxRetries = opts.maxRetries ?? 10;
    const id = opts.identity ?? { name: 'projectkit', email: 'projectkit@localhost' };
    // Identity is supplied via `-c` so `commit-tree` stamps author + committer
    // without us touching `process.env` (keeps this module free of node globals).
    this.base = ['-C', repoDir, '-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`];
    this.name = opts.name ?? `git(${this.ref})`;
  }

  async deliver(envelope: ProjectEventEnvelope): Promise<SinkResult> {
    // IDENTICAL serialization to HttpSink's request body. This equality is the
    // whole point: the wire bytes do not depend on whether the subscriber is
    // mesh-over-HTTP or a git ref, so mesh is provably swappable.
    const line = JSON.stringify(envelope);
    const message = signalMessage(envelope);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const r = await this.tryAppend(line, message);
      if (r.ok) return { ok: true, sink: this.name, accepted: envelope.events.length };
      if (!r.retry) return { ok: false, sink: this.name, error: r.error };
      // CAS lost to a concurrent writer — loop to re-read the new tip and retry.
    }
    return {
      ok: false,
      sink: this.name,
      error: `git-ref CAS contention: gave up after ${this.maxRetries} retries`,
    };
  }

  private async tryAppend(
    line: string,
    message: string,
  ): Promise<{ ok: true } | { ok: false; retry: boolean; error: string }> {
    // 1. Current ref tip (empty string if the ref does not exist yet).
    const tip = await this.git(['rev-parse', '--verify', '--quiet', this.ref]);
    const oldTip = tip.code === 0 ? tip.stdout.trim() : '';

    // 2. Existing log content (empty for the first delivery).
    let existing = '';
    if (oldTip) {
      const cat = await this.git(['cat-file', '-p', `${this.ref}:${this.file}`]);
      if (cat.code === 0) existing = cat.stdout;
    }
    const content = existing + line + '\n';

    // 3. Write the new blob into the object store.
    const blob = await this.git(['hash-object', '-w', '--stdin'], content);
    if (blob.code !== 0) return { ok: false, retry: false, error: gitErr('hash-object', blob) };

    // 4. Build a one-file tree containing the blob.
    const tree = await this.git(['mktree'], `100644 blob ${blob.stdout.trim()}\t${this.file}\n`);
    if (tree.code !== 0) return { ok: false, retry: false, error: gitErr('mktree', tree) };

    // 5. Commit it, chaining onto the prior tip so the ref is an append-only log.
    const parent = oldTip ? ['-p', oldTip] : [];
    const commit = await this.git(['commit-tree', tree.stdout.trim(), ...parent, '-m', message]);
    if (commit.code !== 0) return { ok: false, retry: false, error: gitErr('commit-tree', commit) };

    // 6. Compare-and-swap the ref. `ZERO_OID` as the expected old value means
    //    "create only if absent"; any non-zero exit means a concurrent writer
    //    moved the ref out from under us — signal a retry.
    const expected = oldTip || ZERO_OID;
    const upd = await this.git(['update-ref', this.ref, commit.stdout.trim(), expected]);
    if (upd.code === 0) return { ok: true };
    return { ok: false, retry: true, error: gitErr('update-ref', upd) };
  }

  private git(args: string[], input?: string): Promise<GitResult> {
    return new Promise((resolve) => {
      const child = spawn('git', [...this.base, ...args]);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + e.message }));
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      // Feed stdin and close it. git can exit (and tear down its stdin pipe)
      // before this write flushes — e.g. `rev-parse`/`update-ref` ignore stdin —
      // which surfaces as EPIPE/ERR_STREAM_DESTROYED on this stream. The command's
      // real outcome is already determined by its exit code + stdout, so a stdin
      // write race must NOT reject the whole call: swallow it here. An explicit
      // 'error' handler is required regardless, since an unhandled stream 'error'
      // would otherwise crash the process. Happy-path behavior is unchanged.
      child.stdin.on('error', (e: GitStreamError) => {
        if (!isBenignStdinError(e)) {
          resolve({ code: -1, stdout, stderr: stderr + e.message });
        }
      });
      try {
        if (child.stdin.writable) {
          child.stdin.end(input ?? '');
        } else {
          child.stdin.destroy();
        }
      } catch (e) {
        const err = e as GitStreamError;
        if (!isBenignStdinError(err)) {
          resolve({ code: -1, stdout, stderr: stderr + err.message });
        }
      }
    });
  }
}

/**
 * True for the stdin-write race errors that are NOT real failures: git exited
 * before our `stdin.end()` flushed, tearing down the pipe. The command's outcome
 * is fully captured by its exit code + stdout, so these must be swallowed rather
 * than rejecting the call. Any other stream error is real and propagates.
 */
function isBenignStdinError(e: GitStreamError): boolean {
  return e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED';
}

function signalMessage(env: ProjectEventEnvelope): string {
  const types = env.events.map((e) => e.event_type).slice(0, 5).join(', ');
  const more = env.events.length > 5 ? `, +${env.events.length - 5}` : '';
  return `signal: ${env.project_key} [${types}${more}]`;
}

function gitErr(op: string, r: GitResult): string {
  const detail = r.stderr.trim() || `exit ${r.code}`;
  return `git ${op}: ${detail}`;
}
