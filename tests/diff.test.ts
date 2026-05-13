import { describe, test, expect } from "bun:test";
import { classifyDiffLine, buildDiffLines, summarizeDiff } from "../src/ui/diff";

describe("classifyDiffLine", () => {
  test("file-header for `diff --git`", () => {
    expect(classifyDiffLine("diff --git a/foo.ts b/foo.ts")).toBe("file-header");
  });

  test("hunk header `@@`", () => {
    expect(classifyDiffLine("@@ -1,3 +1,4 @@")).toBe("hunk");
  });

  test("added vs removed by leading +/-", () => {
    expect(classifyDiffLine("+const x = 1")).toBe("added");
    expect(classifyDiffLine("-const y = 2")).toBe("removed");
  });

  test("metadata lines (+++/---/index)", () => {
    expect(classifyDiffLine("+++ b/foo.ts")).toBe("meta");
    expect(classifyDiffLine("--- a/foo.ts")).toBe("meta");
    expect(classifyDiffLine("index 0000..ffff")).toBe("meta");
  });

  test("context lines fall through", () => {
    expect(classifyDiffLine(" some unchanged code")).toBe("context");
  });

  test("blank lines are tagged blank", () => {
    expect(classifyDiffLine("")).toBe("blank");
  });
});

describe("buildDiffLines", () => {
  test("inserts a label before each section's body", () => {
    const out = buildDiffLines([
      { title: "STATUS", body: "M file.ts" },
      { title: "DIFF", body: "+added" },
    ]);
    // Each section: label + body lines + trailing blank.
    expect(out[0]).toEqual({ kind: "label", text: "── STATUS ──" });
    expect(out[1]).toEqual({ kind: "context", text: "M file.ts" });
    expect(out[2]).toEqual({ kind: "blank", text: "" });
    expect(out[3]).toEqual({ kind: "label", text: "── DIFF ──" });
    expect(out[4]).toEqual({ kind: "added", text: "+added" });
  });

  test("empty section bodies still get a label", () => {
    const out = buildDiffLines([{ title: "COMMITS", body: "" }]);
    expect(out[0].kind).toBe("label");
  });
});

describe("summarizeDiff", () => {
  test("counts files via `diff --git` headers", () => {
    const body = [
      "diff --git a/a.ts b/a.ts",
      "index ...",
      "+added",
      "diff --git a/b.ts b/b.ts",
      "+more",
    ].join("\n");
    expect(summarizeDiff(body, "").filesChanged).toBe(2);
  });

  test("counts commits via non-empty oneline lines", () => {
    const log = "abc123 first\ndef456 second\n";
    expect(summarizeDiff("", log).commits).toBe(2);
  });

  test("empty inputs yield zero counts", () => {
    expect(summarizeDiff("", "")).toEqual({ commits: 0, filesChanged: 0 });
  });
});
