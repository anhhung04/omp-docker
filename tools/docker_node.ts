import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { clamp, commandResult, fail, keyValueArgs, ok, parseJsonLines, requireConfirm, runDocker, swarmFailure, table } from "./_docker";

interface NodeRow {
  ID: string;
  Hostname: string;
  Status: string;
  Availability: string;
  ManagerStatus: string;
  EngineVersion: string;
}

interface NodeTaskRow {
  ID: string;
  Name: string;
  Image: string;
  Node: string;
  DesiredState: string;
  CurrentState: string;
  Error: string;
}

/** Swarm cluster nodes: membership, availability and role changes. */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_node",
  label: "Swarm Node",
  description:
    "Manage Swarm cluster nodes. Actions: ls, inspect, ps, update (availability/labels/role), promote, demote, rm. " +
    "Use to verify quorum (odd manager count >=3), drain a node before maintenance, or find why tasks cannot be placed. " +
    "promote/demote/rm require confirm=true — they change cluster membership and can cost raft quorum.",
  approval: (args) => {
    // The harness passes parsed params but the callback type is `unknown`.
    const action = typeof args === "object" && args !== null && "action" in args
      ? (args as { action?: string }).action
      : undefined;
    if (action === "promote" || action === "demote" || action === "rm") {
      return { tier: "write", reason: `docker node ${action} changes swarm membership` };
    }
    if (action === "update") return { tier: "exec", reason: "Node availability/label changes reschedule tasks" };
    return "read";
  },
  parameters: pi.zod.object({
    action: pi.zod.enum(["ls", "inspect", "ps", "update", "promote", "demote", "rm"]).describe("Node operation"),
    node: pi.zod.string().optional().describe("Node ID or hostname (required except ls/ps on this node)"),
    availability: pi.zod
      .enum(["active", "pause", "drain"])
      .optional()
      .describe("For update: 'drain' before maintenance, 'active' to accept tasks again"),
    labels: pi.zod.array(pi.zod.string()).optional().describe("For update: labels KEY=VALUE to add (drive placement constraints)"),
    labelRemove: pi.zod.array(pi.zod.string()).optional().describe("For update: label keys to remove"),
    role: pi.zod.enum(["manager", "worker"]).optional().describe("For update: node role"),
    filter: pi.zod.string().optional().describe("Docker filter expression for ls"),
    confirm: pi.zod.boolean().optional().describe("Required for promote/demote/rm"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const { action, node, availability, labels, labelRemove, role, filter, confirm } = params;

    if (action === "promote" || action === "demote" || action === "rm") {
      const refusal = requireConfirm(confirm, `${action} node ${node ?? "(unspecified)"}`);
      if (refusal) return refusal;
    }
    if (action !== "ls" && action !== "ps" && !node) return fail(`action '${action}' requires 'node'`);

    switch (action) {
      case "ls": {
        const args = ["node", "ls", "--format", "{{json .}}"];
        if (filter) args.push("--filter", filter);
        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 60_000 });
        if (res.code !== 0) return swarmFailure("docker node ls", res);
        const rows = parseJsonLines<NodeRow>(res.stdout);
        if (rows.length === 0) return ok("No nodes in this swarm.", { count: 0 });

        const managers = rows.filter((row) => row.ManagerStatus && row.ManagerStatus !== "");
        const reachable = managers.filter((row) => /Leader|Reachable/.test(row.ManagerStatus));
        const warning =
          managers.length > 0 && managers.length % 2 === 0
            ? `\n\nWARNING: ${managers.length} managers is an even count — raft needs an odd number (1/3/5) for quorum.`
            : managers.length > 1 && reachable.length <= Math.floor(managers.length / 2)
              ? `\n\nWARNING: only ${reachable.length}/${managers.length} managers reachable — another manager loss costs quorum.`
              : "";

        return ok(
          `${table(
            ["HOSTNAME", "STATUS", "AVAILABILITY", "MANAGER", "ENGINE"],
            rows.map((row) => [row.Hostname, row.Status, row.Availability, row.ManagerStatus || "-", row.EngineVersion]),
          )}${warning}`,
          {
            count: rows.length,
            managerCount: managers.length,
            reachableManagers: reachable.length,
            nodes: rows.map((row) => ({
              id: row.ID,
              hostname: row.Hostname,
              status: row.Status,
              availability: row.Availability,
              managerStatus: row.ManagerStatus || undefined,
              engineVersion: row.EngineVersion,
            })),
          },
        );
      }

      case "inspect": {
        const res = await runDocker(pi.exec, ["node", "inspect", node!], { signal, cwd: pi.cwd, timeoutMs: 30_000 });
        if (res.code !== 0) return swarmFailure(`docker node inspect ${node}`, res);
        return ok(clamp(res.stdout, 16_000));
      }

      case "ps": {
        const args = ["node", "ps", "--format", "{{json .}}", "--no-trunc"];
        if (filter) args.push("--filter", filter);
        if (node) args.push(node);
        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 60_000 });
        if (res.code !== 0) return swarmFailure("docker node ps", res);
        const rows = parseJsonLines<NodeTaskRow>(res.stdout);
        if (rows.length === 0) return ok(`No tasks on ${node ?? "this node"}.`, { count: 0 });
        return ok(
          table(
            ["TASK", "NODE", "DESIRED", "CURRENT", "ERROR"],
            rows.map((row) => [row.Name, row.Node, row.DesiredState, row.CurrentState, row.Error || "-"]),
            { maxColumnWidth: 46 },
          ),
          { count: rows.length },
        );
      }

      case "update": {
        const labelArgs = keyValueArgs("--label-add", labels, "labels");
        if (labelArgs.error) return fail(labelArgs.error);
        const args = ["node", "update"];
        if (availability) args.push("--availability", availability);
        if (role) args.push("--role", role);
        args.push(...labelArgs.args);
        for (const key of labelRemove ?? []) args.push("--label-rm", key);
        args.push(node!);
        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 120_000 });
        return commandResult(`docker node update ${node}`, res, {
          note: availability === "drain" ? "tasks rescheduled elsewhere; set availability='active' after maintenance" : undefined,
        });
      }

      case "promote":
      case "demote": {
        const res = await runDocker(pi.exec, ["node", action, node!], { signal, cwd: pi.cwd, timeoutMs: 120_000 });
        return commandResult(`docker node ${action} ${node}`, res, {
          note: action === "promote" ? "keep an odd manager count for quorum" : undefined,
        });
      }

      case "rm": {
        const res = await runDocker(pi.exec, ["node", "rm", node!], { signal, cwd: pi.cwd, timeoutMs: 120_000 });
        return commandResult(`docker node rm ${node}`, res);
      }
    }
    return fail(`Refusing to run unsupported node action: ${String(action)}`);
  },
});

export default factory;
