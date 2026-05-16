import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import type { Provider } from "../../../types";
import type { RemoteInfo } from "../../../sources";

interface Props {
  detected: RemoteInfo;
  onSelect: (provider: Provider) => void;
}

const ITEMS: { label: string; value: Provider }[] = [
  { label: "GitLab", value: "gitlab" },
  { label: "GitHub", value: "github" },
];

export const ProviderStep: React.FC<Props> = ({ detected, onSelect }) => {
  const initial = ITEMS.findIndex((i) => i.value === detected.provider);
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Provider</Text>
      </Box>
      <Box>
        <Text dimColor>detected: </Text>
        <Text color="green">{detected.provider}</Text>
        <Text dimColor> · slug: </Text>
        <Text color="cyan">{detected.repo}</Text>
      </Box>
      <Text dimColor>Override if the auto-detection is wrong (rare).</Text>
      <Box marginTop={1} flexDirection="column">
        <SelectInput
          items={ITEMS}
          initialIndex={Math.max(0, initial)}
          onSelect={(item) => onSelect(item.value)}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ pick · enter: continue · esc: cancel</Text>
      </Box>
    </Box>
  );
};
