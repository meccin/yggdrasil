import React, { useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import { PRESETS, type PresetId } from "../presets";

interface Props {
  initial: PresetId;
  onSelect: (id: PresetId) => void;
}

const ITEMS = PRESETS.map((p) => ({ label: p.label, value: p.id }));

export const PresetStep: React.FC<Props> = ({ initial, onSelect }) => {
  const [highlight, setHighlight] = useState<PresetId>(initial);
  const initialIndex = Math.max(0, PRESETS.findIndex((p) => p.id === initial));
  const focused = PRESETS.find((p) => p.id === highlight) || PRESETS[1];

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Permission preset</Text>
      </Box>
      <Text dimColor>How aggressively should the agent be allowed to act?</Text>

      <Box marginTop={1}>
        <SelectInput
          items={ITEMS}
          initialIndex={initialIndex}
          onHighlight={(it) => setHighlight(it.value)}
          onSelect={(it) => onSelect(it.value)}
        />
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color="cyan">{focused.id}</Text>
          <Text dimColor> · </Text>
          <Text>{focused.blurb}</Text>
        </Text>
        <Text dimColor>
          mode: <Text color="yellow">{focused.permissionMode}</Text>
        </Text>
        <Text dimColor>
          allow: <Text color="green">{focused.allowedTools.join(", ")}</Text>
        </Text>
        {focused.warning && (
          <Box marginTop={1}>
            <Text color="red">⚠ {focused.warning}</Text>
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>↑↓ pick · enter: continue · esc: cancel</Text>
      </Box>
    </Box>
  );
};
