import { spawnSync } from "node:child_process";

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface RunOpts {
  cwd?: string;
  // Total attempts including the first one. Only retried on transient stderr.
  // Default 1 (no retry). Retries should only be enabled for read-only calls;
  // write calls (comment, mr create) can succeed server-side even when the CLI
  // reports failure, so retrying risks duplication.
  retries?: number;
  baseBackoffMs?: number;
}

const TRANSIENT_PATTERNS: RegExp[] = [
  /could not resolve/i,
  /name or service not known/i,
  /connection refused/i,
  /econnrefused/i,
  /connection reset/i,
  /econnreset/i,
  /timed? out/i,
  /etimedout/i,
  /network is unreachable/i,
  /enetunreach/i,
  /temporary failure/i,
  /\b50[234]\b/, // 502/503/504
];

export const isTransientError = (stderr: string): boolean =>
  TRANSIENT_PATTERNS.some((p) => p.test(stderr));

// Synchronous sleep without forking a subprocess. Atomics.wait blocks the
// current thread for the requested ms. We accept the freeze because the
// surrounding spawnSync calls already block while glab/gh runs.
const sleepSync = (ms: number): void => {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const i32 = new Int32Array(sab);
  Atomics.wait(i32, 0, 0, ms);
};

export const run = (bin: string, args: string[], opts: RunOpts = {}): RunResult => {
  const attempts = Math.max(1, opts.retries ?? 1);
  const base = opts.baseBackoffMs ?? 500;
  let last: RunResult = { ok: false, stdout: "", stderr: "" };
  for (let i = 0; i < attempts; i++) {
    const r = spawnSync(bin, args, { cwd: opts.cwd, encoding: "utf8" });
    last = { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
    if (last.ok) return last;
    if (!isTransientError(last.stderr)) return last;
    if (i + 1 < attempts) sleepSync(base * Math.pow(3, i));
  }
  return last;
};
