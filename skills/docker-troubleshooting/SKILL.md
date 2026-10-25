---
name: docker-troubleshooting
description: Diagnose why a Docker container or Compose service fails — exit codes, restart loops, healthchecks, port conflicts, DNS, permissions, disk pressure, build failures. Triage ladder from daemon health to app-level cause.
---

# Docker troubleshooting

Work down this ladder. Each step eliminates a whole class of causes; skipping to
the bottom is how agents end up editing application code for a permission problem.

## 1. Is it Docker itself?

```
docker_status
```

- Daemon unreachable → nothing else matters: start the daemon, fix group membership, set `DOCKER_HOST`.
- "no space left on device" appears in daemon warnings → go to [[step 7]](#7-disk-pressure).
- Compose plugin missing → every `docker_compose` call fails; say so rather than retrying.

## 2. What state is it in?

```
docker_ps all=true grep="myapp"
docker_inspect target="myapp" path="State"
```

Interpretation:

- **Up (unhealthy)** — healthcheck failing, process alive. Check the health command's exit code.
- **Restarting (1) X seconds ago** — crash loop. Logs from the *previous* instance are where the cause is:
  `docker_logs container="myapp" previous=true`.
- **Exited (137)** — OOM kill. Raise `--memory`, or the app's heap; check `docker_stats`.
- **Exited (1)/(2)** — app-level failure: missing env var, config parse, DB unreachable.
- **Created but never started** — `depends_on` wait, volume mount failure, or a manual `docker create`.

`State.Error` from `docker_inspect path="State.Error"` names the engine-level reason
(port already allocated, invalid mount spec).

## 3. Read the logs

```
docker_logs container="myapp" tail=300 timestamps=true
docker_logs container="myapp" since="10m" grep="error|fatal|panic"
```

Filtering happens client-side after capture — `tail` must be big enough to include the
interesting window, and `grep` narrows it.

## 4. Reconstruct the configuration actually in effect

The compose file is not the truth; the resolved config is.

```
docker_compose action="config"          # merged YAML: variable substitution, profiles
docker_inspect target="myapp" path="Config.Env"
docker_inspect target="myapp" path="Mounts"
docker_inspect target="myapp" path="NetworkSettings.Ports"
```

Classic findings: `DATABASE_URL=postgres://db` (not on this network), a bind mount
pointing at a relative path, or a port published on host `5432` already taken.

## 5. Test from inside the container's network

This distinguishes "app broken" from "networking broken".

```
docker_exec container="api" command=["sh","-lc","getent hosts db; nc -zv db 5432"]
docker_exec container="api" command=["sh","-lc","curl -sS -o /dev/null -w '%{http_code}' localhost:8080/health"]
```

- `getent hosts db` fails → wrong/absent network. Containers reach each other by
  **service name on a shared network**, never `localhost` (inside a container, `localhost`
  is that container).
- Curl to localhost succeeds but external fails → publish the port (`ports`).
- From the host, connect to published port, not the container IP.

## 6. Common failure signatures

| Symptom | Cause | Check |
|---|---|---|
| `port is already allocated` | another container/host process holds it | `docker_ps`, then stop the owner or remap |
| `connection refused` from host | app listens on `127.0.0.1` inside container | bind `0.0.0.0` in the app config |
| restart loop after config edit | bad YAML/env, healthcheck too strict | `docker_compose config`, healthcheck `start_period` |
| `permission denied` on bind mount | host UID ≠ container UID, SELinux | mount `:ro` where possible, match `--user`, `:z` on SELinux |
| file changes not reflected | stale image, not bind-mounted | `docker_build` again, or mount source |
| `exec: "sh": executable file not found` | distroless/scratch image | use argv form and a binary present in the image |
| `no configuration file provided` | wrong cwd for compose | pass `projectDir` or run from the project |
| container dies after start then restarts forever | app needs TTY/stdin | `docker_run` with proper `restart=no` to see the true exit |

## 7. Disk pressure

```
docker_cleanup action="report"
docker_cleanup action="plan"
docker_cleanup action="apply" confirm=true scopes=["build-cache","dangling-images"]
```

`report` shows the four reclaimable pools; `plan` enumerates what would actually be
removed. Build cache and dangling images are usually gigabytes and always safe to prune.
Volumes are excluded unless explicitly requested — pruning them destroys data.

## 8. Build failures

- `COPY failed: no such file` → file is excluded by `.dockerignore` or outside the context.
- `failed to solve: ... not found` → registry auth, wrong tag, or network egress.
- Cache invalidation every build → copy manifests before source files (see [[dockerfile]]).
- `--platform linux/amd64` builds are slow without QEMU; expect arm64 by default on Apple Silicon.

## Reporting

State what was verified, not just what is suspected: "container exited 137 (OOM),
`docker_stats` showed 512MiB cap with 520MiB usage" beats "probably a memory issue".
