import { describe, test, expect } from "bun:test";
import { resolvePermissionMode, resolveMode } from "../src/config";
import type { GlobalConfig, RepoConfig } from "../src/types";

const baseGlobal: GlobalConfig = {
  permissionMode: "acceptEdits",
  maxConcurrent: 3,
  pollIntervalSec: 300,
  defaultMode: "review",
  allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
  disallowedTools: [],
  settingsPath: null,
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

describe("resolvePermissionMode", () => {
  test("inherits global when repo override is null", () => {
    expect(resolvePermissionMode(baseGlobal, baseRepo)).toBe("acceptEdits");
  });

  test("repo override wins over global", () => {
    expect(
      resolvePermissionMode(baseGlobal, { ...baseRepo, permissionMode: "bypassPermissions" }),
    ).toBe("bypassPermissions");
  });
});

describe("resolveMode", () => {
  test("inherits global when repo override is null", () => {
    expect(resolveMode(baseGlobal, baseRepo)).toBe("review");
  });

  test("repo override wins", () => {
    expect(resolveMode(baseGlobal, { ...baseRepo, defaultMode: "mr" })).toBe("mr");
  });
});
