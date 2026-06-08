/**
 * projectkit — sinks. A sink is where emitted events GO. The contract is
 * sink-agnostic: a testbed emits to an `EventSink`, and mesh/control-plane is
 * merely ONE possible sink (an HttpSink pointed at its ingest URL, optionally
 * signed). Nothing here imports control-plane or mesh.
 */
/** Drops everything and reports success. Default for "capture is off". */
export class NullSink {
    name = 'null';
    async deliver(envelope) {
        return { ok: true, sink: this.name, accepted: envelope.events.length };
    }
}
/** Collects envelopes in memory. For tests and local introspection. */
export class MemorySink {
    name = 'memory';
    envelopes = [];
    async deliver(envelope) {
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
export class ConsoleSink {
    log;
    name = 'console';
    constructor(log = (l) => console.log(l)) {
        this.log = log;
    }
    async deliver(envelope) {
        this.log(JSON.stringify({
            sink: this.name,
            project: envelope.project_key,
            contract: envelope.contract_version,
            events: envelope.events.map((e) => e.event_type),
        }));
        return { ok: true, sink: this.name, accepted: envelope.events.length };
    }
}
/** POSTs the envelope as JSON to a configurable URL. The canonical "to mesh" sink. */
export class HttpSink {
    opts;
    name;
    fetchImpl;
    constructor(opts) {
        this.opts = opts;
        if (!opts.url)
            throw new Error('HttpSink requires a url');
        const f = opts.fetchImpl ?? globalThis.fetch;
        if (!f)
            throw new Error('HttpSink: no fetch available; pass opts.fetchImpl');
        // Bind to the global scope. We store the impl as an instance field and call
        // it below as `this.fetchImpl(...)`, which would otherwise invoke `fetch`
        // with `this === this HttpSink` — and the browser's native `fetch` throws
        // "Illegal invocation" unless `this` is the Window/global. (Node's fetch
        // tolerates any `this`, so this only bit in the browser.) Binding makes the
        // method-call form safe regardless of how the impl is invoked.
        this.fetchImpl = f.bind(globalThis);
        this.name = opts.name ?? `http(${safeHost(opts.url)})`;
    }
    async deliver(envelope) {
        const body = JSON.stringify(envelope);
        const headers = {
            'content-type': 'application/json',
            ...(this.opts.headers ?? {}),
        };
        try {
            if (this.opts.sign)
                Object.assign(headers, await this.opts.sign(body));
        }
        catch (err) {
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
        }
        catch (err) {
            return { ok: false, sink: this.name, error: errMsg(err) };
        }
        finally {
            clearTimeout(timer);
        }
    }
}
/** Delivers to several sinks; ok only if ALL succeed. Useful for tee'ing. */
export class FanoutSink {
    sinks;
    name;
    constructor(sinks) {
        this.sinks = sinks;
        this.name = `fanout(${sinks.map((s) => s.name).join(',')})`;
    }
    async deliver(envelope) {
        const results = await Promise.all(this.sinks.map((s) => s.deliver(envelope)));
        const failed = results.filter((r) => !r.ok);
        return failed.length === 0
            ? { ok: true, sink: this.name, accepted: envelope.events.length }
            : { ok: false, sink: this.name, error: failed.map((f) => `${f.sink}:${f.error}`).join('; ') };
    }
}
function safeHost(url) {
    try {
        return new URL(url).host;
    }
    catch {
        return 'invalid-url';
    }
}
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
//# sourceMappingURL=sink.js.map