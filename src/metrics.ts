import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { metricsFile, ensureUserDirs } from "./paths";
import { rotateFileIfNeeded } from "./rotation";
import type { AgentStatus, FinalizeMode } from "./types";

export type MetricEvent =
  | {
      ts: number;
      kind: "agent_start";
      agentId: string;
      repo: string;
      issueId: number;
      mode: FinalizeMode;
    }
  | {
      ts: number;
      kind: "agent_end";
      agentId: string;
      repo: string;
      issueId: number;
      status: AgentStatus;
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      mrUrl?: string;
      error?: string;
    }
  | {
      ts: number;
      kind: "tool_use";
      agentId: string;
      repo: string;
      tool: string;
    };

export const recordMetric = (ev: MetricEvent): void => {
  try {
    ensureUserDirs();
    rotateFileIfNeeded(metricsFile());
    appendFileSync(metricsFile(), JSON.stringify(ev) + "\n");
  } catch (err) {
    console.error(`[yggdrasil] metric write failed: ${(err as Error).message}`);
  }
};

export interface MetricFilters {
  repo?: string;
  sinceMs?: number;
  untilMs?: number;
}

const METRICS_ROTATION_SHARDS = 5;

const readShard = (path: string, filters: MetricFilters, out: MetricEvent[]): void => {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as MetricEvent;
      if (filters.sinceMs && ev.ts < filters.sinceMs) continue;
      if (filters.untilMs && ev.ts > filters.untilMs) continue;
      if (filters.repo && "repo" in ev && ev.repo !== filters.repo) continue;
      out.push(ev);
    } catch {}
  }
};

export const readMetrics = (filters: MetricFilters = {}): MetricEvent[] => {
  const out: MetricEvent[] = [];
  // Walk older shards first so the result is roughly chronological.
  for (let i = METRICS_ROTATION_SHARDS; i >= 1; i--) {
    readShard(`${metricsFile()}.${i}`, filters, out);
  }
  readShard(metricsFile(), filters, out);
  return out;
};

export interface Aggregate {
  totalAgents: number;
  byStatus: Record<string, number>;
  totalInputTokens: number;
  totalOutputTokens: number;
  byDay: Record<string, { agents: number; tokensIn: number; tokensOut: number }>;
  byRepo: Record<string, { agents: number; tokensIn: number; tokensOut: number }>;
  topIssues: Array<{ repo: string; issueId: number; agents: number; tokens: number }>;
  avgDurationMs: number;
  toolHisto: Record<string, number>;
}

const dayKey = (ts: number): string => {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export const aggregate = (events: MetricEvent[]): Aggregate => {
  const agg: Aggregate = {
    totalAgents: 0,
    byStatus: {},
    totalInputTokens: 0,
    totalOutputTokens: 0,
    byDay: {},
    byRepo: {},
    topIssues: [],
    avgDurationMs: 0,
    toolHisto: {},
  };

  const issueAcc = new Map<string, { repo: string; issueId: number; agents: number; tokens: number }>();
  let durationSum = 0;
  let durationCount = 0;

  for (const ev of events) {
    if (ev.kind === "tool_use") {
      agg.toolHisto[ev.tool] = (agg.toolHisto[ev.tool] || 0) + 1;
      continue;
    }
    if (ev.kind === "agent_start") {
      agg.totalAgents += 1;
      const day = dayKey(ev.ts);
      agg.byDay[day] = agg.byDay[day] || { agents: 0, tokensIn: 0, tokensOut: 0 };
      agg.byDay[day].agents += 1;
      agg.byRepo[ev.repo] = agg.byRepo[ev.repo] || { agents: 0, tokensIn: 0, tokensOut: 0 };
      agg.byRepo[ev.repo].agents += 1;
      const key = `${ev.repo}#${ev.issueId}`;
      const cur = issueAcc.get(key) || { repo: ev.repo, issueId: ev.issueId, agents: 0, tokens: 0 };
      cur.agents += 1;
      issueAcc.set(key, cur);
      continue;
    }
    if (ev.kind === "agent_end") {
      agg.byStatus[ev.status] = (agg.byStatus[ev.status] || 0) + 1;
      agg.totalInputTokens += ev.inputTokens;
      agg.totalOutputTokens += ev.outputTokens;
      const day = dayKey(ev.ts);
      agg.byDay[day] = agg.byDay[day] || { agents: 0, tokensIn: 0, tokensOut: 0 };
      agg.byDay[day].tokensIn += ev.inputTokens;
      agg.byDay[day].tokensOut += ev.outputTokens;
      agg.byRepo[ev.repo] = agg.byRepo[ev.repo] || { agents: 0, tokensIn: 0, tokensOut: 0 };
      agg.byRepo[ev.repo].tokensIn += ev.inputTokens;
      agg.byRepo[ev.repo].tokensOut += ev.outputTokens;
      const key = `${ev.repo}#${ev.issueId}`;
      const cur = issueAcc.get(key) || { repo: ev.repo, issueId: ev.issueId, agents: 0, tokens: 0 };
      cur.tokens += ev.inputTokens + ev.outputTokens;
      issueAcc.set(key, cur);
      durationSum += ev.durationMs;
      durationCount += 1;
    }
  }

  agg.avgDurationMs = durationCount > 0 ? Math.round(durationSum / durationCount) : 0;
  agg.topIssues = [...issueAcc.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 10);

  return agg;
};

const fmtTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
};

const fmtDuration = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m === 0) return `${rem}s`;
  return `${m}m${String(rem).padStart(2, "0")}s`;
};

export const formatReport = (agg: Aggregate, filterDesc: string): string => {
  const lines: string[] = [];
  lines.push(`Yggdrasil metrics${filterDesc ? "  ·  " + filterDesc : ""}`);
  lines.push("");

  const statusParts = Object.entries(agg.byStatus)
    .map(([k, v]) => `${v} ${k}`)
    .join(" · ");
  lines.push(`Total agents:    ${agg.totalAgents}${statusParts ? "    (" + statusParts + ")" : ""}`);
  lines.push(`Tokens:          ${fmtTokens(agg.totalInputTokens)} in / ${fmtTokens(agg.totalOutputTokens)} out`);
  lines.push(`Avg duration:    ${fmtDuration(agg.avgDurationMs)}`);
  lines.push("");

  const days = Object.entries(agg.byDay).sort((a, b) => b[0].localeCompare(a[0]));
  if (days.length > 0) {
    lines.push("By day:");
    for (const [day, v] of days) {
      lines.push(`  ${day}   ${v.agents} agents · ${fmtTokens(v.tokensIn)}↑ ${fmtTokens(v.tokensOut)}↓`);
    }
    lines.push("");
  }

  const repos = Object.entries(agg.byRepo).sort((a, b) => b[1].agents - a[1].agents);
  if (repos.length > 0) {
    lines.push("By repo:");
    for (const [repo, v] of repos) {
      lines.push(`  ${repo}   ${v.agents} agents · ${fmtTokens(v.tokensIn)}↑ ${fmtTokens(v.tokensOut)}↓`);
    }
    lines.push("");
  }

  if (agg.topIssues.length > 0) {
    lines.push("Top issues:");
    for (const i of agg.topIssues) {
      lines.push(`  ${i.repo}#${i.issueId}   ${i.agents} runs · ${fmtTokens(i.tokens)} tok`);
    }
    lines.push("");
  }

  const tools = Object.entries(agg.toolHisto).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (tools.length > 0) {
    lines.push("Top tools:");
    for (const [tool, n] of tools) {
      lines.push(`  ${tool}   ${n}`);
    }
  }

  return lines.join("\n");
};
