# Provider Scheduler And Workspace Consistency

Sandbank treats `WorkspaceAdapter` as the durable source of truth for agent state. Sandbox providers are execution capsules. A provider may have a VM, container, Dynamic Worker, snapshot, volume, or terminal, but those resources are not the canonical state boundary.

## Execution Model

The scheduler added in `packages/sandbank/src/provider-scheduler.ts` uses this flow:

1. Take a workspace checkpoint when the backend supports checkpoints.
2. Select a provider whose declared scheduler capabilities satisfy the task.
3. Resolve the logical image through the provider image catalog.
4. Materialize the workspace into the sandbox for snapshot mounts.
5. Execute the task in the sandbox.
6. Sync or merge sandbox output back into the workspace.
7. Create an after-run checkpoint when supported.

This means a Dynamic Worker can generate Python into `/workspace/generated/task.py`, while the scheduler can dispatch that Python file to an E2B, Daytona, BoxLite, or other provider candidate that declares `runtime.python`.

## Preflight

`preflightWorkspaceSandboxTask()` checks whether the configured workspace and providers can support a task before the agent allocates its real execution sandbox.

The static preflight checks:

- workspace capabilities such as `checkpoint`, `lock`, `list`, `read`, `write`, and `remove`
- provider scheduler capabilities such as `runtime.python`, `runtime.codex`, `codex.exec`, `codex.goal`, `workspace.snapshot`, and `workspace.live`
- logical image resolution through the provider image catalog

`runWorkspaceSandboxTask()` runs this static preflight by default. Passing `preflight: { runtime: true }` creates a temporary sandbox and probes image-level tools before materializing the workspace. Python tasks probe `python`, `tar`, and `gzip`. Codex goal tasks probe `codex`, `git`, `tmux`, `bash`, `gh`, `tar`, and `gzip`.

## Consistency Modes

`exclusive-lock` is the default mode. It locks the workspace path for the whole sandbox run when the workspace backend supports locks. This serializes concurrent provider writes to the same path.

`branch-merge` snapshots the workspace files before execution, syncs sandbox output into `/.sandbank/provider-runs/<runId>/branch`, and then merges relative changes into the canonical workspace. If the sandbox and the canonical workspace both changed the same path from the same base, the merge records a conflict. Conflict resolution can be `fail`, `workspace`, `sandbox`, or `keep-both`.

`none` runs without a scheduler-level consistency protocol and should be used only for read-only tasks or provider-local experiments.

## Live Mounts

The scheduler exposes `mount.mode: "live"` as a capability-gated mode requiring `workspace.live`. A live mount is not the same thing as provider volumes. Provider volumes are provider-local persistence; the Workspace is provider-neutral persistence.

A provider can satisfy `workspace.live` by running a Sandbank workspace client, daemon, or filesystem bridge inside the sandbox image. Without that in-sandbox agent or a provider-native shared filesystem, Sandbank uses snapshot materialize/sync.

## Images

Developers should use logical images such as `python-agent` or `codex-agent`, then map them per provider with the image catalog. This lets the same task request a consistent runtime while each provider uses its own template, OCI image, or local image file.

A Codex-capable image should contain at least:

- `codex`
- `node`
- `git`
- `gh` when GitHub auth or clones are needed
- `bash`
- `tmux` for `codex.goal`
- `tar` and `gzip` for archive workspace sync

## Codex Modes

`codex.exec` runs non-interactive Codex in the sandbox with a prompt file under `/workspace/.sandbank/codex/`.

`codex.goal` starts a vas-style tmux session:

```sh
tmux new-session -d -s <session> -c /workspace 'codex --cd /workspace --no-alt-screen'
tmux send-keys -t <session> '/goal Read and follow this sandbox goal file exactly: <goal-file>' C-m
```

The goal sandbox is left alive so a terminal-capable provider can attach to the session and a later sync can merge its workspace changes.
