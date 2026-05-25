import { store } from "../store";
import { resolveMode } from "../config";
import { getSource } from "../sources";
import {
  hasCapacity,
  spawnAgentForIssue,
  spawnAgentForMr,
} from "../agent/orchestrator";

let timer: ReturnType<typeof setInterval> | undefined;
let ticking = false;

const tick = async (): Promise<void> => {
  const state = store.getState();
  // A repo participates in the tick if it has issue auto-spawn on, MR
  // auto-spawn configured, or both. The two flows are independent.
  const reposOn = state.config.repos.filter(
    (r) => r.autoSpawn || r.autoSpawnMrLabel,
  );
  if (reposOn.length === 0) return;

  for (const repo of reposOn) {
    if (!hasCapacity()) break;
    const source = getSource(repo.provider);

    if (repo.autoSpawn) {
      const issues = source.list(repo.remoteRepo, {
        label: repo.autoSpawnLabel,
        state: "opened",
        limit: state.config.maxIssuesPerRepo,
      });
      for (const issue of issues) {
        if (!hasCapacity()) break;
        const dup = Object.values(state.agents).find(
          (a) =>
            a.repoName === repo.name &&
            a.kind === "issue" &&
            a.issueId === issue.iid &&
            ["queued", "running", "awaiting-review"].includes(a.status),
        );
        if (dup) continue;
        const mode = resolveMode(state.config, repo);
        await spawnAgentForIssue(repo, issue, mode);
      }
    }

    if (repo.autoSpawnMrLabel) {
      const mrs = source.listMrs(repo.remoteRepo, {
        label: repo.autoSpawnMrLabel,
        state: "opened",
        limit: state.config.maxIssuesPerRepo,
      });
      for (const mr of mrs) {
        if (!hasCapacity()) break;
        // Skip MRs the agent has already commented on (any non-terminal or
        // recently-done mr-kind agent for the same iid).
        const dup = Object.values(state.agents).find(
          (a) =>
            a.repoName === repo.name &&
            a.kind === "mr" &&
            a.issueId === mr.iid &&
            ["queued", "running", "done"].includes(a.status),
        );
        if (dup) continue;
        await spawnAgentForMr(repo, mr, { inline: repo.mrReviewInlineDefault });
      }
    }
  }
};

export const startPoller = (): void => {
  if (timer) return;
  const cfg = store.getState().config;
  const intervalMs = cfg.pollIntervalSec * 1000;
  const schedule = () => store.getState().setNextPoll(Date.now() + intervalMs);
  schedule();

  timer = setInterval(async () => {
    await tick();
    schedule();
  }, intervalMs);

  setTimeout(async () => {
    await tick();
    schedule();
  }, 5000);
};

export const stopPoller = (): void => {
  if (timer) clearInterval(timer);
  timer = undefined;
};

// Trigger a poll cycle immediately; resets the countdown so the next scheduled
// tick is one full interval away. Safe to call when poller hasn't started.
export const forceTick = async (): Promise<{ ok: boolean; ranAny: boolean }> => {
  if (ticking) return { ok: false, ranAny: false };
  ticking = true;
  try {
    const before = store.getState().runningCount();
    await tick();
    const after = store.getState().runningCount();
    const cfg = store.getState().config;
    store.getState().setNextPoll(Date.now() + cfg.pollIntervalSec * 1000);
    return { ok: true, ranAny: after > before };
  } finally {
    ticking = false;
  }
};
