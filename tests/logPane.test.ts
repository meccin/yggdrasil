import { describe, test, expect } from "bun:test";
import { applyFilter, collapseThinking, LOG_FILTER_ORDER } from "../src/ui/LogPane";
import type { AgentEvent } from "../src/types";

const e = (ev: AgentEvent): AgentEvent => ev;

describe("collapseThinking", () => {
  test("a single thinking event stays uncounted", () => {
    const result = collapseThinking([e({ ts: 1, kind: "thinking" })]);
    expect(result).toHaveLength(1);
    expect(result[0].thinkingCount).toBe(1);
  });

  test("consecutive thinking events collapse into one entry with the count", () => {
    const result = collapseThinking([
      e({ ts: 1, kind: "thinking" }),
      e({ ts: 2, kind: "thinking" }),
      e({ ts: 3, kind: "thinking" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].thinkingCount).toBe(3);
  });

  test("non-thinking events split thinking runs", () => {
    const result = collapseThinking([
      e({ ts: 1, kind: "thinking" }),
      e({ ts: 2, kind: "thinking" }),
      e({ ts: 3, kind: "tool", name: "Read" }),
      e({ ts: 4, kind: "thinking" }),
    ]);
    expect(result).toHaveLength(3);
    expect(result[0].thinkingCount).toBe(2);
    expect(result[1].thinkingCount).toBeUndefined();
    expect(result[2].thinkingCount).toBe(1);
  });

  test("empty input returns empty output", () => {
    expect(collapseThinking([])).toEqual([]);
  });
});

describe("applyFilter", () => {
  const events: AgentEvent[] = [
    { ts: 1, kind: "thinking" },
    { ts: 2, kind: "tool", name: "Read" },
    { ts: 3, kind: "usage", inputTokens: 100, outputTokens: 50 },
    { ts: 4, kind: "text", text: "hello" },
    { ts: 5, kind: "system", text: "spawn error: ENOENT" },
    { ts: 6, kind: "done", ok: false, reason: "error" },
    { ts: 7, kind: "done", ok: true },
  ];

  test('"all" hides only usage events', () => {
    const r = applyFilter(events, "all");
    expect(r.find((e) => e.kind === "usage")).toBeUndefined();
    expect(r).toHaveLength(events.length - 1);
  });

  test('"no-thinking" hides thinking + usage', () => {
    const r = applyFilter(events, "no-thinking");
    expect(r.find((e) => e.kind === "thinking")).toBeUndefined();
    expect(r.find((e) => e.kind === "usage")).toBeUndefined();
  });

  test('"tools" keeps tool and done only', () => {
    const r = applyFilter(events, "tools");
    expect(r.map((x) => x.kind).sort()).toEqual(["done", "done", "tool"]);
  });

  test('"errors" keeps failed done + system errors', () => {
    const r = applyFilter(events, "errors");
    expect(r).toHaveLength(2);
    expect(r.find((e) => e.kind === "system")?.text).toContain("error");
    expect(r.find((e) => e.kind === "done" && e.ok === false)).toBeDefined();
  });
});

describe("LOG_FILTER_ORDER", () => {
  test("covers each filter exactly once", () => {
    const set = new Set(LOG_FILTER_ORDER);
    expect(set.size).toBe(LOG_FILTER_ORDER.length);
    expect(set.size).toBe(4);
  });
});
