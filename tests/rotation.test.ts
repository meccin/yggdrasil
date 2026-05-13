import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateFileIfNeeded, pruneOldestFiles } from "../src/rotation";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ygg-rot-"));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("rotateFileIfNeeded", () => {
  test("no-op when file does not exist", () => {
    expect(rotateFileIfNeeded(join(dir, "missing.log"))).toBe(false);
  });

  test("no-op when file under maxBytes", () => {
    const p = join(dir, "small.log");
    writeFileSync(p, "x".repeat(100));
    expect(rotateFileIfNeeded(p, { maxBytes: 1000 })).toBe(false);
    expect(existsSync(p)).toBe(true);
  });

  test("rotates when over maxBytes and leaves source absent", () => {
    const p = join(dir, "big.log");
    writeFileSync(p, "x".repeat(2000));
    expect(rotateFileIfNeeded(p, { maxBytes: 1000 })).toBe(true);
    expect(existsSync(p)).toBe(false);
    expect(existsSync(`${p}.1`)).toBe(true);
    expect(readFileSync(`${p}.1`, "utf8").length).toBe(2000);
  });

  test("preserves history through configured keep, drops oldest", () => {
    const p = join(dir, "h.log");
    // Pre-seed history shards .1 and .2.
    writeFileSync(`${p}.1`, "one");
    writeFileSync(`${p}.2`, "two");
    writeFileSync(p, "x".repeat(2000));
    expect(rotateFileIfNeeded(p, { maxBytes: 1000, keep: 2 })).toBe(true);
    // Active file became .1, previous .1 became .2, previous .2 is dropped.
    expect(readFileSync(`${p}.1`, "utf8").length).toBe(2000);
    expect(readFileSync(`${p}.2`, "utf8")).toBe("one");
    expect(existsSync(`${p}.3`)).toBe(false);
  });
});

describe("pruneOldestFiles", () => {
  test("keeps newest N when over the cap", () => {
    for (let i = 0; i < 5; i++) {
      const f = join(dir, `agent-${i}.ndjson`);
      writeFileSync(f, `${i}`);
      // Stagger mtimes so prune order is deterministic.
      const t = new Date(2026, 0, 1, 0, 0, i);
      utimesSync(f, t, t);
    }
    const removed = pruneOldestFiles(dir, { keep: 2, suffix: ".ndjson" });
    expect(removed).toBe(3);
    const remaining = readdirSync(dir).sort();
    expect(remaining).toEqual(["agent-3.ndjson", "agent-4.ndjson"]);
  });

  test("no-op when under the cap", () => {
    writeFileSync(join(dir, "a.ndjson"), "x");
    expect(pruneOldestFiles(dir, { keep: 10, suffix: ".ndjson" })).toBe(0);
  });

  test("respects suffix filter", () => {
    writeFileSync(join(dir, "a.ndjson"), "x");
    writeFileSync(join(dir, "a.txt"), "x");
    writeFileSync(join(dir, "b.ndjson"), "x");
    expect(pruneOldestFiles(dir, { keep: 1, suffix: ".ndjson" })).toBe(1);
    expect(existsSync(join(dir, "a.txt"))).toBe(true);
  });

  test("missing directory is a no-op", () => {
    expect(pruneOldestFiles(join(dir, "nope"))).toBe(0);
  });
});
