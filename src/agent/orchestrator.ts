import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Agent, FinalizeMode, RepoConfig } from "../types";
import type { Issue, MergeRequest } from "../sources/types";
import { store } from "../store";
import {
  resolveAllowedTools,
  resolveDisallowedTools,
  resolvePermissionMode,
  resolveProfile,
  resolveProfileName,
  resolveSettingsPath,
} from "../config";
import {
  addReadOnlyWorktreeForMr,
  addWorktree,
  isValidWorktree,
  removeWorktree,
} from "./worktree";
import { buildMrReviewPrompt, buildPrompt, killAgent, spawnAgent } from "./runner";
import { finalize } from "./finalize";
import { getSource } from "../sources";
import { recordMetric } from "../metrics";
import { notify } from "../notify";
import { interpolate, type Profile, type ProfileStep } from "../profile";

// Tools blocked in MR-review mode so the agent can read but never edit. Layered
// on top of the user's configured disallowedTools.
const MR_REVIEW_BLOCK = ["Edit", "Write", "NotebookEdit"];

const maybeNotify = (
  repo: RepoConfig,
  agent: Agent,
  status: Agent["status"],
): void => {
  if (!store.getState().config.notifications) return;
  const title = `Yggdrasil · ${repo.name}`;
  const glyph = agent.kind === "mr" ? "!" : "#";
  const body = `${glyph}${agent.issueId} ${agent.issueTitle} — ${status}`;
  notify(title, body);
};

const now = () => Date.now();

const finishMetric = (
  agent: Agent,
  repo: RepoConfig,
  status: Agent["status"],
  error?: string,
): void => {
  const cur = store.getState().agents[agent.id];
  recordMetric({
    ts: now(),
    kind: "agent_end",
    agentId: agent.id,
    repo: repo.name,
    issueId: agent.issueId,
    status,
    durationMs: Date.now() - agent.startedAt,
    inputTokens: cur?.inputTokens || 0,
    outputTokens: cur?.outputTokens || 0,
    mrUrl: cur?.mrUrl,
    error,
  });
};

const log = (id: string, text: string): void => {
  store.getState().appendEvent(id, { ts: now(), kind: "system", text });
};

const buildVars = (agent: Agent, issue: Issue, repo: RepoConfig, step: ProfileStep) => ({
  issue: {
    id: issue.iid,
    title: issue.title,
    body: issue.description || "",
  },
  branch: agent.branch,
  worktree: agent.worktreePath,
  repo: { name: repo.name, remoteRepo: repo.remoteRepo },
  step: { name: step.name },
});

// Classic single-shot path: one spawn, finalize on exit. Used when neither
// global nor repo references a profile.
const launchSingleShot = (
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
      if (cur.status === "killed") {
        finishMetric(agent, repo, "killed");
        maybeNotify(repo, agent, "killed");
        return;
      }
      if (code !== 0) {
        store.getState().updateAgent(agent.id, { errorMessage: `claude exit ${code}` });
        store.getState().setStatus(agent.id, "failed");
        finishMetric(agent, repo, "failed", `claude exit ${code}`);
        maybeNotify(repo, agent, "failed");
        return;
      }
      try {
        await finalize(cur, repo, mode);
        const final = store.getState().agents[agent.id];
        const status = final?.status || "done";
        finishMetric(agent, repo, status, final?.errorMessage);
        maybeNotify(repo, agent, status);
      } catch (err) {
        store.getState().updateAgent(agent.id, { errorMessage: (err as Error).message });
        store.getState().setStatus(agent.id, "failed");
        finishMetric(agent, repo, "failed", (err as Error).message);
        maybeNotify(repo, agent, "failed");
      }
    },
  });
};

// Multi-step pipeline path. Walks `profile.steps` sequentially, spawning a
// fresh `claude -p` for each. Each step's prompt = `${command} ${args}` after
// {{var}} interpolation. Token counters carry across steps via the
// runner's tokenBaseline option so the agent card shows cumulative totals.
const launchPipeline = (
  agent: Agent,
  repo: RepoConfig,
  mode: FinalizeMode,
  issue: Issue,
  profile: Profile,
): void => {
  const total = profile.steps.length;
  store.getState().updateAgent(agent.id, { currentStep: 0, totalSteps: total });

  const runStep = (idx: number): void => {
    // Status may have flipped to `killed` between steps via the TUI. Re-read
    // the live agent and bail before spawning if so.
    const live = store.getState().agents[agent.id];
    if (!live) return;
    if (live.status === "killed" || live.status === "failed") {
      finishMetric(agent, repo, live.status, live.errorMessage);
      maybeNotify(repo, agent, live.status);
      return;
    }

    const step = profile.steps[idx];
    log(agent.id, `step ${idx + 1}/${total}: ${step.name}`);
    store.getState().updateAgent(agent.id, { currentStep: idx });

    const vars = buildVars(live, issue, repo, step);
    const argsInterpolated = interpolate(step.args, vars);
    const prompt = argsInterpolated
      ? `${step.command} ${argsInterpolated}`
      : step.command;

    const cfg = store.getState().config;
    const permissionMode =
      step.permissionMode || resolvePermissionMode(cfg, repo);
    const allowedTools =
      step.allowedTools ?? resolveAllowedTools(cfg, repo);
    const disallowedTools =
      step.disallowedTools ?? resolveDisallowedTools(cfg, repo);
    const settingsPath = resolveSettingsPath(cfg, repo);

    const baseline = {
      input: live.inputTokens || 0,
      output: live.outputTokens || 0,
    };

    spawnAgent({
      agent: live,
      prompt,
      permissionMode,
      claudeConfigDir: repo.claudeConfigDir,
      allowedTools,
      disallowedTools,
      settingsPath,
      tokenBaseline: baseline,
      onExit: async (code) => {
        const cur = store.getState().agents[agent.id];
        if (!cur) return;
        if (cur.status === "killed") {
          finishMetric(agent, repo, "killed");
          maybeNotify(repo, agent, "killed");
          return;
        }
        if (code !== 0) {
          const msg = `step ${idx + 1}/${total} (${step.name}) failed: claude exit ${code}`;
          log(agent.id, msg);
          store.getState().updateAgent(agent.id, { errorMessage: msg });
          store.getState().setStatus(agent.id, "failed");
          finishMetric(agent, repo, "failed", msg);
          maybeNotify(repo, agent, "failed");
          return;
        }
        if (idx + 1 < total) {
          runStep(idx + 1);
          return;
        }
        // Last step succeeded → finalize once (push + MR/PR + comment).
        try {
          await finalize(cur, repo, mode);
          const final = store.getState().agents[agent.id];
          const status = final?.status || "done";
          finishMetric(agent, repo, status, final?.errorMessage);
          maybeNotify(repo, agent, status);
        } catch (err) {
          store.getState().updateAgent(agent.id, { errorMessage: (err as Error).message });
          store.getState().setStatus(agent.id, "failed");
          finishMetric(agent, repo, "failed", (err as Error).message);
          maybeNotify(repo, agent, "failed");
        }
      },
    });
  };

  runStep(0);
};

// Single entry point used by both initial spawn and respawn. Resolves the
// profile fresh from disk on every launch so edits made between runs are
// picked up. A validation error throws and surfaces to the caller.
const launchAgent = (
  agent: Agent,
  repo: RepoConfig,
  mode: FinalizeMode,
  issue: Issue,
): void => {
  const cfg = store.getState().config;
  const requestedName = resolveProfileName(cfg, repo);
  let profile: Profile | null = null;
  try {
    profile = resolveProfile(cfg, repo);
  } catch (err) {
    const msg = `profile load failed: ${(err as Error).message}`;
    log(agent.id, msg);
    store.getState().updateAgent(agent.id, { errorMessage: msg });
    store.getState().setStatus(agent.id, "failed");
    finishMetric(agent, repo, "failed", msg);
    maybeNotify(repo, agent, "failed");
    return;
  }

  // A name is configured but the file vanished. Fail loud — falling back to
  // classic single-shot here would silently violate the user's intent.
  if (requestedName && !profile) {
    const msg = `profile "${requestedName}" referenced but file is missing — run \`ygg doctor\` and reset with \`ygg config set --profile none\` (or restore the file)`;
    log(agent.id, msg);
    store.getState().updateAgent(agent.id, { errorMessage: msg });
    store.getState().setStatus(agent.id, "failed");
    finishMetric(agent, repo, "failed", msg);
    maybeNotify(repo, agent, "failed");
    return;
  }

  if (!profile) {
    const prompt = buildPrompt(issue.title, issue.description || "", issue.iid);
    launchSingleShot(agent, repo, mode, prompt);
    return;
  }

  log(agent.id, `profile: ${profile.name} (${profile.steps.length} steps)`);
  launchPipeline(agent, repo, mode, issue, profile);
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
      a.kind === "issue" &&
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
    kind: "issue",
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

  launchAgent(agent, repo, mode, issue);

  return { ok: true, agentId: id };
};

// MR-review single-shot: read-only worktree at MR head, claude posts a summary
// review comment, no branch is created or pushed. Profile pipelines are not
// supported for MR-review in V1 — always classic single-shot.
export const spawnAgentForMr = async (
  repo: RepoConfig,
  mr: MergeRequest,
  opts: { inline?: boolean } = {},
): Promise<{ ok: boolean; agentId?: string; error?: string }> => {
  const state = store.getState();
  const dup = Object.values(state.agents).find(
    (a) =>
      a.repoName === repo.name &&
      a.kind === "mr" &&
      a.issueId === mr.iid &&
      ["queued", "running"].includes(a.status),
  );
  if (dup) return { ok: false, error: `agent already active (${dup.id.slice(0, 8)})` };

  let wt;
  try {
    wt = addReadOnlyWorktreeForMr(repo.name, repo.path, repo.provider, mr.iid, repo.remoteRepo);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const source = getSource(repo.provider);
  const diff = source.getMrDiff(repo.remoteRepo, mr.iid);
  const inline = opts.inline ?? repo.mrReviewInlineDefault ?? false;
  const prompt = buildMrReviewPrompt(
    {
      iid: mr.iid,
      title: mr.title,
      description: mr.description,
      source_branch: mr.source_branch,
      target_branch: mr.target_branch,
      web_url: mr.web_url,
    },
    diff,
    inline,
  );

  const id = randomUUID();
  const agent: Agent = {
    id,
    repoName: repo.name,
    kind: "mr",
    issueId: mr.iid,
    issueTitle: mr.title,
    branch: wt.branch,
    worktreePath: wt.path,
    mode: "mr-review",
    status: "queued",
    startedAt: now(),
    inputTokens: 0,
    outputTokens: 0,
    mrIid: mr.iid,
    mrSourceBranch: mr.source_branch,
    mrReviewInline: inline,
    mrUrl: mr.web_url,
    log: [
      {
        ts: now(),
        kind: "system",
        text: `mr-review worktree: ${wt.path} · !${mr.iid} · inline:${inline}`,
      },
    ],
  };
  store.getState().addAgent(agent);

  recordMetric({
    ts: now(),
    kind: "agent_start",
    agentId: id,
    repo: repo.name,
    issueId: mr.iid,
    mode: "mr-review",
  });

  const cfg = state.config;
  const permissionMode = resolvePermissionMode(cfg, repo);
  const allowedTools = resolveAllowedTools(cfg, repo);
  const disallowedTools = [
    ...new Set([...(resolveDisallowedTools(cfg, repo) || []), ...MR_REVIEW_BLOCK]),
  ];
  const settingsPath = resolveSettingsPath(cfg, repo);

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
      if (cur.status === "killed") {
        finishMetric(agent, repo, "killed");
        maybeNotify(repo, agent, "killed");
        return;
      }
      if (code !== 0) {
        store.getState().updateAgent(id, { errorMessage: `claude exit ${code}` });
        store.getState().setStatus(id, "failed");
        finishMetric(agent, repo, "failed", `claude exit ${code}`);
        maybeNotify(repo, agent, "failed");
        return;
      }
      try {
        await finalize(cur, repo, "mr-review");
        const final = store.getState().agents[id];
        const status = final?.status || "done";
        finishMetric(agent, repo, status, final?.errorMessage);
        maybeNotify(repo, agent, status);
      } catch (err) {
        store.getState().updateAgent(id, { errorMessage: (err as Error).message });
        store.getState().setStatus(id, "failed");
        finishMetric(agent, repo, "failed", (err as Error).message);
        maybeNotify(repo, agent, "failed");
      }
    },
  });

  return { ok: true, agentId: id };
};

// Re-spawn a previously-failed/killed/dry agent without losing its worktree,
// branch, or accumulated commits. The agent record is mutated in place
// (same id) so the user keeps the agent card and log history; new run is
// distinguishable via a `system: respawn` log line and a fresh agent_start
// metric event. Profile pipelines restart from step 0.
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

  // Re-spawn only handles classic issue agents — MR-review agents have no
  // branch to preserve, so re-running is identical to a fresh spawn from the
  // MRs tab. Block here to avoid recreating the wrong (issue-shaped) worktree.
  if (agent.kind === "mr") {
    return {
      ok: false,
      error: "re-spawn unsupported for MR review — spawn a new one from the MRs tab",
    };
  }

  const dup = Object.values(s.agents).find(
    (a) =>
      a.id !== id &&
      a.repoName === agent.repoName &&
      a.kind === agent.kind &&
      a.issueId === agent.issueId &&
      ["queued", "running"].includes(a.status),
  );
  if (dup) {
    return { ok: false, error: `another agent already active (${dup.id.slice(0, 8)})` };
  }

  const repo = s.config.repos.find((r) => r.name === agent.repoName);
  if (!repo) return { ok: false, error: "repo no longer configured" };

  if (!existsSync(agent.worktreePath) || !isValidWorktree(agent.worktreePath)) {
    try {
      const wt = addWorktree(repo.name, repo.path, agent.issueId);
      agent.worktreePath = wt.path;
      agent.branch = wt.branch;
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

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
    currentStep: undefined,
    totalSteps: undefined,
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

  const issue: Issue = {
    iid: agent.issueId,
    title: issueTitle,
    description: issueBody,
    labels: refreshed?.labels || [],
    state: refreshed?.state || "opened",
    web_url: refreshed?.web_url,
  };
  launchAgent(live, repo, agent.mode, issue);

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
      // removeWorktree skips `git branch -D` when branch is empty, so MR-review
      // agents on detached HEAD (gh) are safe with deleteBranch=true.
      removeWorktree(repo.path, agent.worktreePath, agent.branch, { deleteBranch });
    } catch {}
  }
  s.removeAgent(id);
};

export const hasCapacity = (): boolean => {
  const s = store.getState();
  return s.runningCount() < s.config.maxConcurrent;
};
