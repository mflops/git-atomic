import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface TuiPlan {
  commits: Array<{
    index: number;
    subject: string;
    files: string[];
  }>;
  branch: string;
  baseRef: string;
  base: string;
}

export interface TuiProps {
  plan: TuiPlan;
  onApply: () => void;
  onQuit: () => void;
}

/**
 * Interactive review of the generated plan. The history is verified end-to-end
 * before this screen opens, so the only decision left is apply or abort.
 */
export function App({ plan, onApply, onQuit }: TuiProps) {
  const [cursor, setCursor] = useState(0);
  const commit = plan.commits[cursor];

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      onQuit();
      return;
    }
    if (input === 'a' || key.return) {
      onApply();
      return;
    }
    if ((key.upArrow || input === 'k') && cursor > 0) {
      setCursor(cursor - 1);
      return;
    }
    if ((key.downArrow || input === 'j') && cursor < plan.commits.length - 1) {
      setCursor(cursor + 1);
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">git-atomic</Text>
        <Text dimColor> · </Text>
        <Text>{plan.baseRef}</Text>
        <Text dimColor> {plan.base.slice(0, 8)} → </Text>
        <Text color="green">{plan.branch}</Text>
      </Box>
      <Box marginTop={1}>
        <Text bold>{plan.commits.length} commit(s)</Text>
      </Box>
      {plan.commits.map((item, i) => (
        <Box key={item.index} flexDirection="column">
          <Text color={i === cursor ? 'cyan' : undefined}>
            {i === cursor ? '❯' : ' '} {item.index}. {item.subject}
          </Text>
          {i === cursor && item.files.length > 0 ? (
            <Box marginLeft={3}>
              <Text dimColor>{item.files.join(', ')}</Text>
            </Box>
          ) : null}
        </Box>
      ))}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>↑/↓ or j/k move · enter/a apply · q quit</Text>
        {commit ? (
          <Text dimColor>
            {commit.files.length} file(s) in selected commit
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
