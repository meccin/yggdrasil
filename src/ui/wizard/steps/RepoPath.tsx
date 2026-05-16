import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  error: string | null;
}

export const RepoPath: React.FC<Props> = ({ value, onChange, onSubmit, error }) => (
  <Box flexDirection="column">
    <Box marginBottom={1}>
      <Text bold>Repo path</Text>
    </Box>
    <Text dimColor>
      Absolute or relative path to the git working tree you want Yggdrasil to manage.
    </Text>
    <Text dimColor>It must be a git repo with an `origin` remote on GitLab or GitHub.</Text>

    <Box marginTop={1}>
      <Text color="cyan">path: </Text>
      <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
    </Box>

    {error && (
      <Box marginTop={1}>
        <Text color="red">✗ {error}</Text>
      </Box>
    )}

    <Box marginTop={1}>
      <Text dimColor>enter: validate &amp; continue · esc: cancel</Text>
    </Box>
  </Box>
);
