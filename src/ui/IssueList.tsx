import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useStdout } from "ink";
import { getSource } from "../sources";
import { getState, useStore, useStoreShallow } from "./useStore";
import type { Issue, MergeRequest } from "../sources/types";

const ROWS_RESERVED_AROUND_LIST = 28;

export type ListTab = "issues" | "mrs";

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Generic filter for both Issues and MRs. `#49` and `!49` are accepted as
// id-prefix queries regardless of the actual item kind; plain digits match by
// substring; anything else matches by title.
export const matchesItemFilter = (
  item: { iid: number; title: string },
  filter: string,
): boolean => {
  if (!filter) return true;
  const q = filter.toLowerCase();
  const iidStr = String(item.iid);
  if (q.startsWith("#") || q.startsWith("!")) {
    return iidStr.startsWith(q.slice(1));
  }
  if (/^\d+$/.test(q) && iidStr.includes(q)) return true;
  return item.title.toLowerCase().includes(q);
};

// Back-compat re-export.
export const matchesIssueFilter = (issue: Issue, filter: string): boolean =>
  matchesItemFilter(issue, filter);

interface Props {
  tab: ListTab;
  filter: string;
  filterMode: boolean;
}

export const IssueList: React.FC<Props> = ({ tab, filter, filterMode }) => {
  const repo = useStore((s) => s.config.repos[s.focus.repoIdx]);
  const issues = useStoreShallow((s) =>
    repo ? s.issuesByRepo[repo.name] || [] : [],
  );
  const mrs = useStoreShallow((s) => (repo ? s.mrsByRepo[repo.name] || [] : []));
  const issueIdx = useStore((s) => s.focus.issueIdx);
  const focused = useStore((s) => s.focus.pane === "issues");
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [loadingMrs, setLoadingMrs] = useState(false);
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
      setLoadingIssues(true);
      const source = getSource(repo.provider);
      const limit = getState().config.maxIssuesPerRepo;
      const got = source.list(repo.remoteRepo, { state: "opened", limit });
      if (cancelled) return;
      getState().setIssues(repo.name, got);
      setLoadingIssues(false);
    };
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [repo?.name]);

  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    const refresh = () => {
      setLoadingMrs(true);
      const source = getSource(repo.provider);
      const limit = getState().config.maxIssuesPerRepo;
      const got = source.listMrs(repo.remoteRepo, { state: "opened", limit });
      if (cancelled) return;
      getState().setMrs(repo.name, got);
      setLoadingMrs(false);
    };
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [repo?.name]);

  const isMrs = tab === "mrs";
  const items: Array<Issue | MergeRequest> = isMrs ? mrs : issues;

  const visibleItems = useMemo(
    () => items.filter((it) => matchesItemFilter(it, filter)),
    [items, filter],
  );

  const clampedIdx = Math.min(issueIdx, Math.max(0, visibleItems.length - 1));
  const topIdx = Math.max(0, Math.min(
    clampedIdx - Math.floor(maxVisible / 2),
    Math.max(0, visibleItems.length - maxVisible),
  ));
  const windowed = visibleItems.slice(topIdx, topIdx + maxVisible);
  const hiddenAbove = topIdx;
  const hiddenBelow = Math.max(0, visibleItems.length - (topIdx + maxVisible));

  const loading = isMrs ? loadingMrs : loadingIssues;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? "cyan" : "gray"}
      paddingX={1}
      width={36}
    >
      <Box>
        <Text bold color={!isMrs ? "cyan" : undefined}>
          Issues({issues.length})
        </Text>
        <Text dimColor> | </Text>
        <Text bold color={isMrs ? "cyan" : undefined}>
          MRs({mrs.length})
        </Text>
      </Box>
      {(filterMode || filter) && (
        <Text color={filterMode ? "cyan" : undefined} dimColor={!filterMode}>
          {filterMode ? `/ ${filter}█` : `filter: ${filter}`}
        </Text>
      )}
      {Array.from({ length: maxVisible }).map((_, idx) => {
        const item = windowed[idx];
        if (!item) return <Text key={`empty-${idx}`}> </Text>;
        const absIdx = topIdx + idx;
        const sel = focused && absIdx === clampedIdx;
        const glyph = isMrs ? "!" : "#";
        const draftTag = isMrs && (item as MergeRequest).draft ? "[DRAFT] " : "";
        return (
          <Text key={item.iid} color={sel ? "cyan" : "white"} bold={sel} wrap="truncate-end">
            {sel ? "▸ " : "  "}{glyph}{item.iid} {truncate(`${draftTag}${item.title}`, 28)}
          </Text>
        );
      })}
      <Text dimColor wrap="truncate-end">
        {!repo
          ? "no repo selected"
          : visibleItems.length === 0
            ? loading
              ? "loading…"
              : filter
                ? `no match for "${filter}"`
                : isMrs
                  ? "no open MRs"
                  : "no open issues"
            : `${clampedIdx + 1}/${visibleItems.length}${hiddenAbove ? ` ↑${hiddenAbove}` : ""}${hiddenBelow ? ` ↓${hiddenBelow}` : ""}${loading ? " · loading…" : ""}`}
      </Text>
    </Box>
  );
};
