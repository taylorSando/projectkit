#!/usr/bin/env node
/**
 * pull-executor — the POLL-direction executor backend for the
 * @operator/projectkit DISPATCH contract (the inverse transport of
 * bin/local-executor.mjs).
 *
 * local-executor is a PUSH door: the producer POSTs a DispatchEnvelope to the
 * executor's HTTP server. That requires the executor to be REACHABLE — which a
 * collaborator's laptop or any box behind NAT with no inbound address is not. pull-executor inverts the transport while keeping the SAME
 * Concern / Callback shapes (the One-Line Boundary Test holds: only the
 * transport differs, never the contract): the executor POLLS a producer-side
 * feed for Concerns addressed to its `audience` (v1.4.0 field) and POSTs
 * Callbacks back.
 *
 * FEED CONTRACT (two routes the PRODUCER hosts — e.g. sitelayer's
 * /api/agent-feed; any testbed can host one):
 *
 *   GET  {FEED_URL}/concerns?audience=<aud>
 *        -> 200 { concerns: Concern[] }   (pending, addressed to <aud>;
 *           also accepts a bare Concern[] body)
 *   POST {FEED_URL}/callbacks             body: Callback JSON
 *        -> 2xx accepted. The FIRST `accepted` Callback for a concern_ref is
 *           the CLAIM (lease) — the feed stops listing that Concern. A 409
 *           means another executor already claimed it: skip, don't run.
 *           Terminal `succeeded|failed` completes the loop.
 *
 * EXECUTION is byte-identical to local-executor (shared bin/executor-core.mjs):
 *   LOCAL_EXECUTOR_CMD          shell command per Concern (env CONCERN_* +
 *                               full Concern JSON on stdin; `::artifact::`
 *                               stdout lines -> CallbackArtifacts). e.g.:
 *     LOCAL_EXECUTOR_CMD='claude -p "$CONCERN_TITLE — $CONCERN_SUMMARY"'
 *   LOCAL_EXECUTOR_TIMEOUT_MS   kill after this many ms -> failed/timeout.
 *
 * PULL CONFIG:
 *   PULL_FEED_URL        base feed URL (required), e.g.
 *                        https://app.example.com/api/agent-feed
 *   PULL_AUDIENCE        audience lane to pull (required), e.g. steve |
 *                        capture-analyzer
 *   PULL_FEED_TOKEN      bearer token sent as Authorization (optional)
 *   PULL_HMAC_SECRET_HEX / PULL_HMAC_COMPONENT
 *                        mesh-canonical component-HMAC signing (optional).
 *                        Canonical string signs the URL PATHNAME (no query),
 *                        matching local-executor's verify side.
 *   PULL_INTERVAL_MS     poll cadence (default 30000)
 *   PULL_STATE_FILE      done-ledger JSON path (optional). Survives restarts
 *                        so a completed Concern never re-runs.
 *   --once               run a single poll cycle and exit (cron/test mode).
 *
 * Concerns run SEQUENTIALLY within a cycle (an agent command like `claude -p`
 * should not trample itself on a laptop). Idempotency: keyed on
 * (project_key, concern_ref) exactly like local-executor and mesh.
 *
 * Zero runtime deps: node built-ins + this package's own dist (run
 * `npm run build` first). Imports NOTHING from mesh or control-plane.
 */
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateConcern, validateCallback } from '../dist/dispatch.js';
import { runConcernProcess, DEFAULT_TIMEOUT_MS } from './executor-core.mjs';

const EXECUTOR_NAME_DEFAULT = 'pull-executor';
const DEFAULT_INTERVAL_MS = 30_000;

function sha256Hex(body) {
  return createHash('sha256').update(body || '', 'utf8').digest('hex');
}

/**
 * mesh-canonical component-HMAC headers over `${ts}.${METHOD}.${path}.${sha256hex(body)}`
 * — exactly what @operator/projectkit/mesh-hmac's meshHmacSigner produces, inlined
 * here so the bin stays zero-dep on the node-only subpath. `path` is the URL
 * PATHNAME (no query), matching local-executor's verify side.
 */
function meshHmacHeaders({ secretHex, component, method, path, body }) {
  const ts = String(Math.floor(Date.now() / 1000));
  const canonical = `${ts}.${method.toUpperCase()}.${path}.${sha256Hex(body)}`;
  const signature = 'sha256=' + createHmac('sha256', Buffer.from(secretHex, 'hex')).update(canonical, 'utf8').digest('hex');
  return {
    'X-Mesh-Component': component,
    'X-Mesh-Signature': signature,
    'X-Mesh-Timestamp': ts,
  };
}

function idemKey(concern) {
  return `${concern.project_key}\x00${concern.concern_ref}`;
}

/**
 * Create the pull loop. Options (all optional; env is the fallback):
 *   feedUrl, audience, token, hmacSecretHex, hmacComponent,
 *   cmd, timeoutMs, intervalMs, stateFile, executorName,
 *   fetchImpl (inject for tests), onExecuted(record), quiet
 *
 * Returns { tick(), start(), stop(), done } where `done` is the in-memory
 * done-ledger (Set of project_key\x00concern_ref) and tick() runs ONE poll
 * cycle (fetch -> claim -> execute -> terminal callback) to completion.
 */
export function createPullExecutor(opts = {}) {
  const env = opts.env ?? process.env;
  const feedUrl = (opts.feedUrl ?? env.PULL_FEED_URL ?? '').replace(/\/+$/, '');
  const audience = opts.audience ?? env.PULL_AUDIENCE ?? '';
  if (!feedUrl) throw new Error('pull-executor: PULL_FEED_URL is required');
  if (!audience) throw new Error('pull-executor: PULL_AUDIENCE is required');
  const token = opts.token ?? env.PULL_FEED_TOKEN ?? '';
  const hmacSecretHex = opts.hmacSecretHex ?? env.PULL_HMAC_SECRET_HEX ?? '';
  const hmacComponent = opts.hmacComponent ?? env.PULL_HMAC_COMPONENT ?? EXECUTOR_NAME_DEFAULT;
  const cmd =
    opts.cmd ??
    env.LOCAL_EXECUTOR_CMD ??
    'echo "pull-executor stub: $CONCERN_TITLE ($CONCERN_REF) — ${CONCERN_SUMMARY:-no summary}"';
  const timeoutMs = Number(opts.timeoutMs ?? env.LOCAL_EXECUTOR_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const intervalMs = Number(opts.intervalMs ?? env.PULL_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const stateFile = opts.stateFile ?? env.PULL_STATE_FILE ?? '';
  const executorName = opts.executorName ?? env.PULL_EXECUTOR_NAME ?? EXECUTOR_NAME_DEFAULT;
  const fetchImpl = (opts.fetchImpl ?? globalThis.fetch).bind(globalThis);
  const onExecuted = opts.onExecuted ?? (() => {});
  const log = opts.quiet ? () => {} : (...a) => console.log(`[${executorName}]`, ...a);

  /** Done-ledger: a terminal Callback was POSTed for these. Never re-run. */
  const done = new Set();
  if (stateFile) {
    try {
      const arr = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (Array.isArray(arr)) for (const k of arr) done.add(k);
    } catch {
      /* first run / unreadable: start empty */
    }
  }
  function persistDone() {
    if (!stateFile) return;
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify([...done], null, 2));
    } catch (err) {
      log(`warn: could not persist state file ${stateFile}:`, err instanceof Error ? err.message : err);
    }
  }
  /** Claimed-or-running this process lifetime (claim happened; terminal may be pending). */
  const inFlight = new Set();

  function authHeaders(method, urlString, body) {
    const headers = {};
    if (token) headers['authorization'] = `Bearer ${token}`;
    if (hmacSecretHex) {
      Object.assign(
        headers,
        meshHmacHeaders({
          secretHex: hmacSecretHex,
          component: hmacComponent,
          method,
          path: new URL(urlString).pathname,
          body: body ?? '',
        }),
      );
    }
    return headers;
  }

  async function fetchConcerns() {
    const url = `${feedUrl}/concerns?audience=${encodeURIComponent(audience)}`;
    const res = await fetchImpl(url, { method: 'GET', headers: authHeaders('GET', url, '') });
    if (!res.ok) throw new Error(`feed GET ${url} -> HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : Array.isArray(data?.concerns) ? data.concerns : [];
    return list;
  }

  /** POST a Callback to the feed. Returns the HTTP status (0 on network error). */
  async function postCallback(callback) {
    const problems = validateCallback(callback);
    if (problems.length) {
      log(`internal: refusing to POST invalid callback: ${problems.join('; ')}`);
      return 0;
    }
    const url = `${feedUrl}/callbacks`;
    const body = JSON.stringify(callback);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders('POST', url, body) },
        body,
      });
      return res.status;
    } catch (err) {
      log(`callback POST failed:`, err instanceof Error ? err.message : err);
      return 0;
    }
  }

  /** Claim + execute + report ONE Concern. */
  async function runOne(concern) {
    const key = idemKey(concern);
    if (done.has(key) || inFlight.has(key)) return;
    inFlight.add(key);

    // CLAIM: first `accepted` Callback is the lease. 409 = someone else has it.
    const claimStatus = await postCallback({
      schema_version: concern.schema_version,
      concern_ref: concern.concern_ref,
      status: 'accepted',
    });
    if (claimStatus === 409) {
      log(`concern ${concern.concern_ref} already claimed elsewhere; skipping`);
      inFlight.delete(key);
      return;
    }
    if (claimStatus < 200 || claimStatus >= 300) {
      log(`claim for ${concern.concern_ref} not accepted (HTTP ${claimStatus}); will retry next cycle`);
      inFlight.delete(key);
      return;
    }

    log(`running concern ${concern.concern_ref}: ${cmd}`);
    const patch = await runConcernProcess(concern, { cmd, env, timeoutMs });
    const callback = {
      schema_version: concern.schema_version,
      concern_ref: concern.concern_ref,
      ...patch,
    };
    const record = { concern, callback };
    const terminalStatus = await postCallback(callback);
    if (terminalStatus >= 200 && terminalStatus < 300) {
      done.add(key);
      persistDone();
      log(`concern ${concern.concern_ref} -> ${callback.status} (reported)`);
    } else {
      log(`terminal callback for ${concern.concern_ref} not accepted (HTTP ${terminalStatus}); will re-run next cycle`);
    }
    inFlight.delete(key);
    onExecuted(record);
  }

  /** One full poll cycle: fetch -> filter -> sequential claim/execute/report. */
  async function tick() {
    let concerns;
    try {
      concerns = await fetchConcerns();
    } catch (err) {
      log(`poll failed:`, err instanceof Error ? err.message : err);
      return;
    }
    for (const concern of concerns) {
      if (validateConcern(concern).length > 0) continue; // fail closed per-concern
      // Client-side audience re-check: never run work addressed elsewhere,
      // even if the feed mis-filters.
      if (concern.audience !== undefined && concern.audience !== audience) continue;
      await runOne(concern); // sequential by design (agent commands on a laptop)
    }
  }

  let timer = null;
  return {
    tick,
    done,
    start() {
      log(`polling ${feedUrl}/concerns?audience=${audience} every ${intervalMs}ms`);
      log(`cmd: ${cmd}`);
      const loop = async () => {
        await tick();
        timer = setTimeout(loop, intervalMs);
      };
      void loop();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

// CLI entrypoint: `pull-executor` / `node bin/pull-executor.mjs [--once]`.
// npm/npx binstubs are SYMLINKS to this file; argv[1] is the symlink path while
// import.meta.url is the realpath, so compare against the resolved target too.
const isMain = process.argv[1] && (() => {
  const direct = pathToFileURL(process.argv[1]).href;
  let resolved = direct;
  try { resolved = pathToFileURL(realpathSync(process.argv[1])).href; } catch { /* keep direct */ }
  return import.meta.url === direct || import.meta.url === resolved;
})();
if (isMain) {
  const executor = createPullExecutor();
  if (process.argv.includes('--once')) {
    executor.tick().then(() => process.exit(0));
  } else {
    executor.start();
  }
}
