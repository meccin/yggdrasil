import React, { useEffect, useState } from "react";
import { Box, Text, useStdout } from "ink";
import { getSource } from "../sources";
import { getState, useStore, useStoreShallow } from "./useStore";

// Cap visible issues so the top row never pushes the log pane off-screen.
// Caller can see scroll-out via this counter at the bottom.
const ROWS_RESERVED_AROUND_LIST = 26;

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export const IssueList: React.FC = () => {
  const repo = useStore((s) => s.config.repos[s.focus.repoIdx]);
  const issues = useStoreShallow((s) =>
    repo ? s.issuesByRepo[repo.name] || [] : [],
  );
  const issueIdx = useStore((s) => s.focus.issueIdx);
  const focused = useStore((s) => s.focus.pane === "issues");
  const [loading, setLoading] = useState(false);
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
  const maxVisible = Math.max(3, Math.floor((rows - ROWS_RESERVED_AROUND_LIST) / 2));

  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    const refresh = () => {
      setLoading(true);
      const source = getSource(repo.provider);
      const got = source.list(repo.remoteRepo, { state: "opened" });
      if (cancelled) return;
      getState().setIssues(repo.name, got);
      setLoading(false);
    };
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [repo?.name]);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? "cyan" : "gray"}
      paddingX={1}
      width={36}
    >
      <Text bold>ISSUES {loading && <Text dimColor>(loading…)</Text>}</Text>
      {!repo && <Text dimColor>no repo selected</Text>}
      {repo && issues.length === 0 && !loading && <Text dimColor>no open issues</Text>}
      {issues.slice(0, maxVisible).map((i, idx) => {
        const sel = focused && idx === issueIdx;
        return (
          <Text key={i.iid} color={sel ? "cyan" : "white"} bold={sel}>
            {sel ? "▸ " : "  "}#{i.iid} {truncate(i.title, 28)}
          </Text>
        );
      })}
      {issues.length > maxVisible && (
        <Text dimColor>… +{issues.length - maxVisible} more</Text>
      )}
    </Box>
  );
};
