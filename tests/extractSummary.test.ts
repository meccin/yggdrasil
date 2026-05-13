import { describe, test, expect } from "bun:test";
import { extractSummary } from "../src/agent/finalize";
import type { Agent } from "../src/types";

const agent = (log: Agent["log"]): Agent => ({
  id: "id",
  repoName: "r",
  issueId: 1,
  issueTitle: "t",
  branch: "agent/issue-1",
  worktreePath: "/tmp",
  mode: "mr",
  status: "running",
  startedAt: 0,
  inputTokens: 0,
  outputTokens: 0,
  log,
});

describe("extractSummary", () => {
  test("returns the last text block (typical final summary)", () => {
    const a = agent([
      { ts: 1, kind: "text", text: "intro" },
      { ts: 2, kind: "tool", name: "Read" },
      { ts: 3, kind: "text", text: "final summary line" },
    ]);
    expect(extractSummary(a)).toBe("final summary line");
  });

  test("ignores empty text blocks", () => {
    const a = agent([
      { ts: 1, kind: "text", text: "real" },
      { ts: 2, kind: "text", text: "   " },
    ]);
    expect(extractSummary(a)).toBe("real");
  });

  test("returns empty string when no text events", () => {
    const a = agent([
      { ts: 1, kind: "tool", name: "Read" },
      { ts: 2, kind: "thinking" },
    ]);
    expect(extractSummary(a)).toBe("");
  });

  test("trims surrounding whitespace", () => {
    const a = agent([{ ts: 1, kind: "text", text: "  done.\n" }]);
    expect(extractSummary(a)).toBe("done.");
  });
});
