import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { Header } from "./Header";
import { RepoBar } from "./RepoBar";
import { IssueList, matchesIssueFilter } from "./IssueList";
import { AgentGrid } from "./AgentGrid";
import { LogPane, type LogFilter, LOG_FILTER_ORDER } from "./LogPane";
import { DiffPane } from "./DiffPane";
import { SpawnModal } from "./SpawnModal";
import { HelpModal } from "./HelpModal";
import { getState, useStore, useStoreShallow } from "./useStore";
import type { FinalizeMode } from "../types";
import type { Issue } from "../sources/types";
import {
  spawnAgentForIssue,
  killAgentById,
  deleteAgentArtifacts,
  respawnFailedAgent,
} from "../agent/orchestrator";
import { forceTick } from "../auto/poller";
import { resolveMode } from "../config";

type Pane = "repos" | "issues" | "agents" | "log";
const PANE_ORDER: Pane[] = ["repos", "issues", "agents", "log"];

// Build the footer hint string from the focused agent's state so action keys
// (kill/delete/re-spawn/log/diff) only show when they actually do something.
// Reduces noise and keeps the line from wrapping on narrower terminals.
const footerHints = (
  agent: { status: string } | undefined,
  pane: Pane,
): string => {
  const parts: string[] = ["tab:focus", "enter:spawn"];
  if (agent) {
    if (agent.status === "running") parts.push("k:kill");
    else parts.push("d:delete");
    if (agent.status === "failed" || agent.status === "killed" || agent.status === "done-dry") {
      parts.push("R:re-spawn");
    }
    parts.push("l:log", "v:diff");
  }
  if (pane === "issues") parts.push("/:find");
  if (pane === "log") parts.push("f:filter");
  parts.push("a:auto", "p:poll", "+/-:conc", "?:help", "q:quit");
  return parts.join(" · ");
};

export const App: React.FC = () => {
  const { exit } = useApp();
  const focus = useStoreShallow((s) => s.focus);
  const repos = useStoreShallow((s) => s.config.repos);
  const agentMap = useStoreShallow((s) => s.agents);
  const issuesByRepo = useStoreShallow((s) => s.issuesByRepo);
  const cfg = useStore((s) => s.config);

  const [modal, setModal] = useState<null | { issue: Issue }>(null);
  const [fullLog, setFullLog] = useState(false);
  const [fullDiff, setFullDiff] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [quitConfirm, setQuitConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<null | { id: string; short: string }>(null);
  const [flash, setFlash] = useState<string | null>(null);
  // Scroll/filter state for the log pane. `logTopIdx === null` means follow
  // the tail; any number pins the window to a slice of the filtered log.
  const [logTopIdx, setLogTopIdx] = useState<number | null>(null);
  const [logFilter, setLogFilter] = useState<LogFilter>("all");
  // Diff view state: scroll position + bump-on-refresh counter so DiffPane
  // re-fetches git output without remounting.
  const [diffTopIdx, setDiffTopIdx] = useState<number | null>(null);
  const [diffRefreshKey, setDiffRefreshKey] = useState(0);
  // Issue filter: `/` enters typing mode, Enter keeps filter, Esc clears.
  const [issueFilter, setIssueFilter] = useState("");
  const [issueFilterMode, setIssueFilterMode] = useState(false);

  // Cap root layout to terminal height so content never overflows and pushes
  // the top (Header/RepoBar) out of view. Ink without an explicit height
  // renders all children; when total > rows the terminal scrolls.
  const { stdout } = useStdout();
  const [termRows, setTermRows] = useState<number>(stdout?.rows ?? 40);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setTermRows(stdout.rows || 40);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  // No manual screen clears on view transitions: useEffect fires AFTER Ink
  // commits a frame, so writing escape codes here would erase the freshly
  // painted view (help / fullscreen log) and nothing would repaint until
  // another state change. Alt-screen + the dynamic pane heights (v0.5.1)
  // keep content within the terminal, so Ink's own diffing handles redraws
  // correctly without our help.

  // Reset log scroll back to tail-follow whenever the focused agent changes
  // so the user is never staring at a frozen window for the wrong run.
  useEffect(() => {
    setLogTopIdx(null);
  }, [focus.agentIdx]);

  // Filter changes invalidate issueIdx — snap back to top of visible list.
  useEffect(() => {
    getState().setFocus({ issueIdx: 0 });
  }, [issueFilter]);

  const showFlash = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 2500);
  };

  const cycleFilter = () => {
    const idx = LOG_FILTER_ORDER.indexOf(logFilter);
    const next = LOG_FILTER_ORDER[(idx + 1) % LOG_FILTER_ORDER.length];
    setLogFilter(next);
    setLogTopIdx(null);
    showFlash(`filter: ${next}`);
  };

  const sortedAgents = useMemo(
    () => Object.values(agentMap).sort((a, b) => a.startedAt - b.startedAt),
    [agentMap],
  );

  const currentRepo = () => repos[focus.repoIdx];
  const currentIssues = (): Issue[] => {
    const r = currentRepo();
    if (!r) return [];
    const all = issuesByRepo[r.name] || [];
    return all.filter((i) => matchesIssueFilter(i, issueFilter));
  };
  const currentIssue = () => currentIssues()[focus.issueIdx];
  const currentAgent = () => sortedAgents[focus.agentIdx];

  const startSpawn = (mode: FinalizeMode) => {
    if (!modal) return;
    const repo = currentRepo();
    if (!repo) return;
    const issue = modal.issue;
    setModal(null);
    spawnAgentForIssue(repo, issue, mode).then((res) => {
      if (!res.ok) showFlash(`spawn failed: ${res.error}`);
      else showFlash(`agent launched · ${mode}`);
    });
  };

  useInput((input, key) => {
    // Panic close: Ctrl+C always exits (raw mode swallows SIGINT, so handle here).
    if (key.ctrl && (input === "c" || input === "C")) {
      exit();
      return;
    }

    if (quitConfirm) {
      if (input === "y" || input === "Y") exit();
      else if (input === "n" || key.escape) setQuitConfirm(false);
      return;
    }

    if (deleteConfirm) {
      if (input === "y" || input === "Y") {
        deleteAgentArtifacts(deleteConfirm.id, true);
        showFlash(`deleted ${deleteConfirm.short}`);
        setDeleteConfirm(null);
      } else if (input === "n" || key.escape) {
        setDeleteConfirm(null);
      }
      return;
    }

    if (helpOpen) {
      // Any common close key dismisses the help page.
      if (key.escape || input === "?" || input === "q" || key.return || input === " ") {
        setHelpOpen(false);
      }
      return;
    }

    if (modal) {
      if (key.escape) return setModal(null);
      if (input === "m") return startSpawn("mr");
      if (input === "r") return startSpawn("review");
      if (input === "d") return startSpawn("dry");
      if (key.return) {
        const r = currentRepo();
        if (r) return startSpawn(resolveMode(cfg, r));
      }
      return;
    }

    if (fullLog) {
      if (key.escape || input === "l" || input === "q") {
        setFullLog(false);
        return;
      }
      if (input === "f") {
        cycleFilter();
        return;
      }
      if (input === "g") {
        setLogTopIdx(0);
        return;
      }
      if (input === "G") {
        setLogTopIdx(null);
        return;
      }
      if (key.upArrow) {
        setLogTopIdx((cur) => (cur ?? Infinity) - 1);
        return;
      }
      if (key.downArrow) {
        setLogTopIdx((cur) => (cur ?? Infinity) + 1);
        return;
      }
      if (key.pageUp) {
        setLogTopIdx((cur) => (cur ?? Infinity) - 10);
        return;
      }
      if (key.pageDown) {
        setLogTopIdx((cur) => (cur ?? Infinity) + 10);
        return;
      }
      return;
    }

    if (fullDiff) {
      if (key.escape || input === "v" || input === "q") {
        setFullDiff(false);
        return;
      }
      if (input === "r") {
        setDiffRefreshKey((n) => n + 1);
        setDiffTopIdx(null);
        return;
      }
      if (key.upArrow) {
        setDiffTopIdx((cur) => Math.max(0, (cur ?? 0) - 1));
        return;
      }
      if (key.downArrow) {
        setDiffTopIdx((cur) => (cur ?? 0) + 1);
        return;
      }
      if (key.pageUp) {
        setDiffTopIdx((cur) => Math.max(0, (cur ?? 0) - 10));
        return;
      }
      if (key.pageDown) {
        setDiffTopIdx((cur) => (cur ?? 0) + 10);
        return;
      }
      if (input === "g") {
        setDiffTopIdx(0);
        return;
      }
      if (input === "G") {
        // Park at a very large index; DiffPane clamps to maxTop.
        setDiffTopIdx(Number.MAX_SAFE_INTEGER);
        return;
      }
      return;
    }

    if (issueFilterMode) {
      if (key.escape) {
        setIssueFilter("");
        setIssueFilterMode(false);
        return;
      }
      if (key.return) {
        setIssueFilterMode(false);
        return;
      }
      if (key.backspace || key.delete) {
        setIssueFilter((s) => s.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setIssueFilter((s) => s + input);
        return;
      }
      return;
    }

    if (key.tab) {
      const idx = PANE_ORDER.indexOf(focus.pane);
      const next = PANE_ORDER[(idx + 1) % PANE_ORDER.length];
      getState().setFocus({ pane: next });
      return;
    }

    if (key.upArrow || key.downArrow) {
      const delta = key.upArrow ? -1 : 1;
      if (focus.pane === "repos") {
        if (repos.length === 0) return;
        const next = (focus.repoIdx + delta + repos.length) % repos.length;
        getState().setFocus({ repoIdx: next, issueIdx: 0 });
      } else if (focus.pane === "issues") {
        const arr = currentIssues();
        if (arr.length === 0) return;
        const next = (focus.issueIdx + delta + arr.length) % arr.length;
        getState().setFocus({ issueIdx: next });
      } else if (focus.pane === "agents") {
        if (sortedAgents.length === 0) return;
        const next = (focus.agentIdx + delta + sortedAgents.length) % sortedAgents.length;
        getState().setFocus({ agentIdx: next });
        setLogTopIdx(null);
      } else if (focus.pane === "log") {
        // Step the log window one event at a time. Crossing into the tail
        // (top + window ≥ length) restores tail-follow mode.
        setLogTopIdx((cur) => (cur ?? Infinity) + delta);
      }
      return;
    }

    if (key.pageUp || key.pageDown) {
      if (focus.pane === "log") {
        const step = key.pageUp ? -10 : 10;
        setLogTopIdx((cur) => (cur ?? Infinity) + step);
      }
      return;
    }

    if (focus.pane === "log" && (input === "g" || input === "G")) {
      // vim-style: `g` → top of log (oldest), `G` → tail-follow.
      setLogTopIdx(input === "g" ? 0 : null);
      return;
    }

    if (key.leftArrow || key.rightArrow) {
      if (focus.pane === "repos" && repos.length > 0) {
        const delta = key.leftArrow ? -1 : 1;
        const next = (focus.repoIdx + delta + repos.length) % repos.length;
        getState().setFocus({ repoIdx: next, issueIdx: 0 });
      }
      return;
    }

    if (key.return) {
      if (focus.pane === "issues") {
        const issue = currentIssue();
        const repo = currentRepo();
        if (issue && repo) setModal({ issue });
        else showFlash("no issue/repo selected");
      }
      return;
    }

    switch (input) {
      case "/":
        if (focus.pane === "issues") setIssueFilterMode(true);
        return;
      case "?":
        setHelpOpen(true);
        return;
      case "q":
        if (sortedAgents.some((a) => a.status === "running")) setQuitConfirm(true);
        else exit();
        return;
      case "a": {
        const repo = currentRepo();
        if (repo) {
          getState().toggleAutoSpawn(repo.name);
          showFlash(`autoSpawn · ${repo.name} → ${!repo.autoSpawn}`);
        }
        return;
      }
      case "k": {
        const a = currentAgent();
        if (a && a.status === "running") {
          killAgentById(a.id);
          showFlash(`killed ${a.id.slice(0, 8)}`);
        }
        return;
      }
      case "d": {
        const a = currentAgent();
        if (a && a.status !== "running") {
          setDeleteConfirm({ id: a.id, short: a.id.slice(0, 8) });
        } else if (a) {
          showFlash("kill before delete");
        }
        return;
      }
      case "f":
        cycleFilter();
        return;
      case "l":
        if (currentAgent()) setFullLog(true);
        return;
      case "v": {
        const a = currentAgent();
        if (!a) {
          showFlash("no agent focused");
          return;
        }
        setDiffTopIdx(0);
        setDiffRefreshKey((n) => n + 1);
        setFullDiff(true);
        return;
      }
      case "R": {
        const a = currentAgent();
        if (!a) return;
        if (a.status === "running" || a.status === "queued") {
          showFlash("agent already active");
          return;
        }
        if (a.status === "awaiting-review" || a.status === "done") {
          showFlash("only failed/killed/dry agents can re-spawn");
          return;
        }
        respawnFailedAgent(a.id).then((r) => {
          showFlash(r.ok ? `respawned ${a.id.slice(0, 8)}` : `respawn failed: ${r.error}`);
        });
        return;
      }
      case "p": {
        const anyAuto = repos.some((r) => r.autoSpawn);
        if (!anyAuto) {
          showFlash("no repo has autoSpawn on");
          return;
        }
        showFlash("polling…");
        forceTick().then((res) => {
          if (!res.ok) showFlash("poll already running");
          else showFlash(res.ranAny ? "poll: spawned new agent(s)" : "poll: nothing new");
        });
        return;
      }
      case "+":
      case "=":
        getState().bumpConcurrency(1);
        return;
      case "-":
      case "_":
        getState().bumpConcurrency(-1);
        return;
    }
  });

  if (helpOpen) {
    return (
      <Box flexDirection="column" height={termRows} overflow="hidden">
        <Header />
        <HelpModal />
      </Box>
    );
  }

  if (fullLog) {
    return (
      <Box flexDirection="column" height={termRows} overflow="hidden">
        <Header />
        <LogPane fullscreen topIdx={logTopIdx} filter={logFilter} />
        <Box paddingX={1}>
          <Text dimColor>esc/l/q: back · ↑/↓ pageup/pagedown g/G: scroll · f: filter</Text>
        </Box>
      </Box>
    );
  }

  if (fullDiff) {
    return (
      <Box flexDirection="column" height={termRows} overflow="hidden">
        <Header />
        <DiffPane topIdx={diffTopIdx} refreshKey={diffRefreshKey} />
        <Box paddingX={1}>
          <Text dimColor>esc/v/q: back · ↑/↓ pageup/pagedown g/G: scroll · r: refresh</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={termRows} overflow="hidden">
      <Header />
      <RepoBar />
      <Box flexDirection="column" flexGrow={1}>
        <Box>
          <IssueList filter={issueFilter} filterMode={issueFilterMode} />
          <AgentGrid />
        </Box>
        <Box flexGrow={1}>
          <LogPane topIdx={logTopIdx} filter={logFilter} />
        </Box>
      </Box>
      <Box paddingX={1} borderStyle="single" borderColor="gray">
        <Text dimColor>{footerHints(currentAgent(), focus.pane)}</Text>
      </Box>
      {flash && (
        <Box paddingX={1}>
          <Text color="magenta">{flash}</Text>
        </Box>
      )}
      {quitConfirm && (
        <Box borderStyle="double" borderColor="red" paddingX={1}>
          <Text color="red" bold>Agents are running. Quit anyway? (y/n)</Text>
        </Box>
      )}
      {deleteConfirm && (
        <Box borderStyle="double" borderColor="yellow" paddingX={1}>
          <Text color="yellow" bold>
            Delete agent {deleteConfirm.short} (worktree + branch)? (y/n)
          </Text>
        </Box>
      )}
      {modal && currentRepo() && (
        <SpawnModal
          repo={currentRepo()!}
          issue={modal.issue}
          defaultMode={resolveMode(cfg, currentRepo()!)}
        />
      )}
    </Box>
  );
};
