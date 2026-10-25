import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { commandResult, daemonHint, fail, ok, runDocker, requireConfirm } from "./_docker";

interface InfoLike {
  Swarm?: {
    LocalNodeState?: string;
    NodeID?: string;
    NodeAddr?: string;
    ControlAvailable?: boolean;
    Error?: string;
    RemoteManagers?: Array<{ NodeID?: string; Addr?: string }>;
    Cluster?: { ID?: string; Spec?: { Name?: string } };
    Managers?: number;
    Nodes?: number;
  };
}

/**
 * Swarm cluster lifecycle and membership.
 *
 * `status` is deliberately usable from a worker or a standalone node: it is the
 * first call in any swarm task and must not require manager privileges.
 */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_swarm",
  label: "Swarm Cluster",
  description:
    "Create, join, inspect and maintain a Swarm cluster. Actions: status (works on any node — reports whether this node is " +
    "inactive/active-a-manager/active-a-worker plus manager addresses), init, join, join-token, leave, update. " +
    "`leave` and `update` require confirm=true; leaving with force=true removes this node even as a manager. " +
    "Use status FIRST for any swarm question — most 'service does not work' reports are actually 'this node is not a manager'.",
  approval: (args) => {
    // The harness passes parsed params but the callback type is `unknown`.
    const action = typeof args === "object" && args !== null && "action" in args
      ? (args as { action?: string }).action
      : undefined;
    if (action === "leave" || action === "update" || action === "init" || action === "join") {
      return { tier: action === "init" || action === "join" ? "exec" : "write", reason: `docker swarm ${action} changes cluster membership` };
    }
    return "read";
  },
  parameters: pi.zod.object({
    action: pi.zod
      .enum(["status", "init", "join", "join-token", "leave", "update"])
      .describe("Cluster operation"),
    advertiseAddr: pi.zod
      .string()
      .optional()
      .describe("For init/join: advertised address, '<ip|interface>[:port]' — required on multi-interface hosts"),
    listenAddr: pi.zod.string().optional().describe("For init/join: listen address, e.g. '0.0.0.0:2377'"),
    token: pi.zod.string().optional().describe("For join: join token from docker_swarm action='join-token'"),
    managerAddr: pi.zod.string().optional().describe("For join: manager address host:2377"),
    role: pi.zod.enum(["manager", "worker", "rotate-manager", "rotate-worker"]).optional().describe("For join-token: which token to print ('rotate-*' rotates it)"),
    quiet: pi.zod.boolean().optional().describe("For join-token: print only the token (-q)"),
    autolock: pi.zod.boolean().optional().describe("For init/update: require an unlock key to start a stopped manager"),
    taskHistoryLimit: pi.zod.number().optional().describe("For update: retained task history count"),
    snapshotInterval: pi.zod.number().optional().describe("For update: raft snapshot interval in seconds"),
    force: pi.zod.boolean().optional().describe("For leave: force removal as a manager (--force)"),
    confirm: pi.zod.boolean().optional().describe("Required for leave/update"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const {
      action,
      advertiseAddr,
      listenAddr,
      token,
      managerAddr,
      role,
      quiet,
      autolock,
      taskHistoryLimit,
      snapshotInterval,
      force,
      confirm,
    } = params;

    if (action === "leave" || action === "update") {
      const refusal = requireConfirm(confirm, `${action} this swarm node`);
      if (refusal) return refusal;
    }

    switch (action) {
      case "status": {
        const res = await runDocker(pi.exec, ["info", "--format", "{{json .}}"], {
          signal,
          cwd: pi.cwd,
          timeoutMs: 30_000,
        });
        if (res.code !== 0) {
          return fail(`Could not read daemon info (exit ${res.code}):\n${res.stderr || res.stdout}${daemonHint(res)}`);
        }
        const info = JSON.parse(res.stdout) as InfoLike;
        const swarm = info.Swarm;
        const state = swarm?.LocalNodeState ?? "unknown";
        const isManager = swarm?.ControlAvailable === true;
        const managers = swarm?.RemoteManagers ?? [];

        if (state !== "active") {
          return ok(
            [
              `Swarm state: ${state}${swarm?.Error ? ` (${swarm.Error})` : ""}`,
              "",
              "This node is not part of a swarm, so docker_service/docker_stack/docker_node cannot work here.",
              "Next steps:",
              "- docker_swarm action='init' advertiseAddr='<this host ip>' — create a swarm here (single node is enough to start)",
              "- docker_swarm action='join' token='<worker-or-manager-token>' managerAddr='<manager-ip>:2377' — join an existing swarm",
            ].join("\n"),
            { swarmState: state, isManager: false },
          );
        }

        return ok(
          [
            `Swarm state:   active`,
            `Node role:     ${isManager ? "manager" : "worker"}`,
            `Node ID:       ${swarm?.NodeID ?? "?"}`,
            `Node address:  ${swarm?.NodeAddr ?? "?"}`,
            `Cluster ID:    ${swarm?.Cluster?.ID ?? "?"}`,
            `Managers seen: ${managers.length || (isManager ? 1 : 0)}`,
            managers.length > 0
              ? `Manager addrs: ${managers.map((entry) => entry.Addr).join(", ")}`
              : "Manager addrs: (this node only)",
            "",
            isManager
              ? "This node can run swarm commands. Check membership with docker_node action='ls'."
              : "This node is a WORKER: docker_service/docker_stack/docker_node must be run against a manager. Set DOCKER_HOST to a manager, or use docker_swarm action='join-token' role='manager' from the manager.",
          ].join("\n"),
          {
            swarmState: state,
            isManager,
            nodeId: swarm?.NodeID,
            managers: managers.map((entry) => entry.Addr),
          },
        );
      }

      case "init": {
        const args = ["swarm", "init"];
        if (advertiseAddr) args.push("--advertise-addr", advertiseAddr);
        if (listenAddr) args.push("--listen-addr", listenAddr);
        if (autolock) args.push("--autolock");
        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 120_000 });
        if (res.code !== 0 && /already part of a swarm/i.test(res.stderr)) {
          return fail(
            "This node is already in a swarm; `docker swarm init` only creates one. " +
              "Use docker_swarm action='status' to see its role, or action='leave' to start over.",
          );
        }
        return commandResult("docker swarm init", res, {
          note: "add managers/workers with docker_swarm action='join-token', then action='join' on each node",
        });
      }

      case "join": {
        if (!managerAddr) return fail("action 'join' requires 'managerAddr' (host:2377 of any manager)");
        const args = ["swarm", "join"];
        if (token) args.push("--token", token);
        if (advertiseAddr) args.push("--advertise-addr", advertiseAddr);
        if (listenAddr) args.push("--listen-addr", listenAddr);
        args.push(managerAddr);
        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 120_000 });
        if (res.code !== 0 && /already part of a swarm/i.test(res.stderr)) {
          return fail("This node is already in a swarm. Use docker_swarm action='leave' first if it must join a different one.");
        }
        return commandResult(`docker swarm join ${managerAddr}`, res, {
          note: "verify with docker_swarm action='status' and docker_node action='ls' from a manager",
        });
      }

      case "join-token": {
        const args = ["swarm", "join-token"];
        if (role?.startsWith("rotate-")) args.push("--rotate");
        const side = role === "manager" || role === "rotate-manager" ? "manager" : "worker";
        args.push(role?.startsWith("rotate-") ? side : side);
        if (quiet) args.push("--quiet");
        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 60_000 });
        const body = `${res.stdout}${res.stderr}`.trim();
        if (res.code !== 0) {
          const hint = /not a swarm manager|not part of a swarm/i.test(body)
            ? " Join tokens can only be read on a manager. Run this against a manager (DOCKER_HOST) or a swarm created with docker_swarm action='init'."
            : "";
          return fail(`docker swarm join-token failed (exit ${res.code}):\n${body || "(no output)"}${hint}`);
        }
        return ok(body, { role: side });
      }

      case "leave": {
        const args = ["swarm", "leave"];
        if (force) args.push("--force");
        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 120_000 });
        return commandResult(`docker swarm leave${force ? " --force" : ""}`, res, {
          note: force
            ? "node left the cluster even as a manager — quorum may now be degraded; check docker_node action='ls' from another manager"
            : "drain workloads first with docker_node action='update' availability='drain'",
        });
      }

      case "update": {
        const args = ["swarm", "update"];
        if (autolock !== undefined) args.push("--autolock", String(autolock));
        if (taskHistoryLimit !== undefined) args.push("--task-history-limit", String(taskHistoryLimit));
        if (snapshotInterval !== undefined) args.push("--snapshot-interval", String(snapshotInterval));
        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 120_000 });
        return commandResult("docker swarm update", res);
      }
    }
    return fail(`Refusing to run unsupported swarm action: ${String(action)}`);
  },
});

export default factory;
