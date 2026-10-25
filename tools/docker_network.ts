import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { clamp, commandResult, fail, ok, parseJsonLines, requireConfirm, runDocker, table } from "./_docker";

interface NetworkRow {
  ID: string;
  Name: string;
  Driver: string;
  Scope: string;
  IPv6: string;
  Internal: string;
}

/** Docker networks: list, create, remove, connect/disconnect containers. */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_network",
  label: "Docker Networks",
  description:
    "Manage Docker networks. Actions: ls, inspect, create, rm, connect, disconnect, prune. " +
    "Use ls before docker_run/docker_compose to find the existing network name, and connect when a " +
    "container must reach services on another compose project's network. `rm` and `prune` require confirm=true.",
  approval: (args) => {
    // The harness passes parsed params but the callback type is `unknown`.
    const action = typeof args === "object" && args !== null && "action" in args
      ? (args as { action?: string }).action
      : undefined;
    if (action === "ls" || action === "inspect") return "read";
    return { tier: "write", reason: `docker network ${action ?? "?"} changes network topology` };
  },
  parameters: pi.zod.object({
    action: pi.zod.enum(["ls", "inspect", "create", "rm", "connect", "disconnect", "prune"]).describe("Operation"),
    name: pi.zod.string().optional().describe("Network name (required for inspect/create/rm/connect/disconnect)"),
    driver: pi.zod
      .enum(["bridge", "host", "overlay", "macvlan", "ipvlan", "none"])
      .optional()
      .describe("Driver for create (default bridge)"),
    internal: pi.zod.boolean().optional().describe("For create: restrict external access (--internal)"),
    attachable: pi.zod.boolean().optional().describe("For create: --attachable (swarm overlay)"),
    subnet: pi.zod.string().optional().describe("For create: --subnet, e.g. 172.28.0.0/16"),
    container: pi.zod.string().optional().describe("For connect/disconnect: container name or ID"),
    aliases: pi.zod.array(pi.zod.string()).optional().describe("For connect: network aliases"),
    dryRun: pi.zod.boolean().optional().describe("For prune: list what would be removed instead of removing"),
    confirm: pi.zod.boolean().optional().describe("Required for rm/prune"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const { action, name, driver, internal, attachable, subnet, container, aliases, dryRun, confirm } = params;

    if (action === "ls") {
      const res = await runDocker(pi.exec, ["network", "ls", "--format", "{{json .}}"], {
        signal,
        cwd: pi.cwd,
        timeoutMs: 30_000,
      });
      if (res.code !== 0) return fail(`docker network ls failed (exit ${res.code}):\n${clamp(res.stderr || res.stdout)}`);
      const rows = parseJsonLines<NetworkRow>(res.stdout);
      if (rows.length === 0) return ok("No networks.", { count: 0 });
      const body = table(
        ["NAME", "DRIVER", "SCOPE", "IPV6", "INTERNAL", "ID"],
        rows.map((row) => [row.Name, row.Driver, row.Scope, row.IPv6, row.Internal, row.ID.slice(0, 12)]),
      );
      return ok(body, {
        networks: rows.map((row) => ({ id: row.ID, name: row.Name, driver: row.Driver, scope: row.Scope })),
      });
    }

    if (!name && action !== "prune") return fail(`action '${action}' requires 'name'`);

    switch (action) {
      case "inspect": {
        const res = await runDocker(pi.exec, ["network", "inspect", name!], { signal, cwd: pi.cwd, timeoutMs: 30_000 });
        if (res.code !== 0) return commandResult(`docker network inspect ${name}`, res);
        return ok(clamp(res.stdout, 16_000));
      }
      case "create": {
        const args = ["network", "create"];
        if (driver) args.push("--driver", driver);
        if (internal) args.push("--internal");
        if (attachable) args.push("--attachable");
        if (subnet) args.push("--subnet", subnet);
        args.push(name!);
        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 30_000 });
        return commandResult(`docker network create ${name}`, res);
      }
      case "rm": {
        const refusal = requireConfirm(confirm, `remove network ${name}`);
        if (refusal) return refusal;
        const res = await runDocker(pi.exec, ["network", "rm", name!], { signal, cwd: pi.cwd, timeoutMs: 30_000 });
        return commandResult(`docker network rm ${name}`, res);
      }
      case "connect":
      case "disconnect": {
        if (!container) return fail(`action '${action}' requires 'container'`);
        const args = ["network", action];
        for (const alias of aliases ?? []) args.push("--alias", alias);
        args.push(name!, container);
        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 30_000 });
        return commandResult(`docker network ${action} ${name} ${container}`, res);
      }
      case "prune": {
        const refusal = requireConfirm(confirm && !dryRun, "prune unused networks");
        if (refusal) return refusal;
        if (dryRun) {
          // `network prune` has no dry-run flag: replicate its rule (no attached
          // containers, not built-in) so the caller can see what would disappear.
          const listed = await runDocker(pi.exec, ["network", "ls", "--format", "{{json .}}"], {
            signal,
            cwd: pi.cwd,
            timeoutMs: 30_000,
          });
          if (listed.code !== 0) return commandResult("docker network ls", listed);
          const candidates: string[] = [];
          for (const row of parseJsonLines<NetworkRow>(listed.stdout)) {
            if (["bridge", "host", "none"].includes(row.Name)) continue;
            const detail = await runDocker(pi.exec, ["network", "inspect", row.ID], {
              signal,
              cwd: pi.cwd,
              timeoutMs: 30_000,
            });
            if (detail.code !== 0) continue;
            const parsed = JSON.parse(detail.stdout) as Array<{ Containers?: Record<string, unknown> }>;
            if (Object.keys(parsed[0]?.Containers ?? {}).length === 0) candidates.push(row.Name);
          }
          return ok(
            candidates.length === 0
              ? "dry run: no unused networks would be pruned."
              : `dry run: these ${candidates.length} network(s) have no containers and would be pruned:\n${candidates
                  .map((entry) => `- ${entry}`)
                  .join("\n")}`,
            { dryRun: true, candidates },
          );
        }
        const res = await runDocker(pi.exec, ["network", "prune", "--force"], { signal, cwd: pi.cwd, timeoutMs: 60_000 });
        return commandResult("docker network prune", res);
      }
    }

    return fail(`Refusing to run unsupported network action: ${String(action)}`);
  },
});

export default factory;