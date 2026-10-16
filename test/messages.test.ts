import { describe, expect, it } from 'vitest';
import { generateMessage } from '../src/messages/generate.js';
import type { ChangeUnit, CommitCluster, UnitKind } from '../src/model/types.js';

function unit(id: string, file: string, kind: UnitKind, overrides: Partial<ChangeUnit> = {}): ChangeUnit {
  return {
    id,
    file,
    kind,
    symbol: null,
    symbolKey: id,
    label: id,
    blocks: [],
    deletesFile: false,
    addedLines: [],
    removedLines: [],
    defines: [],
    references: [],
    imports: [],
    resolvedImports: [],
    ...overrides,
  };
}

function cluster(units: ChangeUnit[], reason = 'single change unit'): CommitCluster {
  return { id: 'c1', units, rank: 3, fromCycle: false, reason };
}

describe('generateMessage', () => {
  it('describes a new feature with a scope', () => {
    const message = generateMessage(
      cluster([
        unit('u', 'src/math.ts', 'implementation', {
          defines: ['add'],
          addedLines: ['export function add(a, b) {', '  return a + b;', '}'],
        }),
      ]),
    );
    expect(message.subject).toBe('feat(math): add add');
    expect(message.type).toBe('feat');
  });

  it('describes tests using the module under test', () => {
    const message = generateMessage(
      cluster([
        unit('t', 'test/math.test.ts', 'test', {
          resolvedImports: ['src/math.ts'],
          addedLines: ['describe("math", () => {})'],
        }),
      ]),
    );
    expect(message.subject).toBe('test(math): add tests for math');
  });

  it('omits the scope for docs', () => {
    const message = generateMessage(
      cluster([unit('d', 'README.md', 'docs', { addedLines: ['# hi'] })]),
    );
    expect(message.subject).toBe('docs: update README.md');
  });

  it('describes dependency updates', () => {
    const message = generateMessage(cluster([unit('m', 'package.json', 'manifest')]));
    expect(message.subject).toBe('build: update dependencies');
  });

  it('describes removals', () => {
    const message = generateMessage(
      cluster([
        unit('r', 'src/old.ts', 'implementation', {
          deletesFile: true,
          removedLines: ['a', 'b'],
        }),
      ]),
    );
    expect(message.subject).toContain('remove');
    expect(message.type).toBe('chore');
  });

  it('is deterministic', () => {
    const build = () =>
      generateMessage(
        cluster([
          unit('u', 'src/a.ts', 'implementation', { defines: ['x'], addedLines: ['export function x() {}'] }),
        ]),
      );
    expect(build()).toEqual(build());
  });
});
