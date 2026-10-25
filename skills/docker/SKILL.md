---
name: docker
description: Use for Docker work — container lifecycle, logs, exec, builds, Compose projects, ports, volumes, networking. Pick the right docker_* tool, apply safe defaults (detached runs, confirm before deletion), and avoid common Docker mistakes.
---

# Docker for agents

The agent has first-class `docker_*` tools. Prefer them over shelling out to `docker`:
they return compact tables, cap output, and classify destructive calls for approval.

## Tool selection

| Need | Tool |
|---|---|
| Is the daemon reachable? versions, disk | `docker_status` |
| What is running? find a name/ID | `docker_ps` (add `all=true`) |
| Why did it crash? | `docker_logs` (then `docker_inspect` → `State.*`) |
| One field from the JSON | `docker_inspect` with `path` (e.g. `State.ExitCode`) |
| Run a command inside a container | `docker_exec` (argv array; `shell=true` for pipes) |
| Run a one-off container | `docker_run` `detach=false` `rm=true` |
| Start a long-running service | `docker_run` (detached, name it) |
| Build an image | `docker_build` |
| What images are local? | `docker_images` |
| Compose project | `docker_compose` (`ps`, `config`, `up`, `logs`, `down`) |
| Start/stop/remove existing container | `docker_container` |
| Copy files in/out | `docker_cp` |
| CPU/mem right now | `docker_stats` |
| Networks / volumes | `docker_network`, `docker_volume` |
| Disk pressure | `docker_cleanup` (`report` → `plan` → `apply`) |

## Workflow: "app isn't working"

1. `docker_status` — rule out a daemon-level problem first (this is often the real cause).
2. `docker_ps` with `all=true` — `exit 137` = OOM-kill, `exit 1/2` = app error, restarting loop = config crash.
3. `docker_logs` with `tail=200`, add `grep` for the error class.
4. `docker_inspect` with `path` for specifics: `State.ExitCode`, `State.Error`, `Config.Env`, `Mounts`, `NetworkSettings.Ports`.
5. `docker_exec` to test from inside: `["sh","-lc","curl -sS localhost:8080/health"]`.
6. Still stuck → [[docker-troubleshooting]].

## Workflow: bring up a stack

```
docker_status
docker_compose action="config"                        # validate before starting
docker_compose action="up" detach=true build=true
docker_compose action="ps"                            # health column per service
docker_compose action="logs" services=["api"] tail=100
```

Single service instead of compose:

```
docker_run image="postgres:16" name="pg-dev" env=["POSTGRES_PASSWORD=dev"] ports=["5432:5432"] detach=true
docker_logs container="pg-dev" since="30s"
```

One-off command (no container left behind):

```
docker_run image="alpine:3.20" command=["printenv"] rm=true detach=false
```

## Rules that prevent damage

- **Never guess container names.** `docker_ps` first; compose names are `project-service-N`.
- **Deletion needs `confirm=true`** — `docker_cleanup apply`, `docker_compose down`, `docker_volume rm`, `docker_network prune`. Report what will disappear *before* asking.
- **Volumes hold data.** Pruning an unused volume deletes databases. Only include them when scope explicitly asks.
- **`--rm` + named container conflict** — don't set both `rm` and `name` expecting reuse.
- **Detached by default**: `docker_run`/`docker_compose up` return immediately; verify with `docker_ps`/`docker_logs`, don't assume success from exit 0.
- **Publishing ports**: `"8080:80"` binds all interfaces; use `"127.0.0.1:8080:80"` to keep it local.
- **Env is `KEY=VALUE` strings**, passed as an array — no shell quoting involved.
- **Build context size**: pass the narrowest `context`; huge contexts make every build slow.

## Exit codes worth knowing

| Code | Meaning |
|---|---|
| 0 | clean exit |
| 1 | application error — read logs |
| 125 | `docker run` itself failed (bad flag, port in use) |
| 126/127 | command not found / not executable in the image |
| 137 | SIGKILL — almost always memory limit (raise `--memory` or fix the leak) |
| 139 | segfault |
| 143 | SIGTERM — graceful stop or `docker stop` |

## See also

- [[docker-troubleshooting]] for diagnosis recipes by symptom
- [[dockerfile]] for writing and building images
