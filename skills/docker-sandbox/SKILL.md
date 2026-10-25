---
name: docker-sandbox
description: Run AI coding agents inside Docker Sandboxes — isolated microVMs with workspace mounts, credential proxying and network governance. Use when delegating risky/untrusted agent work, keeping API keys out of reach, or giving an agent its own throwaway Docker daemon.
---

# Docker Sandboxes for agents

A Docker Sandbox is a **persisted microVM** that runs a coding agent (`claude`, `codex`,
`gemini`, `kiro`, `copilot`) with the repo mounted, network egress governed by policy,
and its own rootless Docker daemon. Use it when the task is risky, long, untrusted, or
simply deserves isolation from your host and credentials.

## Why bother

- **Credentials never reach the agent.** A host-side proxy injects real API keys at
  request time, so the sandbox has no key material and anything it leaks is useless.
- **Blast radius is a VM.** Root/Docker inside the sandbox is not root on your machine.
- **Network governance.** Unexpected outbound hosts are blocked and logged; you can
  review what an agent contacted.
- **State survives turns.** Stopping and reattaching keeps installed packages, history
  and files — so long tasks can be resumed instead of redone.

## Tool map

| Need | Tool call |
|---|---|
| Start an agent on this repo, in background | `docker_sandbox action="run" agent="claude" detach=true name="my-task"` |
| Start interactive (attach) | `docker_sandbox action="run" agent="claude" workspaces=["."]` |
| Create without attaching | `docker_sandbox action="create" agent="claude" name="task" workspaces=["."]` |
| Run a command inside it | `docker_sandbox action="exec" sandbox="task" command=["git","status"]` |
| See what is running | `docker_sandbox action="ls"` |
| Follow output | `docker_sandbox action="logs" sandbox="task" lines=200` |
| Reach a dev server | `docker_sandbox action="ports" sandbox="task" publish=["8080:3000"]` |
| Move files in/out | `docker_sandbox action="cp" source=... destination=...` |
| Destroy it | `docker_sandbox action="rm" sandbox="task" confirm=true` |

## Delegation pattern (the reason this exists)

```
docker_sandbox action="run" agent="claude" name="refactor-api" detach=true removeOnExit=false workspaces=["."]
docker_sandbox action="logs" sandbox="refactor-api" lines=100        # poll progress
docker_sandbox action="exec" sandbox="refactor-api" command=["git","-C","/workspace","diff","--stat"]
docker_sandbox action="rm" sandbox="refactor-api" confirm=true       # when done
```

Detached is the right default: agents must not block waiting on another agent. Give every
sandbox a `name` — without one you cannot `exec`, `logs` or `cp` into it later.

## Workspace modes

- **Mounted (default)** — the repo is bind-mounted read-write; edits land on your host
  immediately. Best when you intend to keep the result.
- **Clone (`clone=true`)** — the sandbox gets its own git clone; your host repo is also
  available read-only. Best for exploratory work you may throw away: fetch or push the
  branch you want before removing the sandbox, because removal drops the clone.

Extras can be read-only: `workspaces=["./app", "../shared-libs:ro"]`. The first path is
primary — the agent starts there and `exec` defaults its working directory to it.

## Choosing a template

Templates are images that preinstall toolchains. Pass `template="my-template:tag"` to pin
one, otherwise the agent's default is used. Save a well-configured sandbox as a template
with `sbx template save` (via `docker_sandbox action="templates"` to review what exists) —
note that this captures container filesystems, so remove any secrets before saving.

## Rules that prevent damage

- **Never `rm` without checking what's inside.** Removal deletes installed packages,
  history and any clone-mode work — it is irreversible. Always `exec` a `git status`/
  `git log` or copy artifacts out first.
- **Sandbox removal needs `confirm=true`** — say what will be lost before asking.
- **Don't put secrets in `-e` or in files.** Use the credential path (`sbx secret set`)
  so the proxy injects them; env vars and template layers are readable inside the VM.
- **Publish ports deliberately.** Sandboxes are network-isolated on purpose; only expose
  what you actually need to reach.
- **Treat the agent's Docker daemon as disposable.** Anything it builds disappears with
  the sandbox unless committed to an image.
- **Missing CLI?** If `sbx` is not installed, every action fails with install guidance.
  Set `DOCKER_SANDBOX_BIN` to point at whatever runs it on that host.

## When NOT to sandbox

Quick, trusted, host-local edits — the overhead is not worth it. Sandboxes pay off when
the agent gets destructive permissions, needs to install things freely, or handles code
you would rather not have executed on your machine.
