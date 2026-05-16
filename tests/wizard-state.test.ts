import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  advancePreset,
  advanceProvider,
  advanceRepoPath,
  advanceSettings,
  advanceWelcome,
  initialState,
  previousStep,
  stepIndex,
  toRepoConfig,
  validateRepoPath,
} from "../src/ui/wizard/state";
import type { RemoteInfo } from "../src/sources";

const mkTmp = (): string => mkdtempSync(join(tmpdir(), "ygg-wizard-"));

describe("initialState", () => {
  test("starts at welcome with sensible defaults", () => {
    const s = initialState("/home/me/proj");
    expect(s.step).toBe("welcome");
    expect(s.path).toBe("/home/me/proj");
    expect(s.preset).toBe("balanced");
    expect(s.label).toBe("agent-ready");
    expect(s.mode).toBe("review");
    expect(s.detected).toBeNull();
    expect(s.error).toBeNull();
  });
});

describe("stepIndex", () => {
  test("numbers the 5 input steps 1..5 and treats finish as the last step", () => {
    expect(stepIndex("welcome")).toBe(1);
    expect(stepIndex("repoPath")).toBe(2);
    expect(stepIndex("provider")).toBe(3);
    expect(stepIndex("preset")).toBe(4);
    expect(stepIndex("settings")).toBe(5);
    expect(stepIndex("finish")).toBe(5);
  });
});

describe("validateRepoPath", () => {
  test("rejects empty input", () => {
    const v = validateRepoPath("");
    expect(v.ok).toBe(false);
    expect(v.error).toContain("empty");
  });

  test("rejects non-existent paths", () => {
    const v = validateRepoPath("/tmp/__ygg-does-not-exist-12345__");
    expect(v.ok).toBe(false);
    expect(v.error).toContain("does not exist");
  });

  test("rejects non-git directories", () => {
    const dir = mkTmp();
    try {
      const v = validateRepoPath(dir);
      expect(v.ok).toBe(false);
      expect(v.error).toContain("git working tree");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects git repos without an `origin` remote", () => {
    const dir = mkTmp();
    try {
      spawnSync("git", ["init", "-q"], { cwd: dir });
      const v = validateRepoPath(dir);
      expect(v.ok).toBe(false);
      expect(v.error).toMatch(/origin/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts a git repo with a GitLab origin and detects provider+slug", () => {
    const dir = mkTmp();
    try {
      spawnSync("git", ["init", "-q"], { cwd: dir });
      spawnSync("git", ["remote", "add", "origin", "git@gitlab.com:foo/bar.git"], {
        cwd: dir,
      });
      const v = validateRepoPath(dir);
      expect(v.ok).toBe(true);
      expect(v.detected).toEqual({ provider: "gitlab", repo: "foo/bar" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts a git repo with a self-hosted GitLab origin and prefixes the host", () => {
    const dir = mkTmp();
    try {
      spawnSync("git", ["init", "-q"], { cwd: dir });
      spawnSync(
        "git",
        ["remote", "add", "origin", "git@gitlab.example.com:team/proj.git"],
        { cwd: dir },
      );
      const v = validateRepoPath(dir);
      expect(v.ok).toBe(true);
      expect(v.detected).toEqual({
        provider: "gitlab",
        repo: "gitlab.example.com/team/proj",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("advance transitions", () => {
  test("welcome → repoPath", () => {
    const s0 = initialState("/x");
    const s1 = advanceWelcome(s0);
    expect(s1.step).toBe("repoPath");
    expect(s1.error).toBeNull();
  });

  test("repoPath stays put with an error when path is invalid", () => {
    const s0 = { ...initialState("/x"), step: "repoPath" as const };
    const s1 = advanceRepoPath(s0, "/tmp/__nope__");
    expect(s1.step).toBe("repoPath");
    expect(s1.error).toBeTruthy();
    expect(s1.detected).toBeNull();
  });

  test("repoPath advances to provider with detected info when valid", () => {
    const dir = mkTmp();
    try {
      spawnSync("git", ["init", "-q"], { cwd: dir });
      spawnSync(
        "git",
        ["remote", "add", "origin", "https://github.com/foo/bar.git"],
        { cwd: dir },
      );
      const s0 = { ...initialState(dir), step: "repoPath" as const };
      const s1 = advanceRepoPath(s0, dir);
      expect(s1.step).toBe("provider");
      expect(s1.detected).toEqual({ provider: "github", repo: "foo/bar" });
      expect(s1.provider).toBe("github");
      expect(s1.error).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider → preset preserves the override", () => {
    const s0 = { ...initialState("/x"), step: "provider" as const };
    const s1 = advanceProvider(s0, "github");
    expect(s1.step).toBe("preset");
    expect(s1.provider).toBe("github");
  });

  test("preset → settings preserves the selection", () => {
    const s0 = { ...initialState("/x"), step: "preset" as const };
    const s1 = advancePreset(s0, "yolo");
    expect(s1.step).toBe("settings");
    expect(s1.preset).toBe("yolo");
  });

  test("settings → finish records label + mode and trims label", () => {
    const s0 = { ...initialState("/x"), step: "settings" as const };
    const s1 = advanceSettings(s0, "  agent-ready  ", "mr");
    expect(s1.step).toBe("finish");
    expect(s1.label).toBe("agent-ready");
    expect(s1.mode).toBe("mr");
  });

  test("settings → finish falls back to default label when input is blank", () => {
    const s0 = { ...initialState("/x"), step: "settings" as const };
    const s1 = advanceSettings(s0, "   ", "review");
    expect(s1.label).toBe("agent-ready");
  });

  test("previousStep walks back through the order", () => {
    const s = { ...initialState("/x"), step: "preset" as const };
    expect(previousStep(s).step).toBe("provider");
    expect(previousStep(previousStep(s)).step).toBe("repoPath");
  });
});

describe("toRepoConfig", () => {
  const detected: RemoteInfo = { provider: "gitlab", repo: "owner/proj" };

  test("yolo preset writes bypassPermissions + standard allowlist + repo-level fields", () => {
    const state = {
      step: "finish" as const,
      path: "/abs/path",
      detected,
      provider: "gitlab" as const,
      preset: "yolo" as const,
      label: "agent-ready",
      mode: "review" as const,
      error: null,
    };
    const cfg = toRepoConfig(state);
    expect(cfg.permissionMode).toBe("bypassPermissions");
    expect(cfg.allowedTools).toEqual(["Read", "Write", "Edit", "Glob", "Grep", "Bash"]);
    expect(cfg.disallowedTools).toBeNull();
    expect(cfg.settingsPath).toBeNull();
    expect(cfg.profile).toBeNull();
    expect(cfg.autoSpawn).toBe(false);
    expect(cfg.autoSpawnLabel).toBe("agent-ready");
    expect(cfg.defaultMode).toBe("review");
    expect(cfg.provider).toBe("gitlab");
    expect(cfg.remoteRepo).toBe("owner/proj");
  });

  test("safe preset writes dontAsk + git-only Bash", () => {
    const state = {
      step: "finish" as const,
      path: "/abs/path",
      detected,
      provider: "gitlab" as const,
      preset: "safe" as const,
      label: "ready",
      mode: "mr" as const,
      error: null,
    };
    const cfg = toRepoConfig(state);
    expect(cfg.permissionMode).toBe("dontAsk");
    expect(cfg.allowedTools).toEqual([
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash(git *)",
    ]);
    expect(cfg.autoSpawnLabel).toBe("ready");
    expect(cfg.defaultMode).toBe("mr");
  });

  test("throws when finish state has no detected remote (defensive)", () => {
    const state = {
      step: "finish" as const,
      path: "/abs/path",
      detected: null,
      provider: "gitlab" as const,
      preset: "balanced" as const,
      label: "agent-ready",
      mode: "review" as const,
      error: null,
    };
    expect(() => toRepoConfig(state)).toThrow();
  });
});

// Guard: tmpdir creation should land outside the project, so cleanup never
// touches user files.
describe("test fixture sanity", () => {
  test("mkTmp returns a fresh existing directory under tmpdir()", () => {
    const dir = mkTmp();
    try {
      expect(existsSync(dir)).toBe(true);
      expect(dir.startsWith(tmpdir())).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
