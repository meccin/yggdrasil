import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Agent, FinalizeMode, RepoConfig } from "../types";
import type { Issue } from "../sources/types";
import { store } from "../store";
import {
  resolveAllowedTools,
  resolveDisallowedTools,
  resolvePermissionMode,
  resolveSettingsPath,
} from "../config";
import { addWorktree, isValidWorktree, removeWorktree } from "./worktree";
import { buildPrompt, killAgent, spawnAgent } from "./runner";
import { finalize } from "./finalize";
import { getSource } from "../sources";
import { recordMetric } from "../metrics";

const now = () => Date.now();

// Wraps the spawn + onExit lifecycle so both the initial spawn and `respawn`
// reuse the same Claude/permission/tool resolution and finalize/error
// transitions. Pulls `state.config` fresh so per-repo overrides edited
// between runs are picked up on the next launch.
const launchClaude = (
  agent: Agent,
  repo: RepoConfig,
  mode: FinalizeMode,
  prompt: string,
): void => {
  const state = store.getState();
  const permissionMode = resolvePermissionMode(state.config, repo);
  const allowedTools = resolveAllowedTools(state.config, repo);
  const disallowedTools = resolveDisallowedTools(state.config, repo);
  const settingsPath = resolveSettingsPath(state.config, repo);

  spawnAgent({
    agent,
    prompt,
    permissionMode,
    claudeConfigDir: repo.claudeConfigDir,
    allowedTools,
    disallowedTools,
    settingsPath,
    onExit: async (code) => {
      const cur = store.getState().agents[agent.id];
      if (!cur) return;
      const finishMetric = (status: typeof cur.status, error?: string) => {
        recordMetric({
          ts: now(),
          kind: "agent_end",
          agentId: agent.id,
          repo: repo.name,
          issueId: agent.issueId,
          status,
          durationMs: Date.now() - agent.startedAt,
          inputTokens: store.getState().agents[agent.id]?.inputTokens || 0,
          outputTokens: store.getState().agents[agent.id]?.outputTokens || 0,
          mrUrl: store.getState().agents[agent.id]?.mrUrl,
          error,
        });
      };
      if (cur.status === "killed") {
        finishMetric("killed");
        return;
      }
      if (code !== 0) {
        store.getState().updateAgent(agent.id, { errorMessage: `claude exit ${code}` });
        store.getState().setStatus(agent.id, "failed");
        finishMetric("failed", `claude exit ${code}`);
        return;
      }
      try {
        await finalize(cur, repo, mode);
        const final = store.getState().agents[agent.id];
        finishMetric(final?.status || "done", final?.errorMessage);
      } catch (err) {
        store.getState().updateAgent(agent.id, { errorMessage: (err as Error).message });
        store.getState().setStatus(agent.id, "failed");
        finishMetric("failed", (err as Error).message);
      }
    },
  });
};

export const spawnAgentForIssue = async (
  repo: RepoConfig,
  issue: Issue,
  mode: FinalizeMode,
): Promise<{ ok: boolean; agentId?: string; error?: string }> => {
  const state = store.getState();
  const dup = Object.values(state.agents).find(
    (a) =>
      a.repoName === repo.name &&
      a.issueId === issue.iid &&
      ["queued", "running"].includes(a.status),
  );
  if (dup) return { ok: false, error: `agent already active (${dup.id.slice(0, 8)})` };

  const id = randomUUID();
  let wt;
  try {
    wt = addWorktree(repo.name, repo.path, issue.iid);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const agent: Agent = {
    id,
    repoName: repo.name,
    issueId: issue.iid,
    issueTitle: issue.title,
    branch: wt.branch,
    worktreePath: wt.path,
    mode,
    status: "queued",
    startedAt: now(),
    inputTokens: 0,
    outputTokens: 0,
    log: [
      {
        ts: now(),
        kind: "system",
        text: `worktree: ${wt.path} · branch: ${wt.branch} · mode: ${mode}`,
      },
    ],
  };
  store.getState().addAgent(agent);

  recordMetric({
    ts: now(),
    kind: "agent_start",
    agentId: id,
    repo: repo.name,
    issueId: issue.iid,
    mode,
  });

  const prompt = buildPrompt(issue.title, issue.description || "", issue.iid);
  launchClaude(agent, repo, mode, prompt);

  return { ok: true, agentId: id };
};

// Re-spawn a previously-failed/killed/dry agent without losing its worktree,
// branch, or accumulated commits. The agent record is mutated in place
// (same id) so the user keeps the agent card and log history; new run is
// distinguishable via a `system: respawn` log line and a fresh agent_start
// metric event.
export const respawnFailedAgent = async (
  id: string,
): Promise<{ ok: boolean; error?: string }> => {
  const s = store.getState();
  const agent = s.agents[id];
  if (!agent) return { ok: false, error: "agent not found" };

  const respawnable: Agent["status"][] = ["failed", "killed", "done-dry"];
  if (!respawnable.includes(agent.status)) {
    return {
      ok: false,
      error: `cannot re-spawn from status ${agent.status}`,
    };
  }

  const dup = Object.values(s.agents).find(
    (a) =>
      a.id !== id &&
      a.repoName === agent.repoName &&
      a.issueId === agent.issueId &&
      ["queued", "running"].includes(a.status),
  );
  if (dup) {
    return { ok: false, error: `another agent already active (${dup.id.slice(0, 8)})` };
  }

  const repo = s.config.repos.find((r) => r.name === agent.repoName);
  if (!repo) return { ok: false, error: "repo no longer configured" };

  // Reuse worktree+branch when intact; rebuild when the directory was wiped
  // (e.g. a manual `git worktree remove` outside the TUI between runs).
  if (!existsSync(agent.worktreePath) || !isValidWorktree(agent.worktreePath)) {
    try {
      const wt = addWorktree(repo.name, repo.path, agent.issueId);
      agent.worktreePath = wt.path;
      agent.branch = wt.branch;
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  // Pull the latest issue body so edits made on the GitLab/GitHub side after
  // the initial run reach the re-spawned agent.
  const refreshed = (() => {
    try {
      return getSource(repo.provider).view(repo.remoteRepo, agent.issueId);
    } catch {
      return null;
    }
  })();
  const issueTitle = refreshed?.title || agent.issueTitle;
  const issueBody = refreshed?.description || "";

  const reason = agent.errorMessage || `previous status: ${agent.status}`;
  const respawnEvent = { ts: now(), kind: "system" as const, text: `respawn: ${reason}` };

  s.updateAgent(id, {
    issueTitle,
    status: "queued",
    errorMessage: undefined,
    endedAt: undefined,
    pid: undefined,
    inputTokens: 0,
    outputTokens: 0,
    currentTool: undefined,
    lastText: undefined,
    startedAt: now(),
  });
  s.appendEvent(id, respawnEvent);

  recordMetric({
    ts: now(),
    kind: "agent_start",
    agentId: id,
    repo: repo.name,
    issueId: agent.issueId,
    mode: agent.mode,
  });

  const live = store.getState().agents[id];
  if (!live) return { ok: false, error: "agent vanished after reset" };

  const prompt = buildPrompt(issueTitle, issueBody, agent.issueId);
  launchClaude(live, repo, agent.mode, prompt);

  return { ok: true };
};

export const killAgentById = (id: string): void => {
  killAgent(id);
  store.getState().setStatus(id, "killed");
};

export const deleteAgentArtifacts = (id: string, deleteBranch = true): void => {
  const s = store.getState();
  const agent = s.agents[id];
  if (!agent) return;
  const repo = s.config.repos.find((r) => r.name === agent.repoName);
  if (repo) {
    try {
      removeWorktree(repo.path, agent.worktreePath, agent.branch, { deleteBranch });
    } catch {}
  }
  s.removeAgent(id);
};

export const hasCapacity = (): boolean => {
  const s = store.getState();
  return s.runningCount() < s.config.maxConcurrent;
};
