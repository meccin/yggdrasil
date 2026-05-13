import React from "react";
import { Box, Text } from "ink";

interface Row {
  key: string;
  label: string;
}

const NAVIGATION: Row[] = [
  { key: "Tab", label: "switch pane focus" },
  { key: "↑/↓", label: "navigate list (scrolls log when log pane is focused)" },
  { key: "←/→", label: "navigate repos (when repos pane is focused)" },
  { key: "Enter", label: "spawn agent on selected issue" },
];

const AGENT: Row[] = [
  { key: "d", label: "delete worktree of focused agent (confirms y/n)" },
  { key: "k", label: "kill process of focused agent" },
  { key: "R", label: "re-spawn failed/killed/dry agent (keeps worktree)" },
  { key: "l", label: "fullscreen log view" },
  { key: "v", label: "fullscreen worktree diff (commits + unified diff)" },
];

const LOG: Row[] = [
  { key: "↑/↓", label: "scroll log by one line (in log pane)" },
  { key: "PgUp/PgDn", label: "scroll log by 10 lines (in log pane)" },
  { key: "g / G", label: "jump to top (oldest) / tail-follow (newest)" },
  { key: "f", label: "cycle filter: all → no-thinking → tools → errors" },
];

const SESSION: Row[] = [
  { key: "a", label: "toggle autoSpawn on focused repo" },
  { key: "p", label: "force a poll cycle now" },
  { key: "+/-", label: "adjust maxConcurrent (1–10)" },
  { key: "?", label: "show this help" },
  { key: "q", label: "quit (confirms if agents are running)" },
];

const Section: React.FC<{ title: string; rows: Row[] }> = ({ title, rows }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Text bold color="cyan">{title}</Text>
    {rows.map((r) => (
      <Box key={r.key}>
        <Box width={10}>
          <Text color="yellow">{r.key}</Text>
        </Box>
        <Text>{r.label}</Text>
      </Box>
    ))}
  </Box>
);

const MODES: Row[] = [
  { key: "mr", label: "push branch + open PR/MR + comment on issue" },
  { key: "review", label: "pause inside worktree for inspection" },
  { key: "dry", label: "no external action" },
];

const STATUS: Array<{ name: string; color: string; desc: string }> = [
  { name: "queued", color: "gray", desc: "waiting for a slot" },
  { name: "running", color: "green", desc: "claude in flight" },
  { name: "awaiting-review", color: "yellow", desc: "ready for inspection" },
  { name: "done", color: "blue", desc: "PR/MR created and comment posted" },
  { name: "done-dry", color: "blue", desc: "finished in dry mode" },
  { name: "failed", color: "red", desc: "error during run/finalize" },
  { name: "killed", color: "red", desc: "process killed by user" },
];

export const HelpModal: React.FC = () => (
  <Box
    flexDirection="column"
    borderStyle="double"
    borderColor="magenta"
    paddingX={2}
    paddingY={1}
  >
    <Text bold color="magenta">Yggdrasil — keys & info</Text>
    <Text> </Text>
    <Section title="Navigation" rows={NAVIGATION} />
    <Section title="Agent control" rows={AGENT} />
    <Section title="Log pane" rows={LOG} />
    <Section title="Session" rows={SESSION} />

    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">Finalize modes (at spawn time)</Text>
      {MODES.map((m) => (
        <Box key={m.key}>
          <Box width={10}><Text color="yellow">{m.key}</Text></Box>
          <Text>{m.label}</Text>
        </Box>
      ))}
    </Box>

    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">autoSpawn</Text>
      <Text>
        Toggle with <Text color="yellow">a</Text>. Poller spawns on issues
        labeled <Text color="yellow">agent-ready</Text>.
      </Text>
      <Text>Force a poll now with <Text color="yellow">p</Text>.</Text>
      <Text dimColor>
        Current label shows in top bar as <Text color="green">[auto:LABEL]</Text>.
      </Text>
    </Box>

    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">Agent status</Text>
      {STATUS.map((s) => (
        <Box key={s.name}>
          <Box width={18}><Text color={s.color}>{s.name}</Text></Box>
          <Text dimColor>{s.desc}</Text>
        </Box>
      ))}
    </Box>

    <Text dimColor>press ? or esc to close</Text>
  </Box>
);
