import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import {
  clamp,
  commandResult,
  fail,
  getPath,
  keyValueArgs,
  ok,
  parseJsonLines,
  requireConfirm,
  runDocker,
  swarmFailure,
  table,
} from "./_docker";

interface ServiceRow {
  ID: string;
  Name: string;
  Mode: string;
  Replicas: string;
  Image: string;
  Ports: string;
}

interface TaskRow {
  ID: string;
  Name: string;
  Image: string;
  Node: string;
  DesiredState: string;
  CurrentState: string;
  Error: string;
  Ports: string;
}

/**
 * Swarm services: desired-state workloads reconciled by the manager.
 *
 * Requires a swarm manager; when this node is only a worker (or not in a swarm)
 * every action fails, so the diagnostic names the concrete next step instead of
 * echoing the raw daemon error.
 */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_service",
  label: "Swarm Service",
  description:
    "Manage Docker Swarm services. Actions: ls, ps (tasks with node + desired/current state), inspect, logs, create, update, scale, rm, rollback. " +
    "Use for multi-host deployments: services are desired state the manager reconciles across nodes, unlike docker_container which is node-local. " +
    "`rm` requires confirm=true. Reading 'Rejected'/'Assigned' task states here is how placement and image-pull failures are diagnosed.",
  approval: (args) => {
    // The harness passes parsed params but the callback type is `unknown`.
    const action = typeof args === "object" && args !== null && "action" in args
      ? (args as { action?: string }).action
      : undefined;
    if (action === "create" || action === "update" || action === "rollback" || action === "scale") {
      return { tier: "exec", reason: `docker service ${action} changes cluster workload` };
    }
    if (action === "rm") {
      return { tier: "write", reason: "Removing a service stops and deletes all of its tasks" };
    }
    return "read";
  },
  parameters: pi.zod.object({
    action: pi.zod
      .enum(["ls", "ps", "inspect", "logs", "create", "update", "scale", "rm", "rollback"])
      .describe("Service operation"),
    service: pi.zod.string().optional().describe("Service name or ID (required except ls)"),
    name: pi.zod.string().optional().describe("For create: service name"),
    image: pi.zod.string().optional().describe("For create/update: image reference"),
    command: pi.zod.array(pi.zod.string()).optional().describe("For create/update: command overriding the image CMD"),
    replicas: pi.zod.number().optional().describe("For create/scale/update: replica count"),
    mode: pi.zod.enum(["replicated", "global", "replicated-job", "global-job"]).optional().describe("For create: service mode"),
    env: pi.zod.array(pi.zod.string()).optional().describe("For create: env KEY=VALUE; for update: entries to add"),
    envRemove: pi.zod.array(pi.zod.string()).optional().describe("For update: env keys to remove"),
    labels: pi.zod.array(pi.zod.string()).optional().describe("For create/update: service labels KEY=VALUE"),
    publish: pi.zod
      .array(pi.zod.string())
      .optional()
      .describe("Published ports, e.g. '8080:80' (routing mesh) or 'published=8080,target=80,mode=host'"),
    publishRemove: pi.zod.array(pi.zod.string()).optional().describe("For update: published ports to remove"),
    network: pi.zod.array(pi.zod.string()).optional().describe("Overlay networks to attach"),
    networkRemove: pi.zod.array(pi.zod.string()).optional().describe("For update: networks to detach"),
    mount: pi.zod.array(pi.zod.string()).optional().describe("Mounts: 'type=volume,src=pgdata,dst=/var/lib/postgresql/data'"),
    constraint: pi.zod.array(pi.zod.string()).optional().describe("Placement constraints, e.g. 'node.role==worker', 'node.labels.ssd==true'"),
    secret: pi.zod.array(pi.zod.string()).optional().describe("Secrets to expose at /run/secrets/<name>"),
    configs: pi.zod.array(pi.zod.string()).optional().describe("Configs to expose in the task"),
    limitCpu: pi.zod.string().optional().describe("CPU limit per task, e.g. '0.5'"),
    limitMemory: pi.zod.number().optional().describe("Memory limit per task in bytes"),
    reserveCpu: pi.zod.string().optional().describe("Reserved CPU per task (placement accounting)"),
    reserveMemory: pi.zod.number().optional().describe("Reserved memory per task in bytes (placement accounting)"),
    restartCondition: pi.zod.enum(["none", "on-failure", "any"]).optional().describe("Restart condition"),
    restartDelay: pi.zod.string().optional().describe("Restart delay, e.g. '5s'"),
    restartMaxAttempts: pi.zod.number().optional().describe("Restart attempts before giving up"),
    updateParallelism: pi.zod.number().optional().describe("Tasks updated simultaneously"),
    updateDelay: pi.zod.string().optional().describe("Delay between task updates, e.g. '10s'"),
    updateFailureAction: pi.zod.enum(["pause", "continue", "rollback"]).optional().describe("Behaviour on update failure ('pause' is the safe default)"),
    updateOrder: pi.zod.enum(["start-first", "stop-first"]).optional().describe("Update ordering"),
    healthCmd: pi.zod.string().optional().describe("Healthcheck command"),
    healthInterval: pi.zod.string().optional().describe("Healthcheck interval, e.g. '30s'"),
    healthRetries: pi.zod.number().optional().describe("Consecutive healthcheck failures before unhealthy"),
    healthStartPeriod: pi.zod.string().optional().describe("Grace period before healthchecks count, e.g. '30s'"),
    user: pi.zod.string().optional().describe("User or uid[:gid] for tasks"),
    withRegistryAuth: pi.zod
      .boolean()
      .optional()
      .describe("Send registry auth so workers can pull private images (needed for private registries)"),
    force: pi.zod.boolean().optional().describe("For update: force tasks to restart even if the spec is unchanged"),
    detached: pi.zod.boolean().optional().describe("Do not wait for convergence (create/update -d)"),
    tail: pi.zod.number().optional().describe("For logs: trailing lines (default 200)"),
    since: pi.zod.string().optional().describe("For logs: time window start"),
    timestamps: pi.zod.boolean().optional().describe("For logs: prefix timestamps"),
    filter: pi.zod.string().optional().describe("Docker filter expression for ls/ps"),
    path: pi.zod.string().optional().describe("For inspect: dotted path, e.g. 'Endpoint.Ports' or 'Spec.TaskTemplate.ContainerSpec.Image'"),
    confirm: pi.zod.boolean().optional().describe("Required for rm"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const {
      action,
      service,
      name,
      image,
      command,
      replicas,
      mode,
      env,
      envRemove,
      labels,
      publish,
      publishRemove,
      network,
      networkRemove,
      mount,
      constraint,
      secret,
      configs,
      limitCpu,
      limitMemory,
      reserveCpu,
      reserveMemory,
      restartCondition,
      restartDelay,
      restartMaxAttempts,
      updateParallelism,
      updateDelay,
      updateFailureAction,
      updateOrder,
      healthCmd,
      healthInterval,
      healthRetries,
      healthStartPeriod,
      user,
      withRegistryAuth,
      force,
      detached,
      tail,
      since,
      timestamps,
      filter,
      path,
      confirm,
    } = params;

    if (action === "rm") {
      const refusal = requireConfirm(confirm, `remove service ${service ?? "(unspecified)"}`);
      if (refusal) return refusal;
    }
    // create names the service via `name`, everything else targets an existing one.
    if (action !== "ls" && action !== "create" && !service) {
      return fail(`action '${action}' requires 'service'`);
    }

    switch (action) {
      case "ls": {
        const args = ["service", "ls", "--format", "{{json .}}"];
        if (filter) args.push("--filter", filter);
        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 60_000 });
        if (res.code !== 0) return swarmFailure("docker service ls", res);
        const rows = parseJsonLines<ServiceRow>(res.stdout);
        if (rows.length === 0) return ok("No services in this swarm.", { count: 0 });
        return ok(
          table(
            ["NAME", "MODE", "REPLICAS", "IMAGE", "PORTS"],
            rows.map((row) => [row.Name, row.Mode, row.Replicas, row.Image, row.Ports || "-"]),
            { maxColumnWidth: 44 },
          ),
          {
            count: rows.length,
            services: rows.map((row) => ({
              id: row.ID,
              name: row.Name,
              mode: row.Mode,
              replicas: row.Replicas,
              image: row.Image,
            })),
          },
        );
      }

      case "ps": {
        const args = ["service", "ps", "--format", "{{json .}}", "--no-trunc"];
        if (filter) args.push("--filter", filter);
        args.push(service!);
        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 60_000 });
        if (res.code !== 0) return swarmFailure(`docker service ps ${service}`, res);
        const rows = parseJsonLines<TaskRow>(res.stdout);
        if (rows.length === 0) return ok(`No tasks for ${service}.`, { count: 0 });
        const body = table(
          ["TASK", "NODE", "DESIRED", "CURRENT", "ERROR"],
          rows.map((row) => [row.Name, row.Node, row.DesiredState, row.CurrentState, row.Error || "-"]),
          { maxColumnWidth: 46 },
        );
        const errors = rows.filter((row) => row.Error);
        return ok(
          `${errors.length > 0 ? `${errors.length} task(s) reporting errors — see ERROR column.\n\n` : ""}${body}`,
          {
            count: rows.length,
            tasks: rows.map((row) => ({
              id: row.ID,
              name: row.Name,
              node: row.Node,
              desiredState: row.DesiredState,
              currentState: row.CurrentState,
              error: row.Error || undefined,
            })),
          },
        );
      }

      case "inspect": {
        const res = await runDocker(pi.exec, ["service", "inspect", service!], {
          signal,
          cwd: pi.cwd,
          timeoutMs: 30_000,
        });
        if (res.code !== 0) return swarmFailure(`docker service inspect ${service}`, res);
        if (!path) return ok(clamp(res.stdout, 16_000));
        const parsed = JSON.parse(res.stdout) as unknown;
        // docker inspect always wraps in an array; let callers omit the index.
        const root = Array.isArray(parsed) && !/^\[?\d/.test(path) ? parsed[0] : parsed;
        const value = getPath(root, path);
        if (value === undefined) return fail(`Path '${path}' not found on service ${service}.`);
        return ok(clamp(typeof value === "string" ? value : JSON.stringify(value, null, 2), 16_000));
      }

      case "logs": {
        const args = ["service", "logs", "--tail", String(tail ?? 200)];
        if (timestamps) args.push("--timestamps");
        if (since) args.push("--since", since);
        args.push(service!);
        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 60_000 });
        if (res.code !== 0) return swarmFailure(`docker service logs ${service}`, res);
        return ok(`${service}: logs\n\n${clamp(`${res.stdout}${res.stderr}`, 16_000, "tail")}`);
      }

      case "scale": {
        if (replicas === undefined) return fail("action 'scale' requires 'replicas'");
        const res = await runDocker(pi.exec, ["service", "scale", `${service!}=${replicas}`], {
          signal,
          cwd: pi.cwd,
          timeoutMs: 120_000,
        });
        return commandResult(`docker service scale ${service}=${replicas}`, res);
      }

      case "rollback": {
        const args = ["service", "rollback"];
        if (detached) args.push("--detach");
        args.push(service!);
        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 180_000 });
        return commandResult(`docker service rollback ${service}`, res);
      }

      case "rm": {
        const res = await runDocker(pi.exec, ["service", "rm", service!], {
          signal,
          cwd: pi.cwd,
          timeoutMs: 180_000,
        });
        return commandResult(`docker service rm ${service}`, res);
      }

      case "create": {
        if (!image) return fail("action 'create' requires 'image'");
        const envArgs = keyValueArgs("--env", env, "env");
        if (envArgs.error) return fail(envArgs.error);
        const labelArgs = keyValueArgs("--label", labels, "labels");
        if (labelArgs.error) return fail(labelArgs.error);

        const args = ["service", "create"];
        if (name) args.push("--name", name);
        if (mode) args.push("--mode", mode);
        if (replicas !== undefined) args.push("--replicas", String(replicas));
        for (const port of publish ?? []) args.push("--publish", port);
        for (const net of network ?? []) args.push("--network", net);
        for (const entry of mount ?? []) args.push("--mount", entry);
        for (const entry of constraint ?? []) args.push("--constraint", entry);
        for (const entry of secret ?? []) args.push("--secret", entry);
        for (const entry of configs ?? []) args.push("--config", entry);
        args.push(...envArgs.args, ...labelArgs.args);
        if (limitCpu) args.push("--limit-cpu", limitCpu);
        if (limitMemory !== undefined) args.push("--limit-memory", String(limitMemory));
        if (reserveCpu) args.push("--reserve-cpu", reserveCpu);
        if (reserveMemory !== undefined) args.push("--reserve-memory", String(reserveMemory));
        if (restartCondition) args.push("--restart-condition", restartCondition);
        if (restartDelay) args.push("--restart-delay", restartDelay);
        if (restartMaxAttempts !== undefined) args.push("--restart-max-attempts", String(restartMaxAttempts));
        if (updateParallelism !== undefined) args.push("--update-parallelism", String(updateParallelism));
        if (updateDelay) args.push("--update-delay", updateDelay);
        if (updateFailureAction) args.push("--update-failure-action", updateFailureAction);
        if (updateOrder) args.push("--update-order", updateOrder);
        if (healthCmd) args.push("--health-cmd", healthCmd);
        if (healthInterval) args.push("--health-interval", healthInterval);
        if (healthRetries !== undefined) args.push("--health-retries", String(healthRetries));
        if (healthStartPeriod) args.push("--health-start-period", healthStartPeriod);
        if (user) args.push("--user", user);
        if (withRegistryAuth) args.push("--with-registry-auth");
        if (detached) args.push("--detach");
        args.push(image);
        if (command && command.length > 0) args.push(...command);

        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 300_000 });
        return commandResult(`docker service create${name ? ` ${name}` : ""}`, res, {
          note: "verify with action='ps' and action='logs'",
        });
      }

      case "update": {
        const args = ["service", "update"];
        if (image) args.push("--image", image);
        if (replicas !== undefined) args.push("--replicas", String(replicas));
        for (const entry of env ?? []) args.push("--env-add", entry);
        for (const entry of envRemove ?? []) args.push("--env-rm", entry);
        for (const entry of labels ?? []) args.push("--label-add", entry);
        for (const port of publish ?? []) args.push("--publish-add", port);
        for (const port of publishRemove ?? []) args.push("--publish-rm", port);
        for (const net of network ?? []) args.push("--network-add", net);
        for (const net of networkRemove ?? []) args.push("--network-rm", net);
        for (const entry of mount ?? []) args.push("--mount-add", entry);
        for (const entry of constraint ?? []) args.push("--constraint-add", entry);
        if (limitCpu) args.push("--limit-cpu", limitCpu);
        if (limitMemory !== undefined) args.push("--limit-memory", String(limitMemory));
        if (reserveCpu) args.push("--reserve-cpu", reserveCpu);
        if (reserveMemory !== undefined) args.push("--reserve-memory", String(reserveMemory));
        if (updateParallelism !== undefined) args.push("--update-parallelism", String(updateParallelism));
        if (updateDelay) args.push("--update-delay", updateDelay);
        if (updateFailureAction) args.push("--update-failure-action", updateFailureAction);
        if (updateOrder) args.push("--update-order", updateOrder);
        if (healthCmd) args.push("--health-cmd", healthCmd);
        if (healthInterval) args.push("--health-interval", healthInterval);
        if (healthStartPeriod) args.push("--health-start-period", healthStartPeriod);
        if (withRegistryAuth) args.push("--with-registry-auth");
        if (force) args.push("--force");
        if (detached) args.push("--detach");
        args.push(service!);
        if (command && command.length > 0) args.push(...command);

        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 300_000 });
        return commandResult(`docker service update ${service}`, res, {
          note: "verify convergence with action='ps'; roll back with action='rollback'",
        });
      }
    }
    return fail(`Refusing to run unsupported service action: ${String(action)}`);
  },
});

export default factory;
