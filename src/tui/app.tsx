import { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { defaultMessageGenerator } from '../messages/generator.js';
import type { CommitCluster, Plan, PlannedCommit } from '../model/types.js';

export interface TuiProps {
  plan: Plan;
  onApply: (plan: Plan) => void;
  onQuit: () => void;
}

type Mode = 'browse' | 'rename';

const generator = defaultMessageGenerator;

function mergeClusters(a: CommitCluster, b: CommitCluster): CommitCluster {
  return {
    id: a.id,
    units: [...a.units, ...b.units],
    rank: Math.min(a.rank, b.rank),
    fromCycle: a.fromCycle || b.fromCycle,
    reason: 'merged during review',
  };
}

function splitCluster(cluster: CommitCluster): [CommitCluster, CommitCluster] | null {
  if (cluster.units.length < 2) return null;
  const mid = Math.ceil(cluster.units.length / 2);
  return [
    { ...cluster, units: cluster.units.slice(0, mid), reason: 'split during review' },
    { ...cluster, units: cluster.units.slice(mid), reason: 'split during review' },
  ];
}

function reindex(commits: PlannedCommit[]): PlannedCommit[] {
  return commits.map((commit, index) => ({ ...commit, index: index + 1 }));
}

/**
 * Interactive review. Every operation preserves the full set of change units,
 * so applying an edited plan still reproduces the working tree exactly.
 *
 * Keys: ↑/↓ or j/k move, J/K reorder, m merge into previous, s split,
 * r rename, enter/a apply, q quit.
 */
export function App({ plan, onApply, onQuit }: TuiProps) {
  const [commits, setCommits] = useState<PlannedCommit[]>(plan.commits);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>('browse');
  const [buffer, setBuffer] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  const current = commits[cursor];

  const regenerate = (clusters: CommitCluster[]): void => {
    void (async () => {
      const messages = await Promise.all(clusters.map((cluster) => generator.generate(cluster)));
      setCommits(
        reindex(
          clusters.map((cluster, index) => ({
            index: index + 1,
            cluster,
            message: messages[index]!,
            files: [...new Set(cluster.units.map((u) => u.file))].sort(),
          })),
        ),
      );
    })();
  };

  const move = (delta: number): void => {
    const next = cursor + delta;
    if (next < 0 || next >= commits.length || delta === 0) return;
    const copy = [...commits];
    const [item] = copy.splice(cursor, 1);
    copy.splice(next, 0, item!);
    setCommits(reindex(copy));
    setCursor(next);
    setStatus('reordered (dependency order may need review)');
  };

  const apply = (): void => {
    onApply({
      ...plan,
      commits: reindex(commits),
      clustered: commits.map((commit) => commit.cluster),
      stats: { ...plan.stats, clusters: commits.length },
    });
  };

  useInput((input, key) => {
    if (mode === 'rename') {
      if (key.escape) {
        setMode('browse');
        setBuffer('');
        return;
      }
      if (key.return) {
        if (buffer.trim().length > 0 && current) {
          const copy = [...commits];
          copy[cursor] = {
            ...current,
            message: { ...current.message, subject: buffer.trim() },
          };
          setCommits(copy);
          setStatus('renamed');
        }
        setMode('browse');
        setBuffer('');
        return;
      }
      if (key.backspace || key.delete) {
        setBuffer((value) => value.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setBuffer((value) => value + input);
      }
      return;
    }

    if (input === 'q' || key.escape) {
      onQuit();
      return;
    }
    if (input === 'a' || key.return) {
      apply();
      return;
    }
    if (key.upArrow || input === 'k') {
      setCursor(Math.max(0, cursor - 1));
      setStatus(null);
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor(Math.min(commits.length - 1, cursor + 1));
      setStatus(null);
      return;
    }
    if (input === 'K') {
      move(-1);
      return;
    }
    if (input === 'J') {
      move(1);
      return;
    }
    if (input === 'm') {
      if (cursor === 0) {
        setStatus('nothing above to merge into');
        return;
      }
      const merged = mergeClusters(commits[cursor - 1]!.cluster, commits[cursor]!.cluster);
      const clusters = [
        ...commits.slice(0, cursor - 1).map((c) => c.cluster),
        merged,
        ...commits.slice(cursor + 1).map((c) => c.cluster),
      ];
      regenerate(clusters);
      setCursor(cursor - 1);
      setStatus('merged into previous commit');
      return;
    }
    if (input === 's') {
      if (!current) return;
      const halves = splitCluster(current.cluster);
      if (!halves) {
        setStatus('need at least two units to split');
        return;
      }
      const clusters = [
        ...commits.slice(0, cursor).map((c) => c.cluster),
        ...halves,
        ...commits.slice(cursor + 1).map((c) => c.cluster),
      ];
      regenerate(clusters);
      setStatus('split into two commits');
      return;
    }
    if (input === 'r') {
      if (!current) return;
      setMode('rename');
      setBuffer(current.message.subject);
      setStatus(null);
    }
  });

  const files = useMemo(() => current?.files ?? [], [current]);

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
        <Text bold>{commits.length} commit(s)</Text>
        <Text dimColor>  (edits never change file contents)</Text>
      </Box>
      {commits.map((item, i) => (
        <Box key={`${item.cluster.id}-${i}`} flexDirection="column">
          <Text color={i === cursor ? 'cyan' : undefined}>
            {i === cursor ? '❯' : ' '} {i + 1}. {item.message.subject}
          </Text>
          {i === cursor ? (
            <Box marginLeft={3}>
              <Text dimColor>{files.join(', ') || '(no files)'}</Text>
            </Box>
          ) : null}
        </Box>
      ))}
      <Box marginTop={1} flexDirection="column">
        {mode === 'rename' ? (
          <Box>
            <Text color="yellow">rename: </Text>
            <Text>{buffer}</Text>
            <Text color="gray">▏</Text>
            <Text dimColor>  (enter to save, esc to cancel)</Text>
          </Box>
        ) : (
          <Text dimColor>↑↓/jk move · J/K reorder · m merge · s split · r rename · enter apply · q quit</Text>
        )}
        {status ? <Text color="yellow">{status}</Text> : null}
      </Box>
    </Box>
  );
}
