import { describe, test, expect } from "bun:test";
import { formatToolBrief } from "../src/agent/runner";

const WT = "/Users/me/.yggdrasil/wt/owner-proj/issue-1";

describe("formatToolBrief", () => {
  test("Read returns relative path under worktree", () => {
    expect(formatToolBrief("Read", { file_path: `${WT}/src/main.ts` }, WT)).toBe("src/main.ts");
  });

  test("Read keeps absolute path when not under worktree", () => {
    const out = formatToolBrief("Read", { file_path: "/etc/hosts" }, WT);
    // Falls through to the "…/parent/file" shortener.
    expect(out).toContain("hosts");
  });

  test("Edit shows relative path plus old_string head", () => {
    const out = formatToolBrief(
      "Edit",
      { file_path: `${WT}/src/a.ts`, old_string: "const x = 1\nconst y = 2" },
      WT,
    );
    expect(out).toContain("src/a.ts");
    expect(out).toContain("const x = 1");
  });

  test("Glob returns the pattern verbatim", () => {
    expect(formatToolBrief("Glob", { pattern: "**/*.ts" }, WT)).toBe("**/*.ts");
  });

  test("Grep includes pattern and relative path", () => {
    const out = formatToolBrief("Grep", { pattern: "foo", path: `${WT}/src` }, WT);
    expect(out).toContain("foo");
    expect(out).toContain("src");
  });

  test("Bash prefers description over command", () => {
    expect(
      formatToolBrief(
        "Bash",
        { command: "ls -la /etc/secret", description: "List files" },
        WT,
      ),
    ).toBe("List files");
  });

  test("Bash falls back to command when description missing", () => {
    expect(formatToolBrief("Bash", { command: "ls -la" }, WT)).toBe("ls -la");
  });

  test("TodoWrite shows the in_progress todo", () => {
    const out = formatToolBrief(
      "TodoWrite",
      {
        todos: [
          { content: "first", status: "pending" },
          { content: "second", status: "in_progress" },
        ],
      },
      WT,
    );
    expect(out).toBe("→ second");
  });

  test("TodoWrite falls back to total count", () => {
    expect(
      formatToolBrief("TodoWrite", { todos: [{ content: "x", status: "pending" }] }, WT),
    ).toBe("1 todos");
  });

  test("unknown tool falls back to first key=value", () => {
    expect(formatToolBrief("Mystery", { kind: "lookup" }, WT)).toBe("kind=lookup");
  });

  test("empty input returns undefined", () => {
    expect(formatToolBrief("Anything", null, WT)).toBeUndefined();
  });

  test("long values are truncated", () => {
    const long = "x".repeat(200);
    const out = formatToolBrief("Bash", { command: long }, WT);
    expect(out!.length).toBeLessThanOrEqual(80);
    expect(out!.endsWith("…")).toBe(true);
  });
});
