import { describe, test, expect } from "bun:test";
import {
  DEFAULT_ALLOWED_TOOLS,
  resolveAllowedTools,
  resolveDisallowedTools,
  resolveSettingsPath,
} from "../src/config";
import type { GlobalConfig, RepoConfig } from "../src/types";

const baseGlobal: GlobalConfig = {
  permissionMode: "acceptEdits",
  maxConcurrent: 3,
  pollIntervalSec: 300,
  defaultMode: "review",
  allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
  disallowedTools: ["Bash(rm *)"],
  settingsPath: "/etc/global-claude-settings.json",
  notifications: true,
  repos: [],
};

const baseRepo: RepoConfig = {
  name: "owner/proj",
  path: "/tmp/x",
  provider: "gitlab",
  remoteRepo: "owner/proj",
  autoSpawn: false,
  autoSpawnLabel: "agent-ready",
  permissionMode: null,
  defaultMode: null,
  claudeConfigDir: null,
  allowedTools: null,
  disallowedTools: null,
  settingsPath: null,
};

describe("DEFAULT_ALLOWED_TOOLS", () => {
  test("matches the v0.6 user-chosen baseline exactly", () => {
    expect(DEFAULT_ALLOWED_TOOLS).toEqual([
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
    ]);
  });
});

describe("resolveAllowedTools", () => {
  test("inherits global when repo override is null", () => {
    expect(resolveAllowedTools(baseGlobal, baseRepo)).toEqual(baseGlobal.allowedTools);
  });

  test("repo override fully replaces the global allowlist", () => {
    const repo = { ...baseRepo, allowedTools: ["Read"] };
    expect(resolveAllowedTools(baseGlobal, repo)).toEqual(["Read"]);
  });

  test("an explicit empty array on the repo is honored as an override (returns [])", () => {
    const repo = { ...baseRepo, allowedTools: [] };
    expect(resolveAllowedTools(baseGlobal, repo)).toEqual([]);
  });
});

describe("resolveDisallowedTools", () => {
  test("inherits global when repo override is null", () => {
    expect(resolveDisallowedTools(baseGlobal, baseRepo)).toEqual(["Bash(rm *)"]);
  });

  test("repo override fully replaces the global denylist", () => {
    const repo = { ...baseRepo, disallowedTools: ["Bash(git push --force *)"] };
    expect(resolveDisallowedTools(baseGlobal, repo)).toEqual([
      "Bash(git push --force *)",
    ]);
  });
});

describe("resolveSettingsPath", () => {
  test("inherits global when repo override is null", () => {
    expect(resolveSettingsPath(baseGlobal, baseRepo)).toBe(
      "/etc/global-claude-settings.json",
    );
  });

  test("repo override wins", () => {
    const repo = { ...baseRepo, settingsPath: "/etc/strict.json" };
    expect(resolveSettingsPath(baseGlobal, repo)).toBe("/etc/strict.json");
  });
});
