import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useStore } from "./useStore";

const fmt = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
};

const countdownText = (ts?: number): string => {
  if (!ts) return "—";
  const sec = Math.max(0, Math.floor((ts - Date.now()) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
};

export const Header: React.FC = () => {
  const tokensIn = useStore((s) => s.totalInTokens);
  const tokensOut = useStore((s) => s.totalOutTokens);
  const running = useStore(
    (s) => Object.values(s.agents).filter((a) => a.status === "running").length,
  );
  const max = useStore((s) => s.config.maxConcurrent);
  const nextPoll = useStore((s) => s.nextPollAt);
  const anyAuto = useStore((s) => s.config.repos.some((r) => r.autoSpawn));

  // Force re-render every second so the countdown updates even without store changes.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Yggdrasil </Text>
      <Text dimColor>· </Text>
      <Text>tokens: </Text>
      <Text color="yellow">{fmt(tokensIn)}↑ </Text>
      <Text color="green">{fmt(tokensOut)}↓ </Text>
      <Text dimColor>· </Text>
      <Text>agents: </Text>
      <Text color={running >= max ? "red" : "green"}>{running}/{max}</Text>
      {anyAuto && (
        <>
          <Text dimColor> · </Text>
          <Text>next poll: </Text>
          <Text color="magenta">{countdownText(nextPoll)}</Text>
        </>
      )}
    </Box>
  );
};
