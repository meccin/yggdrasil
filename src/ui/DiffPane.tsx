import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useStdout } from "ink";
import { useStore, useStoreShallow } from "./useStore";
import { fetchAgentDiff, type DiffLine } from "./diff";

const RESERVED_ROWS = 7; // header (3) + footer (1) + border (2) + status (1)
const MIN_LINES = 5;

const colorFor = (kind: DiffLine["kind"]): string | undefined => {
  switch (kind) {
    case "file-header":
      return "yellow";
    case "hunk":
      return "cyan";
    case "added":
      return "green";
    case "removed":
      return "red";
    case "meta":
      return "gray";
    case "label":
      return "magenta";
    default:
      return undefined;
  }
};

interface DiffPaneProps {
  // null = tail-follow (== top of latest diff snapshot). Number pins to that
  // index in the line array. App owns this state so keys in App can mutate
  // it without DiffPane having to own the global input handler.
  topIdx: number | null;
  // Bump this to force a re-fetch (refresh on `r` key while diff is open).
  refreshKey: number;
}

export const DiffPane: React.FC<DiffPaneProps> = ({ topIdx, refreshKey }) => {
  const agentIdx = useStore((s) => s.focus.agentIdx);
  const agentMap = useStoreShallow((s) => s.agents);
  const { stdout } = useStdout();

  const [rows, setRows] = useState<number>(stdout?.rows ?? 40);
  const [cols, setCols] = useState<number>(stdout?.columns ?? 100);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setRows(stdout.rows || 40);
      setCols(stdout.columns || 100);
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const agent = useMemo(() => {
    const arr = Object.values(agentMap).sort((a, b) => a.startedAt - b.startedAt);
    return arr[agentIdx];
  }, [agentMap, agentIdx]);

  const [lines, setLines] = useState<DiffLine[]>([]);
  const [summary, setSummary] = useState<{ commits: number; filesChanged: number; base: string }>({
    commits: 0,
    filesChanged: 0,
    base: "",
  });

  useEffect(() => {
    if (!agent?.worktreePath) {
      setLines([]);
      setSummary({ commits: 0, filesChanged: 0, base: "" });
      return;
    }
    try {
      const r = fetchAgentDiff(agent.worktreePath);
      setLines(r.lines);
      setSummary({ commits: r.summary.commits, filesChanged: r.summary.filesChanged, base: r.base });
    } catch (err) {
      setLines([{ kind: "meta", text: `diff failed: ${(err as Error).message}` }]);
    }
  }, [agent?.id, agent?.worktreePath, refreshKey]);

  const visibleLines = Math.max(MIN_LINES, rows - RESERVED_ROWS);
  const maxTop = Math.max(0, lines.length - visibleLines);
  const effectiveTop = topIdx === null ? 0 : Math.max(0, Math.min(maxTop, topIdx));
  const slice = lines.slice(effectiveTop, effectiveTop + visibleLines);
  const maxLineWidth = Math.max(20, cols - 4);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="cyan"
      paddingX={1}
      flexGrow={1}
    >
      <Box>
        <Text bold>DIFF </Text>
        {agent ? (
          <>
            <Text dimColor>(#{agent.issueId} · {agent.repoName})</Text>
            <Text dimColor> · </Text>
            <Text color="green">{summary.commits} commits</Text>
            <Text dimColor> · </Text>
            <Text color="yellow">{summary.filesChanged} files</Text>
            {summary.base && (
              <>
                <Text dimColor> · base: </Text>
                <Text color="cyan">origin/{summary.base}</Text>
              </>
            )}
            <Text dimColor> · </Text>
            <Text color="yellow">
              {Math.min(effectiveTop + 1, lines.length)}-
              {Math.min(effectiveTop + visibleLines, lines.length)}/{lines.length}
            </Text>
          </>
        ) : (
          <Text dimColor>no agent focused</Text>
        )}
      </Box>
      {slice.map((line, i) => (
        <Text key={i} color={colorFor(line.kind)} bold={line.kind === "file-header"}>
          {line.text.length > maxLineWidth ? line.text.slice(0, maxLineWidth - 1) + "…" : line.text}
        </Text>
      ))}
    </Box>
  );
};
