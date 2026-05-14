import type { Agent, AgentEvent, FinalizeMode, RepoConfig, Provider } from "../types";
import { store } from "../store";
import { hasAnyCommits, hasUncommittedChanges, pushBranch } from "../git";
import { getSource } from "../sources";

const now = () => Date.now();
const log = (id: string, text: string) =>
  store.getState().appendEvent(id, { ts: now(), kind: "system", text });

export const finalize = async (
  agent: Agent,
  repo: RepoConfig,
  mode: FinalizeMode,
): Promise<void> => {
  const upd = store.getState();

  if (mode === "dry") {
    log(agent.id, "finalize: dry — no external action");
    upd.setStatus(agent.id, "done-dry");
    return;
  }

  if (mode === "review") {
    log(agent.id, "finalize: review — worktree preserved for inspection");
    upd.setStatus(agent.id, "awaiting-review");
    return;
  }

  // mode === "mr"
  if (hasUncommittedChanges(agent.worktreePath)) {
    log(agent.id, "finalize: uncommitted changes — abort");
    upd.updateAgent(agent.id, { errorMessage: "uncommitted changes" });
    upd.setStatus(agent.id, "failed");
    return;
  }

  if (!hasAnyCommits(agent.worktreePath, agent.branch)) {
    log(agent.id, "finalize: no new commits on branch — abort");
    upd.updateAgent(agent.id, { errorMessage: "no commits on branch" });
    upd.setStatus(agent.id, "failed");
    return;
  }

  log(agent.id, `finalize: push origin ${agent.branch}`);
  const push = pushBranch(agent.worktreePath, agent.branch);
  if (!push.ok) {
    log(agent.id, `push failed: ${push.stderr.slice(0, 200)}`);
    upd.updateAgent(agent.id, { errorMessage: `push failed: ${push.stderr.slice(0, 200)}` });
    upd.setStatus(agent.id, "failed");
    return;
  }

  const source = getSource(repo.provider);
  let prUrl: string | undefined;

  const tryCreate = (): string | undefined => {
    const created = source.createPr(
      repo.remoteRepo,
      agent.worktreePath,
      agent.branch,
      defaultTitle(agent),
    );
    if (created.url) return created.url;
    const err = (created.stderr || created.stdout || "").trim().slice(0, 300);
    if (err) log(agent.id, `create PR/MR failed: ${err}`);
    const existing = source.findPrBySourceBranch(repo.remoteRepo, agent.branch);
    if (existing) {
      log(agent.id, `recovered via list: ${existing.url}`);
      return existing.url;
    }
    return undefined;
  };

  if (push.branchExisted) {
    log(agent.id, "branch already existed upstream — looking for open PR/MR");
    const existing = source.findPrBySourceBranch(repo.remoteRepo, agent.branch);
    if (existing) {
      prUrl = existing.url;
      log(agent.id, `found existing: ${prUrl}`);
    } else {
      log(agent.id, "no open PR/MR — creating new");
      prUrl = tryCreate();
    }
  } else {
    log(agent.id, "creating PR/MR");
    prUrl = tryCreate();
  }

  if (prUrl) {
    upd.updateAgent(agent.id, { mrUrl: prUrl });
    log(agent.id, `commenting issue #${agent.issueId}`);
    source.comment(repo.remoteRepo, agent.issueId, buildComment(prUrl, agent, repo.provider));
    upd.setStatus(agent.id, "done");
  } else {
    log(agent.id, "PR/MR URL unavailable — marking failed");
    upd.updateAgent(agent.id, { errorMessage: "PR/MR url not detected" });
    upd.setStatus(agent.id, "failed");
  }
};

const defaultTitle = (a: Agent) => `[agent] ${a.issueTitle} (#${a.issueId})`;

export const extractSummary = (agent: Agent): string => {
  const texts = agent.log
    .filter((e: AgentEvent): e is AgentEvent & { text: string } =>
      e.kind === "text" && typeof e.text === "string" && e.text.trim().length > 0,
    )
    .map((e) => e.text.trim());
  if (texts.length === 0) return "";
  // The final assistant message is typically the summary the prompt asks for.
  // Fall back to the last block when only one exists.
  return texts[texts.length - 1];
};

const buildComment = (prUrl: string, agent: Agent, provider: Provider): string => {
  const label = provider === "gitlab" ? "MR" : "PR";
  const summary = extractSummary(agent);
  if (!summary) return `${label}: ${prUrl}`;
  return `${summary}\n\n---\n${label}: ${prUrl}`;
};
