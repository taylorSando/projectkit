/**
 * projectkit — sinks. A sink is where emitted events GO. The contract is
 * sink-agnostic: a testbed emits to an `EventSink`, and mesh/control-plane is
 * merely ONE possible sink (an HttpSink pointed at its ingest URL, optionally
 * signed). Nothing here imports control-plane or mesh.
 */

import type { ProjectEventEnvelope } from './contract.js';

export interface SinkResult {
  ok: boolean;
  sink: string;
  status?: number;
  error?: string;
  /** Number of events the sink accepted from the envelope. */
  accepted?: number;
}

export interface EventSink {
  readonly name: string;
  deliver(envelope: ProjectEventEnvelope): Promise<SinkResult>;
}

/** Drops everything and reports success. Default for "capture is off". */
export class NullSink implements EventSink {
  readonly name = 'null';
  async deliver(envelope: ProjectEventEnvelope): Promise<SinkResult> {
    return { ok: true, sink: this.name, accepted: envelope.events.length };
  }
}

/** Collects envelopes in memory. For tests and local introspection. */
export class MemorySink implements EventSink {
  readonly name = 'memory';
  readonly envelopes: ProjectEventEnvelope[] = [];
  async deliver(envelope: ProjectEventEnvelope): Promise<SinkResult> {
    this.envelopes.push(envelope);
    return { ok: true, sink: this.name, accepted: envelope.events.length };
  }
  /** Flattened view of every event delivered so far. */
  get events() {
    return this.envelopes.flatMap((e) => e.events);
  }
  clear() {
    this.envelopes.length = 0;
  }
}

/** Writes a one-line JSON summary per envelope to a logger (default console). */
export class ConsoleSink implements EventSink {
  readonly name = 'console';
  constructor(private readonly log: (line: string) => void = (l) => console.log(l)) {}
  async deliver(envelope: ProjectEventEnvelope): Promise<SinkResult> {
    this.log(
      JSON.stringify({
        sink: this.name,
        project: envelope.project_key,
        contract: envelope.contract_version,
        events: envelope.events.map((e) => e.event_type),
      }),
    );
    return { ok: true, sink: this.name, accepted: envelope.events.length };
  }
}

/** A function that, given the request body, returns headers to attach (e.g. HMAC). */
export type SignFn = (body: string) => Record<string, string> | Promise<Record<string, string>>;

export interface HttpSinkOptions {
  /** Full ingest URL. mesh is just this string; the sink does not know mesh. */
  url: string;
  /** Static headers (content-type is added automatically). */
  headers?: Record<string, string>;
  /**
   * Optional signer. HMAC/auth is INJECTED, never baked in — a testbed never
   * needs to hold a mesh secret in the SDK; the host wires the signer.
   */
  sign?: SignFn;
  /** Defaults to global fetch (Node 18+/browser). Inject for tests. */
  fetchImpl?: typeof fetch;
  /** Abort after this many ms. Default 8000. */
  timeoutMs?: number;
  /** Sink name for diagnostics. Default derived from the URL host. */
  name?: string;
}

/** POSTs the envelope as JSON to a configurable URL. The canonical "to mesh" sink. */
export class HttpSink implements EventSink {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: HttpSinkOptions) {
    if (!opts.url) throw new Error('HttpSink requires a url');
    const f = opts.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) throw new Error('HttpSink: no fetch available; pass opts.fetchImpl');
    // Bind to the global scope. We store the impl as an instance field and call
    // it below as `this.fetchImpl(...)`, which would otherwise invoke `fetch`
    // with `this === this HttpSink` — and the browser's native `fetch` throws
    // "Illegal invocation" unless `this` is the Window/global. (Node's fetch
    // tolerates any `this`, so this only bit in the browser.) Binding makes the
    // method-call form safe regardless of how the impl is invoked.
    this.fetchImpl = f.bind(globalThis);
    this.name = opts.name ?? `http(${safeHost(opts.url)})`;
  }

  async deliver(envelope: ProjectEventEnvelope): Promise<SinkResult> {
    const body = JSON.stringify(envelope);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(this.opts.headers ?? {}),
    };
    try {
      if (this.opts.sign) Object.assign(headers, await this.opts.sign(body));
    } catch (err) {
      return { ok: false, sink: this.name, error: `sign failed: ${errMsg(err)}` };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 8000);
    try {
      const res = await this.fetchImpl(this.opts.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      return {
        ok: res.ok,
        sink: this.name,
        status: res.status,
        accepted: res.ok ? envelope.events.length : 0,
        ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
      };
    } catch (err) {
      return { ok: false, sink: this.name, error: errMsg(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Delivers to several sinks; ok only if ALL succeed. Useful for tee'ing. */
export class FanoutSink implements EventSink {
  readonly name: string;
  constructor(private readonly sinks: EventSink[]) {
    this.name = `fanout(${sinks.map((s) => s.name).join(',')})`;
  }
  async deliver(envelope: ProjectEventEnvelope): Promise<SinkResult> {
    const results = await Promise.all(this.sinks.map((s) => s.deliver(envelope)));
    const failed = results.filter((r) => !r.ok);
    return failed.length === 0
      ? { ok: true, sink: this.name, accepted: envelope.events.length }
      : { ok: false, sink: this.name, error: failed.map((f) => `${f.sink}:${f.error}`).join('; ') };
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
