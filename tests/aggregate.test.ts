import { describe, test, expect } from "bun:test";
import { aggregate, type MetricEvent } from "../src/metrics";

const ts = (iso: string) => new Date(iso).getTime();

describe("aggregate", () => {
  test("counts agents, splits by status and repo, sums tokens", () => {
    const events: MetricEvent[] = [
      { ts: ts("2026-05-10T10:00:00Z"), kind: "agent_start", agentId: "a", repo: "r1", issueId: 1, mode: "mr" },
      {
        ts: ts("2026-05-10T10:05:00Z"),
        kind: "agent_end",
        agentId: "a",
        repo: "r1",
        issueId: 1,
        status: "done",
        durationMs: 300_000,
        inputTokens: 1000,
        outputTokens: 500,
      },
      { ts: ts("2026-05-10T11:00:00Z"), kind: "agent_start", agentId: "b", repo: "r2", issueId: 2, mode: "review" },
      {
        ts: ts("2026-05-10T11:02:00Z"),
        kind: "agent_end",
        agentId: "b",
        repo: "r2",
        issueId: 2,
        status: "failed",
        durationMs: 120_000,
        inputTokens: 200,
        outputTokens: 50,
        error: "boom",
      },
      { ts: ts("2026-05-10T11:00:30Z"), kind: "tool_use", agentId: "b", repo: "r2", tool: "Bash" },
      { ts: ts("2026-05-10T11:01:00Z"), kind: "tool_use", agentId: "b", repo: "r2", tool: "Read" },
    ];

    const agg = aggregate(events);
    expect(agg.totalAgents).toBe(2);
    expect(agg.byStatus).toEqual({ done: 1, failed: 1 });
    expect(agg.totalInputTokens).toBe(1200);
    expect(agg.totalOutputTokens).toBe(550);
    expect(agg.byRepo.r1.agents).toBe(1);
    expect(agg.byRepo.r2.agents).toBe(1);
    expect(agg.toolHisto).toEqual({ Bash: 1, Read: 1 });
    expect(agg.avgDurationMs).toBe(210_000);
    expect(agg.topIssues[0]).toMatchObject({ repo: "r1", issueId: 1, tokens: 1500 });
  });

  test("empty events yield zero aggregate", () => {
    const agg = aggregate([]);
    expect(agg.totalAgents).toBe(0);
    expect(agg.avgDurationMs).toBe(0);
    expect(agg.topIssues).toEqual([]);
  });
});
