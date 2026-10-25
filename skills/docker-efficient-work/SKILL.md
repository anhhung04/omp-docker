---
name: docker-efficient-work
description: Working with Docker efficiently — fast builds, small images, cheap iteration loops and reduced token cost. Use when a build or feedback loop feels slow, images bloat, disk fills up, or you need to choose between rebuild vs restart vs exec.
---

# Working with Docker efficiently

Slow Docker loops are usually self-inflicted: full rebuilds for one-line changes, contexts
shipping the whole tree, or polling `docker ps` in a loop. This skill is the short path.

## Choose the cheapest action

Ask "what actually changed?" before doing anything:

| Changed | Do this | Not this |
|---|---|---|
| Source file only | Restart the container (`docker_container action="restart"`) if the image already has the code | rebuild |
| Running process config / need a probe | `docker_exec` inside the existing container | new container |
| Dockerfile or dependencies | `docker_build` with warm cache | `noCache=true` |
| Compose service definition | `docker_compose action="up" build=false` (recreate only) | full `down` + `up` |
| Everything / unknown drift | `docker_compose action="up" build=true` | — |
| Nothing works anymore | `docker_compose action="down" confirm=true` then `up` | deleting volumes |

`--no-cache` costs minutes and should be reserved for suspected cache poisoning.

## Keep builds fast

1. **`.dockerignore` first** — excluding `.git`, `node_modules`, `dist` and secrets usually
   cuts context transfer from hundreds of MB to a few KB. This is the single biggest win.
2. **Copy manifests before source** so dependency layers cache across code edits.
3. **Multi-stage builds** keep compilers out of the runtime image.
4. **Pin the narrowest `context`** — building from `.` when only `services/api/` matters
   sends the whole tree to the daemon.
5. Reuse layers across branches with consistent build args; each new `ARG` value forks the cache.

Measure before optimizing: `docker_images` shows sizes; a build that finishes with no
`#N CACHED` lines had no cache hits.

## Keep iterations cheap

- **One-off commands beat scratch containers**: `docker_run image=... rm=true detach=false`
  leaves nothing behind.
- **Detach, then verify** rather than blocking: `docker_run` detached → `docker_logs since="15s"`.
- **Extract fields, don't dump JSON**: `docker_inspect target="api" path="State.ExitCode"`
  costs a line instead of 8k tokens.
- **Bound every read**: `docker_logs tail=100 grep="error"` before asking for everything.
- **Batch independent checks** in one turn instead of serializing round trips.
- Use `docker_cp` to pull a file out for inspection instead of `exec`-ing a pager.

## Keep disk under control

```
docker_cleanup action="report"     # what is big?
docker_cleanup action="plan"       # what would actually be removed
docker_cleanup action="apply" confirm=true scopes=["build-cache","dangling-images","stopped-containers"]
```

Build cache and dangling images are usually gigabytes and always safe. Volumes hold real
data and stay out of scope unless explicitly requested. Schedule prune rather than letting
"no space left on device" interrupt a build.

## Compose-specific speed

- `docker_compose action="config"` before `up` — catches template and volume mistakes in
  milliseconds instead of at container start.
- Mount source as a bind volume for dev (`./src:/app/src`) and rely on the app's hot reload;
  reserve rebuilds for dependency changes.
- `depends_on` with healthchecks replaces sleep-based startup races (and flaky first failures).
- Use profiles to avoid starting services nobody needs for the current task.

## Diagnostics without thrashing

Order matters — cheapest and most informative first:

1. `docker_status` (daemon OK?) — rules out the entire infrastructure class.
2. `docker_ps all=true` with `grep` — state + exit code tells you most of the story.
3. `docker_logs since="5m" grep="error|fatal"` — bounded and filtered.
4. `docker_inspect path=...` — the one field that decides next steps.
5. `docker_exec` — only when you need the container's own view.

See [[docker-troubleshooting]] for symptom tables, [[dockerfile]] for build mechanics,
[[docker]] for tool selection, [[docker-swarm]] for clusters, [[docker-sandbox]] for
running agents in isolated microVMs.

## Anti-patterns that waste the most time

- Rebuilding the image to change an env var — restart with new `-e` instead.
- `docker_compose down -v` to "reset" a service — that deletes data; recreate containers instead.
- Ignoring exit codes: `137` is memory, `139` is a segfault, `1` is app-level. Read them.
- Blind `docker system prune -a` — removes images you may want; prune scoped, after a `plan`.
- Assuming `up` succeeded because the command returned 0: verify with `ps` + `logs`.
