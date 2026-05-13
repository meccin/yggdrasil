import React from "react";
import { Box, Text } from "ink";
import type { FinalizeMode, RepoConfig } from "../types";
import type { Issue } from "../sources/types";

interface Props {
  repo: RepoConfig;
  issue: Issue;
  defaultMode: FinalizeMode;
}

export const SpawnModal: React.FC<Props> = ({ repo, issue, defaultMode }) => (
  <Box
    flexDirection="column"
    borderStyle="double"
    borderColor="magenta"
    paddingX={1}
    width={64}
  >
    <Text bold color="magenta">Spawn agent</Text>
    <Text>repo: <Text color="cyan">{repo.name}</Text> <Text dimColor>[{repo.provider}]</Text></Text>
    <Text>issue: <Text color="cyan">#{issue.iid}</Text> {issue.title}</Text>
    <Box marginTop={1} flexDirection="column">
      <Text dimColor>Pick a mode:</Text>
      <Text><Text color="green">m</Text> = mr  (push + open MR/PR + comment)</Text>
      <Text><Text color="yellow">r</Text> = review  (pause for inspection)</Text>
      <Text><Text color="gray">d</Text> = dry  (no external action)</Text>
      <Text dimColor>enter = default ({defaultMode}) · esc = cancel</Text>
    </Box>
  </Box>
);
