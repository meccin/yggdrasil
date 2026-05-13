# Yggdrasil

TUI multi-agent dashboard for Claude Code on top of GitLab or GitHub issues.
Dispatch N agents in parallel, each working on its own issue inside an isolated
`git worktree`.

> *"From Yggdrasil's branches, ravens fly to every realm."*

## Requirements

- [Bun](https://bun.sh)
- [Claude Code CLI](https://claude.com/claude-code) (`claude`)
- One of:
  - [GitLab CLI](https://gitlab.com/gitlab-org/cli) (`glab`) — for GitLab repos
  - [GitHub CLI](https://cli.github.com/) (`gh`) — for GitHub repos
- `git`

## Install

```bash
cd /path/to/yggdrasil
bun install
bun link
ygg doctor
```

`bun link` exposes the `ygg` binary in `~/.bun/bin/` (make sure that's in your `$PATH`).

## CLI

```
ygg                                  # opens TUI
ygg repo add <path> [opts]           # register a repo (or update if name exists)
    --label NAME                     # custom autoSpawn label (default: agent-ready)
    --provider gitlab|github         # force provider (auto-detected by default)
    --claude-dir PATH                # custom CLAUDE_CONFIG_DIR for this repo
ygg repo set <name> [opts]           # edit fields on an existing repo
    --label NAME
    --claude-dir PATH|none           # `none` clears (back to ~/.claude default)
    --permission-mode MODE|none
    --default-mode mr|review|dry|none
ygg repo list
ygg repo rm <name>
ygg metrics [opts]                   # show usage metrics
    --repo NAME
    --since YYYY-MM-DD
    --until YYYY-MM-DD
    --json
ygg doctor                           # validate environment (claude, glab/gh auth, config)
ygg --version
ygg --help
```

### Self-hosted GitLab

For self-hosted GitLab instances, the stored `remoteRepo` slug includes the
host (e.g. `gitlab.example.com/team/project`) so `glab` resolves to the right
API endpoint. `ygg repo add` auto-detects this from `git remote get-url
origin`. Old entries without the host are migrated automatically on the next
`ygg` run (only when the detected slug strictly adds a host prefix — manual
edits are preserved).

## Configuration file

`~/.yggdrasil/config.json` is editable by hand. After any manual change,
restart `ygg`. Shape:

```jsonc
{
  "permissionMode": "acceptEdits",       // global default
  "maxConcurrent": 3,                    // 1..10
  "pollIntervalSec": 300,                // >= 60
  "defaultMode": "review",               // mr | review | dry
  "repos": [
    {
      "name": "owner/project",
      "path": "/abs/path/to/repo",
      "provider": "gitlab",              // gitlab | github
      "remoteRepo": "host/owner/project",
      "autoSpawn": false,
      "autoSpawnLabel": "agent-ready",
      "permissionMode": null,            // null = inherit global
      "defaultMode": null,               // null = inherit global
      "claudeConfigDir": null            // null = ~/.claude
    }
  ]
}
```

## On-disk layout

User data (created on first run):

```
~/.yggdrasil/
├── config.json             # repos, defaults
├── state.json              # agents persisted between runs
├── metrics.ndjson          # usage events (append-only, rotates at 5MB)
├── metrics.ndjson.1..5     # rotated archives, oldest dropped first
├── wt/<repo>/issue-<id>/   # worktrees
└── logs/<agent>.ndjson     # raw stream-json output, per agent (oldest pruned beyond 200)
```

## Finalize modes

- **mr**: push branch, open PR/MR (`glab mr create` or `gh pr create`), comment back on the issue. If the branch already exists upstream, push new commits and comment with the existing PR/MR.
- **review**: pause inside the worktree for you to inspect.
- **dry**: no external action.

Configurable per agent at spawn time (modal) and as a per-repo default (`defaultMode`).

### Issue comment

After `mr` finalizes, the issue gets a comment containing the agent's final
summary plus a link to the PR/MR. Yggdrasil instructs the agent to write that
summary **in the same language as the issue description**, so localized issues
get localized replies without configuration.

### Commit & PR/MR authorship

The agent prompt explicitly tells `claude` **not** to add `Co-Authored-By`
trailers or `Generated with Claude Code` taglines to commit messages or PR/MR
descriptions. PR/MR body uses `--fill` (derived from commits), so removing the
tagline at commit time also removes it from the PR/MR.

## Per-repo Claude account (`claudeConfigDir`)

Claude Code stores credentials/config under `~/.claude` by default. If you have
multiple Claude accounts (personal, work, team), Claude Code respects the
`CLAUDE_CONFIG_DIR` env var to point at a different directory (e.g.
`~/.claude2`, `~/.claude-work`).

Yggdrasil lets you bind a Claude config dir per repo. Set it at add time:

```bash
ygg repo add /path/to/repo --claude-dir ~/.claude-work
```

Or change it on an existing repo:

```bash
ygg repo set <name> --claude-dir ~/.claude-work
ygg repo set <name> --claude-dir none     # back to the default ~/.claude
```

`ygg repo list` shows the current value. When an agent spawns, the runner
exports `CLAUDE_CONFIG_DIR=<the value>` only for that `claude -p` process —
your interactive shell is untouched.

## Permission mode

Global default: `acceptEdits`. Per-repo override allowed. Accepted values (passed
to `claude -p --permission-mode`): `acceptEdits | auto | bypassPermissions |
default | dontAsk | plan`.

Worktree isolation keeps the blast radius of `bypassPermissions` contained to a
single branch.

## Auto-spawn

Toggle per repo with the `a` key in the TUI. While on, a poller (default every
5 minutes, configurable via `pollIntervalSec`) looks for open issues with the
configured label (`agent-ready` by default) and spawns agents up to
`maxConcurrent`.

Press `p` in the TUI to force a poll cycle immediately (handy after labeling
an issue without waiting for the interval). The countdown in the header resets.

### Changing the autoSpawn label

The label is per repo. The active value shows up in the top bar as
`[auto:LABEL]` whenever autoSpawn is on. Change it via:

```bash
ygg repo set <name> --label my-custom-label
```

Or set it at add time with `ygg repo add --label NAME`. Editing
`~/.yggdrasil/config.json` directly also works (restart `ygg` afterward).

## Metrics

Each agent emits `agent_start`, `tool_use`, and `agent_end` events to
`~/.yggdrasil/metrics.ndjson`. Aggregate them with:

```bash
ygg metrics
ygg metrics --since 2026-05-01 --repo owner/project
ygg metrics --json | jq '.byRepo'
```

Output includes: total agents by status, tokens in/out, average duration,
breakdown by day, by repo, top issues by token spend, and a tool histogram.

### Rotation

To keep the user directory bounded:

- `metrics.ndjson` rotates when it grows past 5MB. Up to 5 archives are kept
  (`metrics.ndjson.1` … `metrics.ndjson.5`); `ygg metrics` reads across all of
  them so older history stays queryable.
- `~/.yggdrasil/logs/` is capped at 200 files. Each TUI startup prunes the
  oldest agent logs beyond that.

Both limits are conservative defaults — no configuration knob yet.

### Hydration recovery

On every TUI start, persisted agents are reconciled before render:

- Agents persisted as `running` or `queued` (the parent process is gone)
  become `failed` with a clear `errorMessage`.
- Agents in `awaiting-review` whose worktree was deleted off-disk between runs
  also become `failed`, so you never see a stale review pointer.

## Keybindings (TUI)

| Key       | Action |
|-----------|--------|
| `Tab`     | switch pane focus |
| `↑/↓`     | navigate list — scrolls the log when the log pane is focused |
| `←/→`     | navigate repos (when repos pane is focused) |
| `Enter`   | spawn agent on selected issue |
| `d`       | delete worktree of focused agent (confirms `y/n`) |
| `k`       | kill process of focused agent |
| `l`       | fullscreen log view |
| `PgUp`/`PgDn` | scroll log ±10 lines (in log pane) |
| `g` / `G` | jump to top (oldest) / tail-follow (newest) in the log pane |
| `f`       | cycle log filter: `all → no-thinking → tools → errors` |
| `a`       | toggle autoSpawn on focused repo |
| `p`       | force a poll cycle now |
| `+`/`-`   | adjust `maxConcurrent` (1–10) |
| `?`       | show keys & info help page |
| `q`       | quit (confirms if agents running) |
| `Ctrl+C`  | panic close (skips confirm, kills agents, restores screen) |

At spawn time the `SpawnModal` accepts `m` (mr), `r` (review), `d` (dry),
`Enter` (default), or `Esc` (cancel).

### Log filters

- `all` — every event except token counters
- `no-thinking` — hides `thinking…` and token counters
- `tools` — only `tool_use` and final `done` events
- `errors` — only failed `done` events and `system` lines mentioning
  `error`/`fail`/`stderr`/`denied`

Consecutive `thinking…` events collapse into a single line `thinking… ×N`.

## Agent status

- `queued` (gray) — waiting for a slot
- `running` (green) — `claude` in flight
- `awaiting-review` (yellow) — review mode, ready for inspection
- `done` (blue) — PR/MR created and comment posted
- `done-dry` (blue) — finished in dry mode
- `failed` / `killed` (red)

## Tests

```bash
bun test
```

Covers pure functions: config resolution, tool-brief formatter, summary
extraction, remote-URL parsing, metrics aggregation, retry heuristic, and
file/directory rotation.

## Known limitations

- `stream-json` schema may evolve; the parser ignores unknown events. Raw event
  output is preserved per agent under `~/.yggdrasil/logs/`.
- Retries are read-only (issue list/view, MR lookup). Write calls (comment,
  MR create) are still single-shot to avoid duplicating server-side effects.
