# mend — one patch tool for every AI edit format

[![hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Alim-14-code/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Alim-14-code/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)

Entry for the [hidden-spec-cli-01-run-20261122](https://make.fun/competitions/hidden-spec-cli-01-run-20261122) competition on make.fun: build **mend**, one command-line tool that applies the edits AI models write, in four formats, to a tree of files.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is a file, `-`, or omitted to read the patch from standard input.
- `--format` forces one format: `unified`, `search-replace`, `v4a`, or `json`. Without it, the format is detected from the patch.
- `--check` prints what would change and writes nothing.
- `--strict` limits line matching to tier 0 (exact lines only).

On success it prints one line per changed file (`A` added, `D` deleted, `M` modified, `R <old> -> <new>` renamed) and `ok: n file(s)`, and exits 0. A failed edit prints `error: <kind> <path>` per failure plus `failed: k of n edits` and exits 1. A bad command line, a missing patch file, an unknown format, or a malformed patch prints `error: usage`, `error: no-patch`, `error: format`, or `error: parse <line>` and exits 2.

## The four formats

- **Unified diff** — `--- ` / `+++ ` headers, `@@ -A[,B] +C[,D] @@` hunks, `diff --git`, `rename from/to`, `new file mode` / `deleted file mode`. Hunks take the occurrence nearest to their (drifted) line number.
- **SEARCH/REPLACE** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks, the path on the nearest line above each block (or the previous block's path). An empty old section creates the file.
- **V4A** — `*** Begin Patch` / `*** End Patch` with `*** Add File:`, `*** Delete File:`, `*** Update File:` sections, `@@` anchors, `*** Move to:`, and `*** End of File`. Chunks run in order from a moving cursor.
- **JSON tool calls** — one object per line: `str_replace` (exactly one occurrence), `insert` (1-based line, clamped), `create` (writes the string as it is).

## Line matching

Every old block is matched at the first tier where it occurs: tier 0 exact lines, tier 1 ignoring trailing whitespace, tier 2 ignoring leading and trailing whitespace. A context line is written as the file's own line; at tier 2, added lines are re-indented from the old block's leading whitespace to the file's. CRLF and LF line breaks are preserved per file, and so is the file's final line break (except where a unified hunk's `\ No newline at end of file` says otherwise). All edits apply atomically: if any edit fails, no file is written.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the trial runner (kept as the kit has it).
- `check.ts`: the practice set on your own machine — `node check.ts <practice.json>`.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## Practice

```
node check.ts ../program/generator/practice.json
```
