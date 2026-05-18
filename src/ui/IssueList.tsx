import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useStdout } from "ink";
import { getSource } from "../sources";
import { getState, useStore, useStoreShallow } from "./useStore";
import type { Issue } from "../sources/types";

// Cap visible issues so the top row never pushes the log pane off-screen.
// Budget covers: 2 borders + ISSUES title + filter slot + status footer = 5 rows
// around the issue rows, plus the LogPane/AgentGrid reservation below.
const ROWS_RESERVED_AROUND_LIST = 28;

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export const matchesIssueFilter = (issue: Issue, filter: string): boolean => {
  if (!filter) return true;
  const q = filter.toLowerCase();
  const iidStr = String(issue.iid);
  if (q.startsWith("#")) {
    return iidStr.startsWith(q.slice(1));
  }
  if (/^\d+$/.test(q) && iidStr.includes(q)) return true;
  return issue.title.toLowerCase().includes(q);
};

interface Props {
  filter: string;
  filterMode: boolean;
}

export const IssueList: React.FC<Props> = ({ filter, filterMode }) => {
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
      const limit = getState().config.maxIssuesPerRepo;
      const got = source.list(repo.remoteRepo, { state: "opened", limit });
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

  const visibleIssues = useMemo(
    () => issues.filter((i) => matchesIssueFilter(i, filter)),
    [issues, filter],
  );

  // Scroll window so selected row stays inside the maxVisible slice.
  const clampedIdx = Math.min(issueIdx, Math.max(0, visibleIssues.length - 1));
  const topIdx = Math.max(0, Math.min(
    clampedIdx - Math.floor(maxVisible / 2),
    Math.max(0, visibleIssues.length - maxVisible),
  ));
  const windowed = visibleIssues.slice(topIdx, topIdx + maxVisible);
  const hiddenAbove = topIdx;
  const hiddenBelow = Math.max(0, visibleIssues.length - (topIdx + maxVisible));

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? "cyan" : "gray"}
      paddingX={1}
      width={36}
    >
      <Text bold>ISSUES</Text>
      {(filterMode || filter) && (
        <Text color={filterMode ? "cyan" : undefined} dimColor={!filterMode}>
          {filterMode ? `/ ${filter}█` : `filter: ${filter}`}
        </Text>
      )}
      {Array.from({ length: maxVisible }).map((_, idx) => {
        const issue = windowed[idx];
        if (!issue) return <Text key={`empty-${idx}`}> </Text>;
        const absIdx = topIdx + idx;
        const sel = focused && absIdx === clampedIdx;
        return (
          <Text key={issue.iid} color={sel ? "cyan" : "white"} bold={sel} wrap="truncate-end">
            {sel ? "▸ " : "  "}#{issue.iid} {truncate(issue.title, 28)}
          </Text>
        );
      })}
      <Text dimColor wrap="truncate-end">
        {!repo
          ? "no repo selected"
          : visibleIssues.length === 0
            ? loading
              ? "loading…"
              : filter
                ? `no match for "${filter}"`
                : "no open issues"
            : `${clampedIdx + 1}/${visibleIssues.length}${hiddenAbove ? ` ↑${hiddenAbove}` : ""}${hiddenBelow ? ` ↓${hiddenBelow}` : ""}${loading ? " · loading…" : ""}`}
      </Text>
    </Box>
  );
};
