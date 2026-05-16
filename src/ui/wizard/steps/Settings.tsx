import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import type { FinalizeMode } from "../../../types";
import { getPreset, type PresetId } from "../presets";
import { repoNameFromPath } from "../../../sources";

interface Props {
  path: string;
  provider: string;
  preset: PresetId;
  initialLabel: string;
  initialMode: FinalizeMode;
  onSubmit: (label: string, mode: FinalizeMode) => void;
}

const MODE_ITEMS: { label: string; value: FinalizeMode }[] = [
  { label: "review  — pause for inspection in the worktree (recommended)", value: "review" },
  { label: "mr      — push + open MR/PR + comment back on the issue", value: "mr" },
  { label: "dry     — finish, no external action", value: "dry" },
];

export const Settings: React.FC<Props> = ({
  path,
  provider,
  preset,
  initialLabel,
  initialMode,
  onSubmit,
}) => {
  const [stage, setStage] = useState<"label" | "mode">("label");
  const [label, setLabel] = useState(initialLabel);
  const [mode, setMode] = useState<FinalizeMode>(initialMode);
  const presetDesc = getPreset(preset);
  const name = repoNameFromPath(path);
  const initialModeIdx = Math.max(0, MODE_ITEMS.findIndex((i) => i.value === initialMode));

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Label + finalize mode</Text>
      </Box>

      <Box flexDirection="column">
        <Text dimColor>
          AutoSpawn label: issues with this label become candidates for the auto-spawn poller.
        </Text>
        <Box>
          <Text color="cyan">label: </Text>
          {stage === "label" ? (
            <TextInput
              value={label}
              onChange={setLabel}
              onSubmit={() => setStage("mode")}
            />
          ) : (
            <Text>{label || "agent-ready"}</Text>
          )}
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Default finalize mode (per-spawn override available in the TUI):</Text>
        {stage === "mode" ? (
          <SelectInput
            items={MODE_ITEMS}
            initialIndex={initialModeIdx}
            onHighlight={(it) => setMode(it.value)}
            onSelect={(it) => onSubmit(label.trim() || "agent-ready", it.value)}
          />
        ) : (
          <Text dimColor>  (set label first)</Text>
        )}
      </Box>

      <Box
        flexDirection="column"
        marginTop={1}
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
      >
        <Text bold>About to save:</Text>
        <Text>
          <Text dimColor>name:     </Text>
          <Text color="cyan">{name}</Text>
        </Text>
        <Text>
          <Text dimColor>path:     </Text>
          <Text>{path}</Text>
        </Text>
        <Text>
          <Text dimColor>provider: </Text>
          <Text>{provider}</Text>
        </Text>
        <Text>
          <Text dimColor>preset:   </Text>
          <Text color="yellow">{presetDesc.id}</Text>
          <Text dimColor> ({presetDesc.permissionMode})</Text>
        </Text>
        <Text>
          <Text dimColor>label:    </Text>
          <Text>{label || "agent-ready"}</Text>
        </Text>
        <Text>
          <Text dimColor>mode:     </Text>
          <Text>{mode}</Text>
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {stage === "label"
            ? "enter: next field · esc: cancel"
            : "↑↓ pick · enter: save & launch TUI · esc: cancel"}
        </Text>
      </Box>
    </Box>
  );
};
