# omp-docker

Native Docker tools and skills for [OMP](https://omp.sh) agents. The agent gets
first-class `docker_*` tools instead of improvising shell commands: compact output,
capped logs, approval tiers, and destructive operations gated behind `confirm`.

## What it adds

**Tools** (LLM-callable)

| Tool | Purpose |
|---|---|
| `docker_status` | Daemon reachability, versions, container counts, disk usage, actionable diagnostics |
| `docker_ps` | List containers with state/status/ports, filters and regex grep |
| `docker_logs` | Container logs with tail, time windows, timestamps, previous-instance logs, grep |
| `docker_inspect` | Full JSON or a single field via a dotted path (`State.ExitCode`) |
| `docker_run` | Create/start a container — ports, mounts, env, limits; detached by default |
| `docker_exec` | Run a command inside a running container (argv array or `sh -lc`) |
| `docker_container` | start / stop / restart / pause / kill / rm existing containers |
| `docker_compose` | `ps`, `config`, `up`, `down`, `start`, `stop`, `restart`, `build`, `pull`, `logs`, `exec`, `run`, `rm` |
| `docker_build` | Build and tag an image: build args, target stage, platform, no-cache |
| `docker_images` | List local images with size, age and filters |
| `docker_cp` | Copy files between host and container (`container:/path`) |
| `docker_stats` | One-shot CPU/memory/network/block I/O per container |
| `docker_network` | ls, inspect, create, rm, connect/disconnect, prune (with dry run) |
| `docker_volume` | ls, inspect, create, rm, prune |
| `docker_cleanup` | `report` → `plan` → `apply` disk reclaim, volumes opt-in |
| `docker_swarm` | Swarm cluster lifecycle: `status`, `init`, `join`, `join-token`, `leave`, `update` |
| `docker_node` | Swarm nodes: `ls`, `inspect`, `ps`, `update` (drain/labels/role), `promote`, `demote`, `rm` |
| `docker_service` | Swarm services: `ls`, `ps` (tasks), `inspect`, `logs`, `create`, `update`, `scale`, `rollback`, `rm` |
| `docker_stack` | Swarm stacks from compose files: `ls`, `ps`, `services`, `config`, `deploy`, `rm` |
| `docker_sandbox` | Docker Sandboxes for agents (`sbx`): `ls`, `run`, `create`, `exec`, `cp`, `logs`, `ports`, `stop`, `rm`, `prune`, `templates` |

**Skills**

| Skill | When the agent should reach for it |
|---|---|
| `docker` | Any Docker work: tool selection, lifecycle, compose, exit codes, safety rules |
| `docker-troubleshooting` | "It's not working" — triage ladder from daemon health to app cause |
| `dockerfile` | Writing/improving Dockerfiles, caching, non-root, healthchecks, small images |
| `docker-swarm` | Running a Swarm cluster: services vs tasks, rolling updates, rollback, placement, quorum |
| `docker-sandbox` | Delegating agent work into isolated microVMs; credentials, network policy, cleanup |
| `docker-efficient-work` | Cheapest-action tables, fast builds, cheap iteration loops, disk hygiene |

## Install

```bash
omp plugin install github:anhhung04/omp-docker
```

or link a local checkout for development:

```bash
omp plugin link /path/to/omp-docker
```

## Prerequisites

- Docker CLI on `PATH` (or set `DOCKER_BIN`, e.g. `DOCKER_BIN="sudo docker"`).
- For `docker_sandbox`: the [`sbx`](https://docs.docker.com/ai/sandboxes/) CLI
  (Docker Desktop 4.58+; the older `docker sandbox` form is deprecated). Override the
  binary with `DOCKER_SANDBOX_BIN`, e.g. `DOCKER_SANDBOX_BIN="docker sandbox"`. Missing
  binaries produce install guidance instead of a stack trace.
- Swarm tools need a manager for most operations; `docker_swarm action="status"` is the
  safe first call and works on any node.
- Access to the daemon socket — either group membership (`docker`) or `$DOCKER_HOST`.
  Every tool honours `$DOCKER_HOST`, so remote daemons work.
- The Compose plugin (`docker compose`) must be installed for `docker_compose`;
  `docker_status` reports whether it is present.

## Usage

Ask the agent:

- "is the API container healthy? why did it restart?"
- "bring up the compose stack in ./infra and show me the logs"
- "build this Dockerfile as myapp:dev and check the image size"
- "free up Docker disk space — tell me what you'd delete first"
- "copy /var/log/app.log out of the worker container so I can inspect it"
- "write a multi-stage Dockerfile for this Go service and verify it runs"
- "deploy this compose file as a swarm stack across the cluster, then show task placement"
- "roll back the api service — the new image is crashing"
- "run claude on this repo inside a sandbox and check what it changed"

## Design notes

- **CLI, not Engine API.** Tools shell out to the Docker CLI so contexts, credential
  helpers, the Compose plugin and version differences are the CLI's problem.
- **Output discipline.** Large JSON is replaced by `path` extraction; logs are capped
  (default 16k chars, tail-first for builds) so a runaway container can't flood context.
- **Approval tiers.** Reads are `read`; exec/build/compose are `exec`; deletions and
  prunes are `write` and additionally require `confirm=true`, except volume/network
  pruning which also demands an explicit scope.
- **No implicit destruction.** `docker_cleanup` defaults to `report`; `apply` refuses
  without `confirm`. Compose `down` and volume `rm` refuse without `confirm`.

## Development

```bash
bun install
bun run typecheck          # tsc --noEmit
bun test                   # unit tests for helpers
bun run test/smoke.ts      # live run of every tool against your daemon
```

`test/smoke.ts` exercises all 15 tools against the real Docker daemon. It reads the
current cwd, so run it from a directory with containers/compose files for richer output.

## Safety

**Swarm and sandbox notes**

- `docker_swarm action="status"` is always safe and tells you whether you are a manager;
  most swarm failures are really "this node isn't a manager", which the tools state plainly.
- Cluster-mutating actions (`node promote/demote/rm`, `swarm leave/update`, `service rm`,
  `stack rm`) require `confirm=true`. Sandboxes are destroyed on `rm` — everything inside
  them is lost, so check `git status` or copy artifacts out first.

Tools perform real operations (`rm`, `prune`, `down`, `exec` with arbitrary commands)
behind OMP's normal approval flow. Only authorize against infrastructure you own, and
prefer `docker_cleanup action="plan"` before `apply`.

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)
— free for noncommercial, educational and research use; commercial use requires a
separate license. See [LICENSE](LICENSE).
