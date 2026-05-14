import { createWriteStream, type WriteStream } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import type { Agent, AgentEvent, PermissionMode } from "../types";
import { store } from "../store";
import { logFile } from "../paths";
import { recordMetric } from "../metrics";

interface SpawnOpts {
  agent: Agent;
  prompt: string;
  permissionMode: PermissionMode;
  claudeConfigDir?: string | null;
  // Tool gating forwarded to `claude --allowed-tools` / `--disallowed-tools`.
  // Empty arrays skip the flag entirely (let Claude apply its own defaults).
  allowedTools?: string[];
  disallowedTools?: string[];
  // Path to a Claude Code settings JSON forwarded via `--settings`.
  settingsPath?: string | null;
  // Cumulative tokens already accrued before this spawn. When set, `usage`
  // events emitted to the store add the baseline so per-process counters
  // don't rewind between profile steps (each `claude -p` is a fresh session
  // whose `usage` starts at 0).
  tokenBaseline?: { input: number; output: number };
  onExit: (code: number) => void;
}

const processes = new Map<string, ChildProcess>();

const now = () => Date.now();

const append = (id: string, ev: AgentEvent) => store.getState().appendEvent(id, ev);

const truncBrief = (s: string, n = 80): string =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;

const relToWorktree = (filePath: string, wt: string): string => {
  if (!filePath) return "";
  if (wt && filePath.startsWith(wt + "/")) return filePath.slice(wt.length + 1);
  if (wt && filePath === wt) return ".";
  return filePath.replace(/^.+\/([^/]+\/[^/]+)$/, "…/$1");
};

// Produce a short, human-readable summary of a tool call's input. Falls back to
// JSON when the tool isn't specifically handled. Raw input is still preserved
// in the on-disk NDJSON log; this only affects the in-TUI display string.
export const formatToolBrief = (name: string, input: any, wt: string): string | undefined => {
  if (!input || typeof input !== "object") return undefined;
  switch (name) {
    case "Read":
    case "Write":
    case "NotebookEdit": {
      const p = String(input.file_path || input.notebook_path || "");
      return p ? relToWorktree(p, wt) : undefined;
    }
    case "Edit": {
      const p = relToWorktree(String(input.file_path || ""), wt);
      const head = String(input.old_string || "").split("\n")[0] || "";
      return head ? `${p} · ${truncBrief(head, 50)}` : p || undefined;
    }
    case "Glob":
      return input.pattern ? String(input.pattern) : undefined;
    case "Grep": {
      const pat = String(input.pattern || "");
      const path = input.path ? ` in ${relToWorktree(String(input.path), wt)}` : "";
      return pat ? truncBrief(pat + path) : undefined;
    }
    case "Bash": {
      const desc = String(input.description || "").trim();
      const cmd = String(input.command || "").trim();
      return truncBrief(desc || cmd);
    }
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      const inprog = todos.find((t: any) => t.status === "in_progress");
      return inprog ? `→ ${truncBrief(String(inprog.content || ""))}` : `${todos.length} todos`;
    }
    case "WebFetch":
    case "WebSearch":
      return truncBrief(String(input.url || input.query || ""));
    case "Task": {
      const desc = String(input.description || input.subagent_type || "").trim();
      return desc ? truncBrief(desc) : undefined;
    }
    default: {
      const keys = Object.keys(input);
      if (keys.length === 0) return undefined;
      const first = keys[0];
      const val = input[first];
      const valStr = typeof val === "string" ? val : JSON.stringify(val);
      return truncBrief(`${first}=${valStr}`);
    }
  }
};

const parseStreamEvent = (
  raw: any,
  agent: Agent,
  baseline: { input: number; output: number },
): void => {
  if (!raw || typeof raw !== "object") return;
  const type = raw.type;
  const agentId = agent.id;

  if (type === "system") {
    append(agentId, { ts: now(), kind: "system", text: raw.subtype || "init" });
    return;
  }

  if (type === "assistant" && raw.message?.content) {
    const blocks = Array.isArray(raw.message.content) ? raw.message.content : [];
    for (const b of blocks) {
      if (b.type === "text" && typeof b.text === "string") {
        append(agentId, { ts: now(), kind: "text", text: b.text });
      } else if (b.type === "tool_use") {
        const name = String(b.name || "tool");
        const brief = formatToolBrief(name, b.input, agent.worktreePath);
        append(agentId, { ts: now(), kind: "tool", name, brief });
        recordMetric({
          ts: now(),
          kind: "tool_use",
          agentId,
          repo: agent.repoName,
          tool: name,
        });
      } else if (b.type === "thinking") {
        append(agentId, { ts: now(), kind: "thinking" });
      }
    }
    const usage = raw.message?.usage;
    if (usage) {
      append(agentId, {
        ts: now(),
        kind: "usage",
        inputTokens: baseline.input + (Number(usage.input_tokens) || 0),
        outputTokens: baseline.output + (Number(usage.output_tokens) || 0),
      });
    }
    return;
  }

  if (type === "result") {
    const usage = raw.usage;
    if (usage) {
      append(agentId, {
        ts: now(),
        kind: "usage",
        inputTokens: baseline.input + (Number(usage.input_tokens) || 0),
        outputTokens: baseline.output + (Number(usage.output_tokens) || 0),
      });
    }
    append(agentId, {
      ts: now(),
      kind: "done",
      ok: raw.subtype === "success" || raw.is_error === false,
      reason: raw.subtype || undefined,
    });
    return;
  }
};

export const spawnAgent = (opts: SpawnOpts): void => {
  const {
    agent,
    prompt,
    permissionMode,
    claudeConfigDir,
    allowedTools,
    disallowedTools,
    settingsPath,
    tokenBaseline,
    onExit,
  } = opts;
  const baseline = tokenBaseline ?? { input: 0, output: 0 };
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    permissionMode,
  ];
  if (allowedTools && allowedTools.length > 0) {
    args.push("--allowed-tools", allowedTools.join(" "));
  }
  if (disallowedTools && disallowedTools.length > 0) {
    args.push("--disallowed-tools", disallowedTools.join(" "));
  }
  if (settingsPath) {
    args.push("--settings", settingsPath);
  }

  const env: Record<string, string> = { ...process.env, CI: "1" } as Record<string, string>;
  if (claudeConfigDir) env.CLAUDE_CONFIG_DIR = claudeConfigDir;

  const child = spawn("claude", args, {
    cwd: agent.worktreePath,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  processes.set(agent.id, child);
  store.getState().updateAgent(agent.id, { pid: child.pid, status: "running" });

  const rawLog: WriteStream = createWriteStream(logFile(agent.id), { flags: "a" });

  let buf = "";
  const consume = (chunk: Buffer | string) => {
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    rawLog.write(s);
    buf += s;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        parseStreamEvent(ev, agent, baseline);
      } catch {
        append(agent.id, { ts: now(), kind: "text", text: line.slice(0, 200) });
      }
    }
  };

  child.stdout?.on("data", consume);
  child.stderr?.on("data", (d) => {
    const s = d.toString("utf8");
    rawLog.write(`[stderr] ${s}`);
    append(agent.id, { ts: now(), kind: "system", text: `stderr: ${s.slice(0, 200)}` });
  });

  child.on("exit", (code) => {
    processes.delete(agent.id);
    rawLog.end();
    onExit(code ?? 1);
  });

  child.on("error", (err) => {
    processes.delete(agent.id);
    append(agent.id, { ts: now(), kind: "system", text: `spawn error: ${err.message}` });
    rawLog.end();
    onExit(127);
  });
};

export const killAgent = (id: string): boolean => {
  const child = processes.get(id);
  if (!child) return false;
  try {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (processes.has(id)) child.kill("SIGKILL");
    }, 3000);
    return true;
  } catch {
    return false;
  }
};

export const killAllAgents = (): void => {
  for (const id of [...processes.keys()]) killAgent(id);
};

export const buildPrompt = (issueTitle: string, issueBody: string, iid: number): string => {
  const body = (issueBody || "").trim() || "(no description)";
  return [
    `You are an agent working on issue #${iid}: ${issueTitle}`,
    "",
    "Issue description:",
    body,
    "",
    "Guidelines:",
    "- Work only inside this worktree (your cwd).",
    "- Make small, descriptive commits as you progress.",
    "- Do NOT add 'Co-Authored-By' trailers or 'Generated with Claude Code' lines to commit messages or PR/MR descriptions.",
    "- Write or update tests if the project already has a test suite.",
    "- When done, ensure everything is committed. DO NOT push — the supervisor handles that.",
    "- End your run with a final message containing a concise summary of what was done. Write that summary in the same language as the issue description above.",
  ].join("\n");
};
