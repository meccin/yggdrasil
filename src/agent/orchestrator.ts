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
import { addWorktree, removeWorktree } from "./worktree";
import { buildPrompt, killAgent, spawnAgent } from "./runner";
import { finalize } from "./finalize";
import { recordMetric } from "../metrics";

const now = () => Date.now();

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
      const cur = store.getState().agents[id];
      if (!cur) return;
      const finishMetric = (status: typeof cur.status, error?: string) => {
        recordMetric({
          ts: now(),
          kind: "agent_end",
          agentId: id,
          repo: repo.name,
          issueId: issue.iid,
          status,
          durationMs: Date.now() - agent.startedAt,
          inputTokens: store.getState().agents[id]?.inputTokens || 0,
          outputTokens: store.getState().agents[id]?.outputTokens || 0,
          mrUrl: store.getState().agents[id]?.mrUrl,
          error,
        });
      };
      if (cur.status === "killed") {
        finishMetric("killed");
        return;
      }
      if (code !== 0) {
        store.getState().updateAgent(id, { errorMessage: `claude exit ${code}` });
        store.getState().setStatus(id, "failed");
        finishMetric("failed", `claude exit ${code}`);
        return;
      }
      try {
        await finalize(cur, repo, mode);
        const final = store.getState().agents[id];
        finishMetric(final?.status || "done", final?.errorMessage);
      } catch (err) {
        store.getState().updateAgent(id, { errorMessage: (err as Error).message });
        store.getState().setStatus(id, "failed");
        finishMetric("failed", (err as Error).message);
      }
    },
  });

  return { ok: true, agentId: id };
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
