// Ambient shims: minimal typing for the Node APIs that projectkit's node-only
// modules use (currently just `child_process.spawn`, in git-ref-sink.ts).
//
// This keeps the package free of `@types/node` so the universal, browser-safe
// core (sink.ts, client.ts, contract.ts, …) cannot accidentally reference Node
// globals like `process` or `Buffer` — that absence is the guardrail. Node-only
// modules opt in explicitly by importing `node:*`. Delete this file if
// `@types/node` is ever added as a devDependency.
//
// No imports/exports here on purpose: that makes this an *ambient* module
// declaration rather than an augmentation of an existing one.

declare module 'node:child_process' {
  interface GitStream {
    on(event: 'data', listener: (chunk: { toString(): string }) => void): void;
  }
  interface GitChild {
    stdout: GitStream;
    stderr: GitStream;
    stdin: { end(data?: string): void };
    on(event: 'error', listener: (err: { message: string }) => void): void;
    on(event: 'close', listener: (code: number | null) => void): void;
  }
  export function spawn(command: string, args: readonly string[]): GitChild;
}
