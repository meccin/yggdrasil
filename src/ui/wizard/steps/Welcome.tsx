import React from "react";
import { Box, Text } from "ink";
import type { CheckResult } from "../../../doctor";

interface Props {
  checks: CheckResult[];
  blocked: { ok: boolean; reasons: string[] };
  providerWarning: boolean;
}

const checkMark = (c: CheckResult): string => {
  if (c.ok) return "✓";
  if (c.level === "fatal") return "✗";
  if (c.level === "warn") return "✗";
  return "·";
};

const checkColor = (c: CheckResult): string => {
  if (c.ok) return "green";
  if (c.level === "fatal") return "red";
  if (c.level === "warn") return "yellow";
  return "gray";
};

export const Welcome: React.FC<Props> = ({ checks, blocked, providerWarning }) => (
  <Box flexDirection="column">
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="magenta">
        Welcome to Yggdrasil
      </Text>
      <Text dimColor>
        Multi-agent dashboard for Claude Code over GitLab / GitHub issues.
      </Text>
    </Box>

    <Box flexDirection="column" marginBottom={1}>
      <Text bold>Setup steps:</Text>
      <Text dimColor>  1. Environment checks</Text>
      <Text dimColor>  2. Repo path</Text>
      <Text dimColor>  3. Provider confirm</Text>
      <Text dimColor>  4. Permission preset</Text>
      <Text dimColor>  5. Label, finalize mode &amp; summary</Text>
    </Box>

    <Box flexDirection="column" marginBottom={1}>
      <Text bold>Environment:</Text>
      {checks.map((c) => (
        <Box key={c.name}>
          <Text color={checkColor(c)}>{checkMark(c)} </Text>
          <Text>{c.name}</Text>
          {c.hint && !c.ok && (
            <Text dimColor>  → {c.hint}</Text>
          )}
        </Box>
      ))}
    </Box>

    {blocked.ok ? (
      <Box flexDirection="column">
        {providerWarning && (
          <Box marginBottom={1}>
            <Text color="yellow">
              ⚠ No provider CLI is authenticated yet. You can keep going — `glab
              auth login` / `gh auth login` before the first spawn.
            </Text>
          </Box>
        )}
        <Box>
          <Text color="green">Press </Text>
          <Text color="cyan">enter</Text>
          <Text color="green"> to continue · </Text>
          <Text color="yellow">esc</Text>
          <Text dimColor> to cancel</Text>
        </Box>
      </Box>
    ) : (
      <Box flexDirection="column">
        <Text color="red" bold>
          Cannot continue:
        </Text>
        {blocked.reasons.map((r) => (
          <Text key={r} color="red">  · {r}</Text>
        ))}
        <Box marginTop={1}>
          <Text dimColor>Fix the items above and re-run `ygg init`. Press </Text>
          <Text color="yellow">esc</Text>
          <Text dimColor> to exit.</Text>
        </Box>
      </Box>
    )}
  </Box>
);
