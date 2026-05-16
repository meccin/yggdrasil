import { describe, test, expect } from "bun:test";
import { noAuthedProvider, startupBlocking, type CheckResult } from "../src/doctor";

const ok = (name: string, level: CheckResult["level"]): CheckResult => ({
  name,
  ok: true,
  level,
});
const bad = (name: string, level: CheckResult["level"], hint?: string): CheckResult => ({
  name,
  ok: false,
  level,
  hint,
});

describe("startupBlocking", () => {
  test("happy path: claude + git + one authed provider → not blocked", () => {
    const result = startupBlocking([
      ok("Claude Code CLI (`claude`)", "fatal"),
      ok("git", "fatal"),
      ok("glab (GitLab CLI) + auth", "warn"),
    ]);
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  test("missing `claude` (fatal) blocks with hint", () => {
    const result = startupBlocking([
      bad("Claude Code CLI (`claude`)", "fatal", "install from https://claude.com/claude-code"),
      ok("git", "fatal"),
      ok("gh (GitHub CLI) + auth", "warn"),
    ]);
    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toMatch(/claude/i);
    expect(result.reasons.join("\n")).toContain("install");
  });

  test("missing `git` (fatal) blocks", () => {
    const result = startupBlocking([
      ok("Claude Code CLI (`claude`)", "fatal"),
      bad("git", "fatal", "install git"),
      ok("glab (GitLab CLI) + auth", "warn"),
    ]);
    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toMatch(/git/i);
  });

  test("no authed provider is a warning, not a block — fatals still pass", () => {
    const result = startupBlocking([
      ok("Claude Code CLI (`claude`)", "fatal"),
      ok("git", "fatal"),
      bad("glab (GitLab CLI)", "info", "brew install glab"),
      bad("gh (GitHub CLI)", "info", "brew install gh"),
    ]);
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});

describe("noAuthedProvider", () => {
  test("true when both glab and gh are missing", () => {
    const flag = noAuthedProvider([
      ok("Claude Code CLI (`claude`)", "fatal"),
      ok("git", "fatal"),
      bad("glab (GitLab CLI)", "info", "brew install glab"),
      bad("gh (GitHub CLI)", "info", "brew install gh"),
    ]);
    expect(flag).toBe(true);
  });

  test("true when provider CLI is present but not authed", () => {
    const flag = noAuthedProvider([
      ok("Claude Code CLI (`claude`)", "fatal"),
      ok("git", "fatal"),
      bad("glab (GitLab CLI) + auth", "warn", "run `glab auth login`"),
      bad("gh (GitHub CLI)", "info", "brew install gh"),
    ]);
    expect(flag).toBe(true);
  });

  test("false when any provider is authed", () => {
    const flag = noAuthedProvider([
      ok("Claude Code CLI (`claude`)", "fatal"),
      ok("git", "fatal"),
      ok("gh (GitHub CLI) + auth", "warn"),
      bad("glab (GitLab CLI)", "info", "brew install glab"),
    ]);
    expect(flag).toBe(false);
  });
});
