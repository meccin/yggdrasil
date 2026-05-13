import { describe, test, expect } from "bun:test";
import { escapeAppleScript, notify } from "../src/notify";

describe("escapeAppleScript", () => {
  test("escapes embedded double quotes", () => {
    expect(escapeAppleScript('hello "world"')).toBe('hello \\"world\\"');
  });

  test("escapes backslashes BEFORE other escapes (no double-escape)", () => {
    expect(escapeAppleScript("path\\to")).toBe("path\\\\to");
    expect(escapeAppleScript('quote: \\"')).toBe('quote: \\\\\\"');
  });

  test("converts newlines to literal \\n", () => {
    expect(escapeAppleScript("line1\nline2")).toBe("line1\\nline2");
  });

  test("strips CR (Windows line endings)", () => {
    expect(escapeAppleScript("line1\r\nline2")).toBe("line1\\nline2");
  });

  test("empty input passes through", () => {
    expect(escapeAppleScript("")).toBe("");
  });
});

describe("notify", () => {
  test("never throws on any platform", () => {
    // The function is fire-and-forget and swallows errors internally; the
    // contract here is just that calling it never tears down the caller.
    expect(() => notify("title", "body")).not.toThrow();
  });

  test("safe with notification body that contains quotes and newlines", () => {
    expect(() =>
      notify('Tricky "title"', 'multi\nline\nbody with "quotes"'),
    ).not.toThrow();
  });
});
