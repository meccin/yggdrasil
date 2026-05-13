import { describe, test, expect, beforeEach } from "bun:test";
import { store } from "../src/store";
import { respawnFailedAgent } from "../src/agent/orchestrator";
import type { Agent, GlobalConfig, RepoConfig } from "../src/types";

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

const baseConfig: GlobalConfig = {
  permissionMode: "acceptEdits",
  maxConcurrent: 3,
  pollIntervalSec: 300,
  defaultMode: "review",
  allowedTools: ["Read"],
  disallowedTools: [],
  settingsPath: null,
  notifications: true,
  repos: [baseRepo],
};

const mkAgent = (overrides: Partial<Agent> = {}): Agent => ({
  id: "agent-1",
  repoName: "owner/proj",
  issueId: 1,
  issueTitle: "Test issue",
  branch: "agent/issue-1",
  worktreePath: "/tmp/wt/owner-proj/issue-1",
  mode: "review",
  status: "failed",
  startedAt: 0,
  inputTokens: 0,
  outputTokens: 0,
  log: [],
  errorMessage: "previous run died",
  ...overrides,
});

const resetStore = (agents: Agent[], repos: RepoConfig[] = [baseRepo]) => {
  const map: Record<string, Agent> = {};
  for (const a of agents) map[a.id] = a;
  store.setState({
    config: { ...baseConfig, repos },
    agents: map,
    issuesByRepo: {},
    focus: { pane: "issues", repoIdx: 0, issueIdx: 0, agentIdx: 0 },
    totalInTokens: 0,
    totalOutTokens: 0,
    nextPollAt: undefined,
  });
};

beforeEach(() => resetStore([]));

describe("respawnFailedAgent — rejection paths (no IO)", () => {
  test("returns error when agent id is unknown", async () => {
    const r = await respawnFailedAgent("nope");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("agent not found");
  });

  test("rejects when agent is running", async () => {
    resetStore([mkAgent({ status: "running" })]);
    const r = await respawnFailedAgent("agent-1");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("running");
  });

  test("rejects when agent is queued", async () => {
    resetStore([mkAgent({ status: "queued" })]);
    const r = await respawnFailedAgent("agent-1");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("queued");
  });

  test("rejects when agent finished as `done` (intentional terminal)", async () => {
    resetStore([mkAgent({ status: "done" })]);
    const r = await respawnFailedAgent("agent-1");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("done");
  });

  test("rejects when agent is `awaiting-review` (review pending)", async () => {
    resetStore([mkAgent({ status: "awaiting-review" })]);
    const r = await respawnFailedAgent("agent-1");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("awaiting-review");
  });

  test("rejects when another agent for the same (repo, issue) is active", async () => {
    resetStore([
      mkAgent({ status: "failed" }),
      mkAgent({ id: "agent-2", status: "running" }),
    ]);
    const r = await respawnFailedAgent("agent-1");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("already active");
  });

  test("rejects when repo was removed from config", async () => {
    resetStore([mkAgent({ status: "failed" })], []); // empty repo list
    const r = await respawnFailedAgent("agent-1");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("repo no longer configured");
  });
});
