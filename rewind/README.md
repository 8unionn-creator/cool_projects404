# ⏪ Rewind

**Undo history for AI coding agents.** Rewind records every step an agent takes as a Git snapshot. You can see what changed at each step, which prompt caused it, and put your files back to any earlier step.

```
$ rewind log
Session claude-1a2b3c4d  4 steps · started Oct 4 15:30

     0  15:30:36  start    baseline                session started
  ▸ Add a greeting and a helper package
     1  15:31:02  tool     +3 -1 1 file            Edit src/main.go
     2  15:31:40  tool     +1 -0 1 file            Write src/util/util.go
  ▸ Actually delete the helper and rename main.go
     3  15:33:15  tool     +5 -6 3 files           Bash: rm -rf src/util && mv src/main.go src/app.go

$ rewind restore 2
  write         src/main.go
  write         src/util/util.go
  delete        src/app.go

Restored step 2. The state before the restore is saved too, so `rewind log` shows how to undo this.
```

## Why

Agents edit dozens of files in one session. When step 14 of 30 goes wrong, `git` doesn't help much: the agent didn't commit, and `git stash` or `checkout` throws away the good steps along with the bad one. Rewind keeps a snapshot of **every** step, so you can go back to exactly the last one that worked.

## Install

```sh
go install github.com/8unionn-creator/cool_projects404/rewind/cmd/rewind@latest
```

## Use it with Claude Code

```sh
cd your-repo
rewind init claude     # adds hooks to .claude/settings.local.json
```

From then on, every Claude Code session in that repo is recorded automatically:

| Claude Code event | Rewind records |
|---|---|
| `SessionStart` | a baseline of the repo |
| `UserPromptSubmit` | the prompt, plus any edits you made by hand since the last step |
| `PostToolUse` (Edit, Write, Bash…) | what the tool changed, labelled with the prompt that caused it |

Tool calls that don't change any file, such as reads, searches or `ls`, add no step.

## Commands

| Command | What it does |
|---|---|
| `rewind log` | Steps of the current session, grouped by prompt |
| `rewind show 7 -p` | What step 7 changed, why, and the full patch |
| `rewind diff 3 9` | Everything that changed between step 3 and step 9 |
| `rewind diff -w 5` | What changed since step 5, compared with your files now |
| `rewind restore -n 5` | Preview a restore without touching anything |
| `rewind restore 5` | Put the files back as they were at step 5 |
| `rewind sessions` | All recorded sessions |
| `rewind start` / `rewind snap -m "…"` | Record by hand, without an agent |

Steps are numbers in the current session (`7`), `last`, or `session:number` for another session.

## How it works

Every snapshot is an ordinary Git commit on its own ref, `refs/rewind/<session>`, so the whole history can be read with plain `git`:

```sh
git log --oneline refs/rewind/claude-1a2b3c4d
```

- **Your Git state is never touched.** Snapshots are built with a private, temporary index file (`GIT_INDEX_FILE`) seeded from yours. Your branch, HEAD, staged changes and stash are left exactly as they were.
- **Everything that matters is captured.** That means tracked and untracked files, while `.gitignore` is respected, so `node_modules/` and build output are skipped.
- **It's cheap.** Git stores each file's content once, so 100 steps that each change one file cost roughly 100 small blobs.
- **Restoring is safe and can be undone.** Before a restore, the current state is saved as a step. A restore only rewrites files that differ, and never touches ignored files.
- **Safe with hooks that fire close together.** Writers take a lock, and each ref update is compare-and-swap on the previous step, so a session can never fork or skip a number.
- **Never blocks the agent.** If recording fails, the hook logs to `.git/rewind/hook.log` and exits successfully.

Step metadata (kind, tool, prompt) is stored as one JSON line at the end of each commit message.

## Roadmap

- [x] **Stage 1:** snapshots, log, show, diff, restore, Claude Code hooks
- [ ] **Stage 2:** code map: an architecture view of the whole program in the browser (modules, imports, definitions) using tree-sitter, for Go, TypeScript and Python
- [ ] **Stage 3:** replay a session on the map: watch the touched code light up step by step, see what depends on each change, and get warnings when a step adds a new dependency or an import cycle
- [ ] **Stage 4:** hotspots from Git history, a guided tour of a codebase, hooks for more agents

## Development

```sh
go test -race ./...
```

Tests create throwaway Git repositories and check results against stock `git`, including `git fsck` on every object Rewind writes.
