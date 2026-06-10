/**
 * executor-core — the shared "REALLY RUN one Concern as a local process" leg
 * used by BOTH executor backends (bin/local-executor.mjs, the push/HTTP door,
 * and bin/pull-executor.mjs, the poll/feed loop). One implementation so the
 * two executors cannot drift on the execution contract:
 *
 *   - the Concern is delivered to the process as env (CONCERN_REF,
 *     CONCERN_KIND, CONCERN_TITLE, CONCERN_SUMMARY, CONCERN_PROJECT_KEY,
 *     CONCERN_INPUTS_JSON) and as full JSON on stdin;
 *   - exit 0  -> Callback patch `succeeded` (stdout in outputs.stdout);
 *   - exit !0 -> `failed` with error_code `execution`;
 *   - timeout -> `failed` with error_code `timeout`;
 *   - a stdout line `::artifact::<kind>::<ref>` becomes a CallbackArtifact.
 *
 * Zero runtime deps; imports nothing from mesh or control-plane.
 */
import { spawn } from 'node:child_process';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_CAPTURE_BYTES = 64 * 1024; // stdout/stderr capture cap per stream

/** Truncate captured output to the cap, marking the cut. */
export function capped(s, maxBytes = MAX_CAPTURE_BYTES) {
  if (s.length <= maxBytes) return s;
  return s.slice(0, maxBytes) + '…[truncated]';
}

/** Parse `::artifact::<kind>::<ref>` lines out of stdout into CallbackArtifacts. */
export function parseArtifacts(stdout) {
  const artifacts = [];
  for (const line of stdout.split('\n')) {
    const m = /^::artifact::([^:][^:]*)::(.+)$/.exec(line.trim());
    if (m) artifacts.push({ kind: m[1], ref: m[2] });
  }
  return artifacts;
}

/**
 * Run one Concern as a one-shot local process and resolve a Callback PATCH —
 * the terminal fields ({status, outputs?, artifacts?, error?, error_code?,
 * completed_at}) the caller merges over its `accepted`/`running` Callback.
 * Never rejects; every failure mode resolves a `failed` patch with a
 * machine-readable `error_code` (v1.4.0).
 */
export function runConcernProcess(concern, { cmd, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, maxCaptureBytes = MAX_CAPTURE_BYTES } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (patch) => {
      if (settled) return;
      settled = true;
      resolve(patch);
    };

    const child = spawn(cmd, {
      shell: true,
      env: {
        ...env,
        CONCERN_REF: concern.concern_ref,
        CONCERN_KIND: concern.kind,
        CONCERN_TITLE: concern.title,
        CONCERN_SUMMARY: concern.summary ?? '',
        CONCERN_PROJECT_KEY: concern.project_key,
        CONCERN_INPUTS_JSON: JSON.stringify(concern.inputs ?? {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { if (stdout.length < maxCaptureBytes * 2) stdout += c; });
    child.stderr.on('data', (c) => { if (stderr.length < maxCaptureBytes * 2) stderr += c; });

    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(killer);
      settle({
        status: 'failed',
        error: `spawn failed: ${err.message}`,
        error_code: 'execution',
        completed_at: new Date().toISOString(),
      });
    });

    child.on('close', (code) => {
      clearTimeout(killer);
      const completed_at = new Date().toISOString();
      if (timedOut) {
        settle({
          status: 'failed',
          error: `execution timed out after ${timeoutMs}ms`,
          error_code: 'timeout',
          completed_at,
        });
      } else if (code === 0) {
        const artifacts = parseArtifacts(stdout);
        settle({
          status: 'succeeded',
          outputs: { stdout: capped(stdout, maxCaptureBytes), exit_code: 0, command: cmd },
          ...(artifacts.length ? { artifacts } : {}),
          completed_at,
        });
      } else {
        settle({
          status: 'failed',
          outputs: { stdout: capped(stdout, maxCaptureBytes), exit_code: code ?? -1, command: cmd },
          error: `command exited ${code}${stderr ? `: ${capped(stderr, maxCaptureBytes).slice(0, 2000)}` : ''}`,
          error_code: 'execution',
          completed_at,
        });
      }
    });

    // Deliver the full Concern on stdin (ignore EPIPE from commands that don't read it).
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(concern));
  });
}
