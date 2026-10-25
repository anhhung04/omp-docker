---
name: dockerfile
description: Write, review and fix Dockerfiles and image builds — multi-stage builds, layer caching, non-root users, healthchecks, signal handling, .dockerignore, build args. Use when authoring images or diagnosing slow/oversized builds.
---

# Dockerfile authoring and image builds

## Skeleton that stays small and cacheable

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./      # manifests first: lockfile layer caches
RUN npm ci --omit=dev

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app    # non-root
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --start-period=10s CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "dist/server.js"]
```

Rules encoded above:

1. **Manifests before source.** Least-frequently-changed files first, so a code edit
   does not invalidate dependency layers.
2. **Multi-stage.** Compilers and dev deps stay in build stages; the runtime image ships
   only artifacts.
3. **Non-root `USER`.** Add the user in the runtime stage; don't leave root.
4. **Exec-form `CMD`** (`["node", ...]`) — PID 1 gets signals directly. Shell form
   creates a shell that swallows SIGTERM, causing slow, then 137-killed, shutdowns.
5. **`HEALTHCHECK`** makes `docker_ps`/`docker_compose ps` able to show health instead of
   guessing from "Up". Use `start_period` so slow starts aren't marked unhealthy.

## Per-stack notes

- **Go**: `FROM golang:1.23-alpine AS build` → `COPY --from=build /app/app /app` into
  `gcr.io/distroless/static` or `scratch`. Static binary, ~10MB image. Note: no shell in
  scratch, so `docker_exec` must use argv form with a binary that exists.
- **Python**: copy `requirements.txt`/`pyproject.toml` first, `pip install --no-cache-dir`,
  prefer `-slim` base; use a venv stage to avoid polluting site-packages.
- **Node**: `npm ci` (not `install`), prune dev deps, don't copy `.git`/`node_modules` —
  add them to `.dockerignore`.
- **Static frontends**: build in node, serve from `nginx:alpine` with only the built assets.

## Build args vs secrets

- Build args (`ARG`) are **baked into image history** — never pass credentials.
- For secrets use `RUN --mount=type=secret,id=...` (BuildKit) or mount at runtime.
- Pin base images by digest for reproducible builds: `FROM node:20-alpine@sha256:...`.

## .dockerignore

```
.git
node_modules
dist
**/*.log
.env
.DS_Store
```

Without it every build ships the entire working tree to the daemon — the single most
common cause of slow builds and accidentally baked-in secrets.

## Reducing image size and build time

- Combine `RUN` steps that belong together (`apt-get update && apt-get install -y ... && rm -rf /var/lib/apt/lists/*`) — each `RUN` is a layer.
- `--platform` only when targeting another arch; cross-arch builds need QEMU and are slow.
- Clean package manager caches in the same layer that created them (deleting them later only hides bytes).
- Check the result: `docker_images reference="myapp"` shows size; compare before/after.

## Verifying a build

```
docker_build context="." dockerfile="Dockerfile" tag=["myapp:dev"] noCache=false
docker_images reference="myapp"
docker_run image="myapp:dev" name="myapp-check" detach=true ports=["8080:8080"] rm=true
docker_logs container="myapp-check" since="30s"
docker_exec container="myapp-check" command=["sh","-lc","id; ls /app"]   # confirms non-root + layout
```

Then `docker_compose action="up" build=true` if the service participates in a stack.

## Review checklist

- [ ] Base image is slim/pinned; no `latest` for anything that ships
- [ ] Manifests copied before source; `.dockerignore` present
- [ ] Multi-stage; build-only deps not in runtime image
- [ ] Non-root `USER`; no world-writable app dir
- [ ] `CMD` in exec form; app handles SIGTERM (use `--init` or tini if it spawns children)
- [ ] Healthcheck defined for long-running services
- [ ] No secrets in `ARG`/`ENV`/layers; config injected via env at run time
- [ ] Image size reviewed with `docker_images`
