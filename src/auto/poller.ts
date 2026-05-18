import { store } from "../store";
import { resolveMode } from "../config";
import { getSource } from "../sources";
import { hasCapacity, spawnAgentForIssue } from "../agent/orchestrator";

let timer: ReturnType<typeof setInterval> | undefined;
let ticking = false;

const tick = async (): Promise<void> => {
  const state = store.getState();
  const reposOn = state.config.repos.filter((r) => r.autoSpawn);
  if (reposOn.length === 0) return;

  for (const repo of reposOn) {
    if (!hasCapacity()) break;
    const source = getSource(repo.provider);
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
          a.issueId === issue.iid &&
          ["queued", "running", "awaiting-review"].includes(a.status),
      );
      if (dup) continue;
      const mode = resolveMode(state.config, repo);
      await spawnAgentForIssue(repo, issue, mode);
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
