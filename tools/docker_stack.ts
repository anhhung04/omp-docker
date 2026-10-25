import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { clamp, commandResult, fail, ok, parseJsonLines, requireConfirm, runDocker, swarmFailure, table } from "./_docker";

interface StackRow {
  Name: string;
  Services: string;
  Orchestrator: string;
  Namespace: string;
}

interface StackTaskRow {
  ID: string;
  Name: string;
  Image: string;
  Node: string;
  DesiredState: string;
  CurrentState: string;
  Error: string;
}

interface StackServiceRow {
  ID: string;
  Name: string;
  Mode: string;
  Replicas: string;
  Image: string;
  Ports: string;
}

/**
 * Swarm stacks: compose-defined applications deployed as a unit.
 *
 * Stacks are the swarm equivalent of `docker_compose`: same compose file, different
 * orchestrator, and the services it creates belong to the stack.
 */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_stack",
  label: "Swarm Stack",
  description:
    "Deploy and manage Swarm stacks (compose files run by swarm). Actions: ls, ps (tasks), services, config (resolved YAML), deploy, rm. " +
    "Use for multi-host applications: one compose file becomes a set of services scheduled across the cluster. " +
    "`deploy` accepts private-registry images via withRegistryAuth (workers otherwise pull anonymously and tasks fail). " +
    "`rm` requires confirm=true — it removes every service in the stack.",
  approval: (args) => {
    // The harness passes parsed params but the callback type is `unknown`.
    const action = typeof args === "object" && args !== null && "action" in args
      ? (args as { action?: string }).action
      : undefined;
    if (action === "rm") return { tier: "write", reason: "Removing a stack deletes all of its services" };
    if (action === "deploy") return { tier: "exec", reason: "Deploys or updates services across the cluster" };
    return "read";
  },
  parameters: pi.zod.object({
    action: pi.zod
      .enum(["ls", "ps", "services", "config", "deploy", "rm"])
      .describe("Stack operation"),
    stack: pi.zod.string().optional().describe("Stack name (required for ps/services/deploy/rm)"),
    composeFile: pi.zod.array(pi.zod.string()).optional().describe("Compose file(s) (-c) for deploy/config"),
    pruneServices: pi.zod
      .boolean()
      .optional()
      .describe("For deploy: remove services no longer referenced (--prune)"),
    withRegistryAuth: pi.zod
      .boolean()
      .optional()
      .describe("For deploy: send registry auth to workers (--with-registry-auth)"),
    resolveImage: pi.zod
      .enum(["always", "changed", "never"])
      .optional()
      .describe("For deploy: when to resolve image digests (default always)"),
    wait: pi.zod
      .boolean()
      .optional()
      .describe("For deploy: block until services converge (unsets -d; default true)"),
    filter: pi.zod.string().optional().describe("Docker filter expression for ps"),
    confirm: pi.zod.boolean().optional().describe("Required for rm"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const {
      action,
      stack,
      composeFile,
      pruneServices,
      withRegistryAuth,
      resolveImage,
      wait,
      filter,
      confirm,
    } = params;

    if (action === "rm") {
      const refusal = requireConfirm(confirm, `remove stack ${stack ?? "(unspecified)"} and all its services`);
      if (refusal) return refusal;
    }
    // `config` validates a file, not a deployed stack, so it needs no stack name.
    if (action !== "ls" && action !== "config" && !stack) return fail(`action '${action}' requires 'stack'`);

    switch (action) {
      case "ls": {
        const res = await runDocker(pi.exec, ["stack", "ls", "--format", "{{json .}}"], {
          signal,
          cwd: pi.cwd,
          timeoutMs: 60_000,
        });
        if (res.code !== 0) return swarmFailure("docker stack ls", res);
        const rows = parseJsonLines<StackRow>(res.stdout);
        if (rows.length === 0) return ok("No stacks deployed in this swarm.", { count: 0 });
        return ok(
          table(
            ["NAME", "SERVICES", "ORCHESTRATOR", "NAMESPACE"],
            rows.map((row) => [row.Name, row.Services, row.Orchestrator, row.Namespace]),
          ),
          { count: rows.length, stacks: rows.map((row) => ({ name: row.Name, services: row.Services })) },
        );
      }

      case "ps": {
        const args = ["stack", "ps", "--format", "{{json .}}", "--no-trunc"];
        if (filter) args.push("--filter", filter);
        args.push(stack!);
        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 60_000 });
        if (res.code !== 0) return swarmFailure(`docker stack ps ${stack}`, res);
        const rows = parseJsonLines<StackTaskRow>(res.stdout);
        if (rows.length === 0) return ok(`No tasks for stack ${stack}.`, { count: 0 });
        const failed = rows.filter((row) => row.Error);
        return ok(
          `${failed.length > 0 ? `${failed.length} task(s) reporting errors — see ERROR column.\n\n` : ""}${table(
            ["TASK", "NODE", "DESIRED", "CURRENT", "ERROR"],
            rows.map((row) => [row.Name, row.Node, row.DesiredState, row.CurrentState, row.Error || "-"]),
            { maxColumnWidth: 46 },
          )}`,
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

      case "services": {
        const res = await runDocker(pi.exec, ["stack", "services", "--format", "{{json .}}", stack!], {
          signal,
          cwd: pi.cwd,
          timeoutMs: 60_000,
        });
        if (res.code !== 0) return swarmFailure(`docker stack services ${stack}`, res);
        const rows = parseJsonLines<StackServiceRow>(res.stdout);
        if (rows.length === 0) return ok(`No services in stack ${stack}.`, { count: 0 });
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

      case "config": {
        const args = ["stack", "config"];
        for (const file of composeFile ?? []) args.push("--compose-file", file);
        if (!composeFile || composeFile.length === 0) args.push("--compose-file", "compose.yml");
        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 60_000 });
        if (res.code !== 0) return swarmFailure("docker stack config", res);
        return ok(clamp(`${res.stdout}${res.stderr}`, 16_000));
      }

      case "deploy": {
        if (!composeFile || composeFile.length === 0) {
          return fail("action 'deploy' requires composeFile (e.g. ['compose.yml'])");
        }
        const args = ["stack", "deploy"];
        for (const file of composeFile) args.push("--compose-file", file);
        if (pruneServices) args.push("--prune");
        if (withRegistryAuth) args.push("--with-registry-auth");
        if (resolveImage) args.push("--resolve-image", resolveImage);
        if (wait === false) args.push("--detach");
        args.push(stack!);
        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 600_000 });
        return commandResult(`docker stack deploy ${stack}`, res, {
          note: "verify with action='services' and action='ps'",
        });
      }

      case "rm": {
        const res = await runDocker(pi.exec, ["stack", "rm", stack!], {
          signal,
          cwd: pi.cwd,
          timeoutMs: 300_000,
        });
        return commandResult(`docker stack rm ${stack}`, res);
      }
    }
    return fail(`Refusing to run unsupported stack action: ${String(action)}`);
  },
});

export default factory;
