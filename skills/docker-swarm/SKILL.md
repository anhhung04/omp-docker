---
name: docker-swarm
description: Run Docker Swarm clusters — services, stacks, nodes, overlay networks, secrets/configs, rolling updates and rollbacks. Use for multi-host deployments, scaling services, diagnosing task placement failures, or the first run against a swarm manager.
---

# Docker Swarm orchestration

Swarm turns the same Docker daemon you already use into a cluster scheduler. Reach
for it when a workload must run across more than one host — or when you want
declarative replicas, rolling updates and built-in rollback without Kubernetes.

## Tool map

| Need | Tool |
|---|---|
| Is this node even in a swarm? manager or worker? join tokens | `docker_swarm` `action="status"` |
| Create/join a swarm | `docker_swarm` `action="init"`, `action="join"` |
| Cluster membership: nodes, availability, roles | `docker_node` |
| Deploy/remove a compose-defined stack | `docker_stack` `action="deploy"`, `action="rm"` |
| One-off or imperative service | `docker_service` |
| Where are my tasks running / failing? | `docker_service` `action="ps"`, `docker_stack` `action="ps"` |
| Roll out new image, roll back bad release | `docker_service` `action="update"`, `action="rollback"` |

## Mental model (what actually differs from plain containers)

- **Service, not container.** You declare desired state (`--replicas 3`); the manager
  reconciles it. Never inspect "the container" — inspect the **task**
  (`docker_service action="ps"`), then `docker_inspect type="container"` on that task's container.
- **Overlay networks** span nodes; attach services with `--network`. `docker_network`
  only shows node-local networks plus overlays known to this node.
- **Published ports** with `-p 8080:80` land on an ingress routing mesh, so every node
  answers on 8080 — there is no "which node" to find. Use `--publish published=8080,target=80,mode=host`
  when you need host-mode pinning.
- **Secrets/configs** are cluster objects mounted at `/run/secrets/<name>` and
  `/<config-name>`. They are immutable; changing one means creating a new object and
  updating the service.
- **Placement**: `--constraint node.role==worker`, `--constraint node.labels.ssd==true`,
  `--placement-pref spread=node.labels.az`.

## First run against a fresh cluster

```
docker_swarm action="status"                       # active manager? swarm id? node role?
docker_node action="ls"                            # managers/workers, availability, engine version
docker_stack action="deploy" composeFile=["compose.yml"] stack="myapp" withRegistryAuth=true
docker_stack action="services" stack="myapp"
docker_service action="ps" service="myapp_web"     # per-task node + current/desired state
docker_service action="logs" service="myapp_web" tail=100
```

`withRegistryAuth=true` (`--with-registry-auth`) matters the moment images are private:
without it workers pull anonymously and tasks fail with "pull access denied".

## Deploying without a compose file

```
docker_service action="create" \
  name="api" image="registry/api:1.2.3" replicas=3 publish=["8080:8080"] \
  network=["appnet"] env=["LOG_LEVEL=info"] limitMemory=536870912 \
  updateDelay="10s" updateParallelism=1 updateFailureAction="pause" \
  withRegistryAuth=true healthCmd="curl -f http://localhost:8080/health"
```

## Rolling update and rollback

```
docker_service action="update" service="api" image="registry/api:1.2.4"
docker_service action="ps" service="api"             # watch tasks replace
docker_service action="rollback" service="api"       # revert to previous spec if bad
docker_service action="update" service="api" force=true   # force reschedule stuck tasks
```

Set the policy at create time so updates behave: `updateParallelism`, `updateDelay`,
`updateFailureAction` (`pause` is the safe default — failed rollouts then stop instead
of thrashing), `updateMonitor`, `updateOrder`.

## Diagnosing swarm failures

| Symptom | Likely cause | Check |
|---|---|---|
| task "Rejected"/no suitable node | constraint unmatched, resource reservation too big | `docker_service action="ps"`, then `docker_node action="ls"` for labels/roles |
| task "Assigned" forever | worker can't reach manager, or can't pull image | `docker_service action="logs"`, `docker_node action="inspect"` |
| `pull access denied` on workers | missing `--with-registry-auth` | redeploy with `withRegistryAuth=true` |
| service unreachable though tasks are running | overlay network not attached, or published port typo | `docker_service action="inspect" path="Endpoint"` |
| new replicas never become healthy | healthcheck too aggressive, missing `startPeriod` | health params on create/update |
| service stuck after bad deploy | update failure action | `docker_service action="ps"`, then `rollback` |
| manager unavailable / quorum lost | too few managers (need odd count ≥3) | `docker_node action="ls"`, `docker_node action="promote"` |

## Cluster hygiene

- Manager count must be **odd** (1, 3, 5) for raft quorum; never rely on 2.
- Drain before maintenance: `docker_node action="update" node="worker-2" availability="drain"`
  — then set it back to `active` when done.
- Scale with `docker_service action="scale" service="api" replicas=5` (or compose `replicas`
  + redeploy) rather than creating duplicate services.
- Removing a node from the cluster (`docker_node action="rm"`) should follow a drain, and
  only after confirming the workload rescheduled.
- Removing a stack or service needs `confirm=true` — say what will disappear first.
