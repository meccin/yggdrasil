import React from "react";
import { Box, Text } from "ink";

interface Props {
  repoName: string;
}

export const Finish: React.FC<Props> = ({ repoName }) => (
  <Box flexDirection="column">
    <Box marginBottom={1}>
      <Text color="green" bold>
        ✓ Repo saved: <Text color="cyan">{repoName}</Text>
      </Text>
    </Box>

    <Box flexDirection="column" marginBottom={1}>
      <Text bold>Next steps (when you're ready):</Text>
      <Text dimColor>
        · profile pipelines (multi-step plan/implement/evaluate flow):
      </Text>
      <Text>      <Text color="cyan">ygg profile init my-flow --template harness</Text></Text>
      <Text dimColor>· per-repo Claude account (CLAUDE_CONFIG_DIR):</Text>
      <Text>      <Text color="cyan">ygg repo set {repoName} --claude-dir ~/.claude-work</Text></Text>
      <Text dimColor>· custom tool allow/deny lists beyond the preset:</Text>
      <Text>      <Text color="cyan">ygg repo set {repoName} --allow-tool 'Bash(bun *)'</Text></Text>
      <Text dimColor>· validate environment again:</Text>
      <Text>      <Text color="cyan">ygg doctor</Text></Text>
    </Box>

    <Box>
      <Text color="green">Launching TUI… </Text>
      <Text dimColor>(press </Text>
      <Text color="yellow">enter</Text>
      <Text dimColor> to continue, </Text>
      <Text color="yellow">q</Text>
      <Text dimColor> to exit instead)</Text>
    </Box>
  </Box>
);
