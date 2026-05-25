import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useStdout } from "ink";
import { useStore, useStoreShallow } from "./useStore";
import type { AgentEvent } from "../types";

// Approximate fixed rows around the log pane (header + repo bar + issues/agents
// row + footer + flash buffer). LogPane consumes terminal rows minus this so
// the whole TUI never exceeds the alt-screen height — overflow is what causes
// Ink's anchor to desync and leave ghost frames at the top.
const RESERVED_ROWS_MAIN = 23;
const RESERVED_ROWS_FULLSCREEN = 5;
const MIN_LINES = 5;

export type LogFilter = "all" | "no-thinking" | "tools" | "errors";

// Ordered for `f` to cycle deterministically.
export const LOG_FILTER_ORDER: LogFilter[] = ["all", "no-thinking", "tools", "errors"];

interface LogPaneProps {
  fullscreen?: boolean;
  // null means tail-follow; any number pins the window to start at that index
  // of the filtered log array.
  topIdx?: number | null;
  filter?: LogFilter;
}

const iconFor = (kind: string): string => {
  switch (kind) {
    case "tool":
    case "text":
      return "▸";
    case "thinking":
      return "·";
    case "usage":
      return "Σ";
    case "done":
      return "✓";
    case "system":
      return "i";
    default:
      return " ";
  }
};

const colorFor = (kind: string, ev?: AgentEvent): string | undefined => {
  if (ev && ev.kind === "done" && ev.ok === false) return "red";
  if (ev && ev.kind === "system" && ev.text && /error|fail|stderr/i.test(ev.text)) return "red";
  switch (kind) {
    case "tool":
      return "cyan";
    case "system":
      return "gray";
    case "done":
      return "green";
    case "usage":
      return "yellow";
    default:
      return undefined;
  }
};

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Visual-only wrapper: a thinking run of length > 1 is rendered as a single
// pseudo-event so the log doesn't drown in `· thinking…` lines.
interface DisplayEvent {
  ev: AgentEvent;
  thinkingCount?: number;
}

export const collapseThinking = (events: AgentEvent[]): DisplayEvent[] => {
  const out: DisplayEvent[] = [];
  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (ev.kind === "thinking") {
      let j = i + 1;
      while (j < events.length && events[j].kind === "thinking") j++;
      const count = j - i;
      out.push({ ev, thinkingCount: count });
      i = j;
    } else {
      out.push({ ev });
      i++;
    }
  }
  return out;
};

export const applyFilter = (events: AgentEvent[], filter: LogFilter): AgentEvent[] => {
  switch (filter) {
    case "all":
      return events.filter((e) => e.kind !== "usage");
    case "no-thinking":
      return events.filter((e) => e.kind !== "thinking" && e.kind !== "usage");
    case "tools":
      return events.filter((e) => e.kind === "tool" || e.kind === "done");
    case "errors":
      return events.filter((e) => {
        if (e.kind === "done" && e.ok === false) return true;
        if (e.kind === "system" && e.text && /error|fail|stderr|denied/i.test(e.text)) return true;
        return false;
      });
  }
};

// Inline log pane's slice math (display.slice(top, top + lines)) assumes one
// event = one row, so we truncate text/system there to keep that invariant.
// Fullscreen has room to wrap and is the view users actually read — return
// the full string and let Ink wrap it. PAUSED indicator still orients the user.
const fmtEvent = (de: DisplayEvent, fullscreen = false): string => {
  const ev = de.ev;
  if (ev.kind === "tool") return `${ev.name}${ev.brief ? " · " + truncate(ev.brief, 90) : ""}`;
  if (ev.kind === "usage") return `${ev.inputTokens || 0}↑ / ${ev.outputTokens || 0}↓`;
  if (ev.kind === "done") return `done${ev.reason ? " · " + ev.reason : ""}${ev.ok === false ? " · ERROR" : ""}`;
  if (ev.kind === "text") {
    const normalized = (ev.text || "").replace(/\s+/g, " ");
    return fullscreen ? normalized : truncate(normalized, 120);
  }
  if (ev.kind === "system") {
    const text = ev.text || "";
    return fullscreen ? text : truncate(text, 120);
  }
  if (ev.kind === "thinking") {
    return de.thinkingCount && de.thinkingCount > 1
      ? `thinking… ×${de.thinkingCount}`
      : "thinking…";
  }
  return "";
};

export const LogPane: React.FC<LogPaneProps> = ({ fullscreen, topIdx = null, filter = "all" }) => {
  const focused = useStore((s) => s.focus.pane === "log");
  const agentIdx = useStore((s) => s.focus.agentIdx);
  const agentMap = useStoreShallow((s) => s.agents);
  const { stdout } = useStdout();

  // Recompute lines on terminal resize so the alt-screen never overflows the
  // visible area. Initial read uses the current dimensions.
  const [rows, setRows] = useState<number>(stdout?.rows ?? 40);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setRows(stdout.rows || 40);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const agent = useMemo(() => {
    const arr = Object.values(agentMap).sort((a, b) => a.startedAt - b.startedAt);
    return arr[agentIdx];
  }, [agentMap, agentIdx]);

  const reserved = fullscreen ? RESERVED_ROWS_FULLSCREEN : RESERVED_ROWS_MAIN;
  const lines = Math.max(MIN_LINES, rows - reserved);
  const filtered = useMemo(
    () => (agent ? applyFilter(agent.log, filter) : []),
    [agent, filter],
  );
  const display = useMemo(() => collapseThinking(filtered), [filtered]);

  // Tail-follow when topIdx is null; otherwise clamp the user's pinned window
  // to a valid range. Returning to the tail collapses back into follow mode.
  const maxTop = Math.max(0, display.length - lines);
  const paused = topIdx !== null && topIdx < maxTop;
  const top = topIdx === null ? maxTop : Math.max(0, Math.min(maxTop, topIdx));
  const slice = display.slice(top, top + lines);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? "cyan" : "gray"}
      paddingX={1}
      flexGrow={1}
    >
      <Box>
        <Text bold>LOG </Text>
        {agent && <Text dimColor>(#{agent.issueId} · {agent.repoName}) </Text>}
        <Text dimColor>· filter:</Text>
        <Text color="cyan"> {filter}</Text>
        {paused && (
          <>
            <Text dimColor> · </Text>
            <Text color="yellow">PAUSED {top + 1}-{Math.min(top + lines, display.length)}/{display.length}</Text>
          </>
        )}
      </Box>
      {!agent && <Text dimColor>no agent focused</Text>}
      {slice.map((de, i) => (
        <Text key={i} color={colorFor(de.ev.kind, de.ev)} wrap={fullscreen ? "wrap" : "truncate-end"}>
          {iconFor(de.ev.kind)} {fmtEvent(de, fullscreen)}
        </Text>
      ))}
    </Box>
  );
};
