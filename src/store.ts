import { createStore } from "zustand/vanilla";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { stateFile, ensureUserDirs } from "./paths";
import type {
  Agent,
  AgentEvent,
  AgentStatus,
  GlobalConfig,
  Issue,
} from "./types";
import { loadConfig, saveConfig } from "./config";

interface Focus {
  pane: "repos" | "issues" | "agents" | "log";
  repoIdx: number;
  issueIdx: number;
  agentIdx: number;
}

interface State {
  config: GlobalConfig;
  agents: Record<string, Agent>;
  issuesByRepo: Record<string, Issue[]>;
  focus: Focus;
  totalInTokens: number;
  totalOutTokens: number;
  nextPollAt?: number;
  setConfig: (cfg: GlobalConfig) => void;
  setIssues: (repoName: string, issues: Issue[]) => void;
  addAgent: (a: Agent) => void;
  updateAgent: (id: string, patch: Partial<Agent>) => void;
  appendEvent: (id: string, ev: AgentEvent) => void;
  removeAgent: (id: string) => void;
  setStatus: (id: string, status: AgentStatus) => void;
  setFocus: (f: Partial<Focus>) => void;
  runningCount: () => number;
  toggleAutoSpawn: (repoName: string) => void;
  bumpConcurrency: (delta: number) => void;
  setNextPoll: (ts: number | undefined) => void;
}

const RING = 200;

const ringPush = (log: AgentEvent[], ev: AgentEvent): AgentEvent[] => {
  const next = log.length >= RING ? log.slice(log.length - RING + 1) : log.slice();
  next.push(ev);
  return next;
};

export const store = createStore<State>((set, get) => ({
  config: loadConfig(),
  agents: {},
  issuesByRepo: {},
  focus: { pane: "issues", repoIdx: 0, issueIdx: 0, agentIdx: 0 },
  totalInTokens: 0,
  totalOutTokens: 0,
  nextPollAt: undefined,
  setConfig: (cfg) => {
    saveConfig(cfg);
    set({ config: cfg });
  },
  setIssues: (repoName, issues) =>
    set((s) => ({ issuesByRepo: { ...s.issuesByRepo, [repoName]: issues } })),
  addAgent: (a) => set((s) => ({ agents: { ...s.agents, [a.id]: a } })),
  updateAgent: (id, patch) =>
    set((s) => {
      const cur = s.agents[id];
      if (!cur) return s;
      return { agents: { ...s.agents, [id]: { ...cur, ...patch } } };
    }),
  appendEvent: (id, ev) =>
    set((s) => {
      const cur = s.agents[id];
      if (!cur) return s;
      const next: Agent = { ...cur, log: ringPush(cur.log, ev) };
      let totalIn = s.totalInTokens;
      let totalOut = s.totalOutTokens;
      if (ev.kind === "usage") {
        const di = (ev.inputTokens || 0) - cur.inputTokens;
        const dout = (ev.outputTokens || 0) - cur.outputTokens;
        next.inputTokens = ev.inputTokens || cur.inputTokens;
        next.outputTokens = ev.outputTokens || cur.outputTokens;
        if (di > 0) totalIn += di;
        if (dout > 0) totalOut += dout;
      }
      if (ev.kind === "tool" && ev.name) next.currentTool = ev.name;
      if (ev.kind === "text" && ev.text) next.lastText = ev.text.slice(0, 200);
      return { agents: { ...s.agents, [id]: next }, totalInTokens: totalIn, totalOutTokens: totalOut };
    }),
  removeAgent: (id) =>
    set((s) => {
      const next = { ...s.agents };
      delete next[id];
      const remainingCount = Object.keys(next).length;
      const maxIdx = Math.max(0, remainingCount - 1);
      const agentIdx = Math.min(s.focus.agentIdx, maxIdx);
      const pane = remainingCount === 0 && s.focus.pane === "agents" ? "issues" : s.focus.pane;
      return { agents: next, focus: { ...s.focus, agentIdx, pane } };
    }),
  setStatus: (id, status) =>
    set((s) => {
      const cur = s.agents[id];
      if (!cur) return s;
      const ended = ["done", "done-dry", "failed", "killed", "awaiting-review"].includes(status);
      return {
        agents: {
          ...s.agents,
          [id]: { ...cur, status, endedAt: ended ? Date.now() : cur.endedAt },
        },
      };
    }),
  setFocus: (f) => set((s) => ({ focus: { ...s.focus, ...f } })),
  runningCount: () =>
    Object.values(get().agents).filter((a) => a.status === "running").length,
  toggleAutoSpawn: (repoName) => {
    const s = get();
    const repos = s.config.repos.map((r) =>
      r.name === repoName ? { ...r, autoSpawn: !r.autoSpawn } : r,
    );
    const cfg = { ...s.config, repos };
    saveConfig(cfg);
    set({ config: cfg });
  },
  bumpConcurrency: (delta) => {
    const s = get();
    const next = Math.max(1, Math.min(10, s.config.maxConcurrent + delta));
    const cfg = { ...s.config, maxConcurrent: next };
    saveConfig(cfg);
    set({ config: cfg });
  },
  setNextPoll: (ts) => set({ nextPollAt: ts }),
}));

export const persistState = (): void => {
  ensureUserDirs();
  const s = store.getState();
  const dump = {
    agents: Object.values(s.agents).filter((a) =>
      ["queued", "awaiting-review", "done", "done-dry", "failed", "killed"].includes(a.status),
    ),
    totalInTokens: s.totalInTokens,
    totalOutTokens: s.totalOutTokens,
  };
  try {
    writeFileSync(stateFile(), JSON.stringify(dump, null, 2));
  } catch {}
};

// Recover an Agent's status when the process is gone (the runner held the only
// reference to the live PID). Anything previously `running` is rewritten to
// `failed` so the user can see what happened, and any reviewable agent whose
// worktree has been removed from disk loses its claim to that status.
const reconcileHydratedAgent = (a: Agent): Agent => {
  let next: Agent = { ...a, log: a.log || [] };
  if (next.status === "running" || next.status === "queued") {
    next = {
      ...next,
      status: "failed",
      errorMessage:
        next.errorMessage ||
        (a.status === "running"
          ? "process not running after restart"
          : "never started before restart"),
      endedAt: next.endedAt || Date.now(),
    };
  }
  if (next.status === "awaiting-review" && next.worktreePath && !existsSync(next.worktreePath)) {
    next = {
      ...next,
      status: "failed",
      errorMessage: "worktree missing after restart",
      endedAt: Date.now(),
    };
  }
  return next;
};

export const hydrateState = (): void => {
  if (!existsSync(stateFile())) return;
  try {
    const raw = readFileSync(stateFile(), "utf8");
    const parsed = JSON.parse(raw);
    const agents: Record<string, Agent> = {};
    for (const a of parsed.agents || []) {
      const reconciled = reconcileHydratedAgent(a);
      agents[reconciled.id] = reconciled;
    }
    store.setState({
      agents,
      totalInTokens: Number(parsed.totalInTokens) || 0,
      totalOutTokens: Number(parsed.totalOutTokens) || 0,
    });
  } catch (err) {
    console.error(`[yggdrasil] state corrupted, ignoring: ${err}`);
  }
};

let persistTimer: ReturnType<typeof setInterval> | undefined;
export const startPersistLoop = (intervalMs = 3000): void => {
  if (persistTimer) return;
  persistTimer = setInterval(persistState, intervalMs);
};
export const stopPersistLoop = (): void => {
  if (persistTimer) {
    clearInterval(persistTimer);
    persistTimer = undefined;
  }
};
