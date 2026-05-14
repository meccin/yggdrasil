import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useStdout } from "ink";
import type { Agent, AgentStatus } from "../types";
import { useStore, useStoreShallow } from "./useStore";

// Each card is ~6 rows including border. Cap how many we show so the agents
// pane plus issues pane stays within the terminal alongside the log pane.
const CARD_HEIGHT = 7;
const ROWS_RESERVED_AROUND_GRID = 26;

const colorFor = (s: AgentStatus): string => {
  switch (s) {
    case "running":
      return "green";
    case "awaiting-review":
      return "yellow";
    case "queued":
      return "gray";
    case "done":
    case "done-dry":
      return "blue";
    case "failed":
    case "killed":
      return "red";
  }
};

const fmtTok = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const Card: React.FC<{ a: Agent; selected: boolean }> = ({ a, selected }) => (
  <Box
    flexDirection="column"
    borderStyle={selected ? "double" : "single"}
    borderColor={selected ? "cyan" : colorFor(a.status)}
    paddingX={1}
  >
    <Box justifyContent="space-between">
      <Text bold wrap="truncate-end">#{a.issueId} {truncate(a.issueTitle, 28)}</Text>
      <Text color={colorFor(a.status)}>
        {a.status}
        {a.totalSteps && a.currentStep != null
          ? ` [${a.currentStep + 1}/${a.totalSteps}]`
          : ""}
      </Text>
    </Box>
    <Box>
      <Text dimColor>{a.repoName}</Text>
      <Text dimColor> · mode:</Text>
      <Text>{a.mode}</Text>
      <Text dimColor> · </Text>
      <Text color="yellow">{fmtTok(a.inputTokens)}↑</Text>
      <Text> </Text>
      <Text color="green">{fmtTok(a.outputTokens)}↓</Text>
    </Box>
    {a.currentTool && (
      <Text dimColor wrap="truncate-end">tool: <Text color="cyan">{a.currentTool}</Text></Text>
    )}
    {a.lastText && <Text dimColor wrap="truncate-end">{truncate(a.lastText, 50)}</Text>}
    {a.errorMessage && <Text color="red" wrap="truncate-end">err: {truncate(a.errorMessage, 50)}</Text>}
    {a.mrUrl && <Text color="blue" wrap="truncate-end">{a.mrUrl}</Text>}
  </Box>
);

export const AgentGrid: React.FC = () => {
  const agentMap = useStoreShallow((s) => s.agents);
  const focused = useStore((s) => s.focus.pane === "agents");
  const agentIdx = useStore((s) => s.focus.agentIdx);
  const { stdout } = useStdout();
  const [rows, setRows] = useState<number>(stdout?.rows ?? 40);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setRows(stdout.rows || 40);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const sorted = useMemo(
    () => Object.values(agentMap).sort((a, b) => a.startedAt - b.startedAt),
    [agentMap],
  );

  // Window of cards centered on the focused agent, sized to fit the terminal.
  // Show at least 2 cards even on tiny windows so the user has context.
  const maxVisible = Math.max(2, Math.floor((rows - ROWS_RESERVED_AROUND_GRID) / CARD_HEIGHT));
  const start = Math.max(0, Math.min(sorted.length - maxVisible, Math.max(0, agentIdx - Math.floor(maxVisible / 2))));
  const visible = sorted.slice(start, start + maxVisible);
  const hiddenBefore = start;
  const hiddenAfter = Math.max(0, sorted.length - (start + visible.length));

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? "cyan" : "gray"}
      paddingX={1}
      flexGrow={1}
    >
      <Text bold>AGENTS</Text>
      {sorted.length === 0 && (
        <Text dimColor>no agents · press Enter on an issue</Text>
      )}
      {hiddenBefore > 0 && <Text dimColor>… +{hiddenBefore} above</Text>}
      {visible.map((a, idx) => (
        <Card key={a.id} a={a} selected={focused && start + idx === agentIdx} />
      ))}
      {hiddenAfter > 0 && <Text dimColor>… +{hiddenAfter} below</Text>}
    </Box>
  );
};
