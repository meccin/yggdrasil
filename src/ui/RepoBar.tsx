import React from "react";
import { Box, Text } from "ink";
import { useStore, useStoreShallow } from "./useStore";

export const RepoBar: React.FC = () => {
  const repos = useStoreShallow((s) => s.config.repos);
  const focused = useStore((s) => s.focus.pane === "repos");
  const repoIdx = useStore((s) => s.focus.repoIdx);

  return (
    <Box borderStyle="single" borderColor={focused ? "cyan" : "gray"} paddingX={1}>
      <Text dimColor>repos: </Text>
      {repos.length === 0 && (
        <Text dimColor> (empty · use `ygg repo add &lt;path&gt;`)</Text>
      )}
      {repos.map((r, i) => {
        const sel = i === repoIdx;
        return (
          <React.Fragment key={r.name}>
            <Text color={sel ? "cyan" : "white"} bold={sel}>
              {sel ? "● " : "○ "}{r.name}
            </Text>
            <Text dimColor> [{r.provider}]</Text>
            {r.autoSpawn && <Text color="green"> [auto:{r.autoSpawnLabel}]</Text>}
            <Text dimColor>  </Text>
          </React.Fragment>
        );
      })}
    </Box>
  );
};
