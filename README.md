# git-atomic

> Point `git-atomic` at your working tree. Get back a clean history where **every commit builds and passes tests.** Nothing on your original branch is ever touched.

`git-atomic` turns a messy branch (or a pile of uncommitted work) into clean,
logically-ordered **atomic commits** — then leaves your original branch exactly
as it found it.

```console
$ git-atomic
git-atomic · my-app
base   main (a1b2c3d4)
branch git-atomic/split (new branch, dry-run)
stats  5 file(s), 5 unit(s), 5 commit(s), 4 edge(s), +33/-1

1. feat(math): add add, multiply
2. feat(string): add titleCase
3. feat(index): add compute, label
4. test(math): add tests for math
5. docs: update README
```

## Why it's different

Most "commit splitter" tools group changes by file proximity and vibes.
`git-atomic` is built on a real dependency graph:

1. **Dependency-aware grouping.** Changes are mapped to source symbols, then
   linked by *definition-before-use*, *import-usage*, *source-before-test* and
   *manifest-before-lockfile* edges. Cycles are detected and merged rather than
   forced apart.
2. **Proven fidelity.** Replaying every change unit must reproduce the working
   tree **byte-for-byte**, or `git-atomic` refuses to apply. The final tree is
   also compared against a tree built from the working directory with a
   throwaway index — a real, machine-checked proof.
3. **Offline by default.** Symbol mapping uses bundled tree-sitter WASM
   grammars; there is no network call anywhere in the pipeline.
4. **Non-destructive by design.** The original branch is never touched: the
   only ref write is `refs/heads/<new-branch>`, built entirely from git
   plumbing (`hash-object`, `read-tree`, `update-index`, `write-tree`,
   `commit-tree`, `update-ref`).

## Install & use

```console
$ npx git-atomic --dry-run     # print the plan (the default)
$ npx git-atomic --apply       # create the new branch
```

Options:

| Flag | Meaning |
| --- | --- |
| `--base <ref>` | Base to flatten from. Defaults to the merge-base with `main`/`master`, else `HEAD`. |
| `--branch <name>` | New branch name. Defaults to `git-atomic/split`. |
| `--apply` / `--dry-run` | Apply, or just print the plan (default). |
| `--force` | Overwrite the target branch if it already exists. |
| `--max-commits <n>` | Upper bound on the number of commits. |
| `--ignore <glob>` | Exclude paths (repeatable). |
| `--no-symbols` | Disable symbol mapping (proximity clustering only). |
| `--check <cmd>` | Build/test command to run after each commit (repeatable). |
| `--skip-check` | Do not run checks even if configured. |
| `--check-timeout <ms>` | Timeout per check command (default 300000). |
| `--interactive` | Review the plan in a TUI, then apply or quit. |
| `--json` | Machine-readable plan. |

### Config file

`git-atomic.config.json` at the repo root:

```json
{
  "base": "main",
  "branch": "atomic/split",
  "ignore": ["dist/**", "coverage/**"],
  "maxCommits": 12,
  "check": "npm test",
  "checkTimeout": 300000,
  "checkLinks": ["node_modules"]
}
```

## How it works

```
working tree ─┬─> unified diff (-U0) ─> change blocks ─> change units (per symbol)
              │
              └─> dependency graph ─> cycle collapse + cohesion ─> topological order
                                                                        │
                          deterministic messages ───────────────────────┤
                                                                        v
                                              new branch via git plumbing (+ fidelity proof)
```

- **Change units** are the smallest coherent edits. Blocks are attributed to the
  innermost enclosing symbol (tree-sitter for TS/TSX/JS, with a dependency-free
  heuristic scanner and proximity clustering as fallbacks).
- **Ordering** is a topological sort with a rank tie-break:
  config/types → manifest → implementation → tests → docs → lockfile.
- **Clustering** merges dependency cycles and keeps cohesive files (tests, docs,
  config) whole, while implementation files can still split per symbol.
- **Fidelity** is checked twice: a per-file byte comparison, and a whole-tree
  comparison against the working directory.
- **Buildability-aware.** Optionally run `--check` after each commit and fold
  failing commits together until the history builds and passes.

## Status / roadmap

Implemented: the core pipeline (diff → change units → dependency graph →
clustering → ordering → apply with fidelity proof → deterministic messages) plus
buildability verification with a fold-back repair loop.

Planned (see the build plan): an interactive review TUI, optional LLM commit
messages (the `MessageGenerator` seam already exists), and additional grammars.

## Development

```console
$ npm install
$ npm run typecheck
$ npm test
$ npm run build && node dist/cli.js --help
$ npm run demo    # create a sample messy repo and print a plan
```

Requires Node 20+.

## License

MIT
