import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { clamp, commandResult, fail, ok, parseJsonLines, requireConfirm, runDocker, table } from "./_docker";

interface VolumeRow {
  Name: string;
  Driver: string;
  Scope: string;
  Mountpoint?: string;
}

interface VolumeInspect {
  Name: string;
  Mountpoint: string;
  CreatedAt?: string;
  Labels?: Record<string, string> | null;
}

/** Docker volumes: list, inspect, create, remove. */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_volume",
  label: "Docker Volumes",
  description:
    "Manage Docker volumes. Actions: ls, inspect, create, rm, prune. " +
    "`inspect` reports the host mountpoint and labels, which is how you find a volume's data on disk or " +
    "confirm it is the one a container uses. `rm` and `prune` require confirm=true — volume deletion is irreversible " +
    "and takes database data with it.",
  approval: (args) => {
    // The harness passes parsed params but the callback type is `unknown`.
    const action = typeof args === "object" && args !== null && "action" in args
      ? (args as { action?: string }).action
      : undefined;
    if (action === "ls" || action === "inspect") return "read";
    return { tier: "write", reason: `docker volume ${action ?? "?"} deletes or creates persistent data` };
  },
  parameters: pi.zod.object({
    action: pi.zod.enum(["ls", "inspect", "create", "rm", "prune"]).describe("Operation"),
    name: pi.zod.string().optional().describe("Volume name (required for inspect/create/rm)"),
    driver: pi.zod.string().optional().describe("Volume driver for create (default local)"),
    labels: pi.zod.array(pi.zod.string()).optional().describe("Labels KEY=VALUE for create"),
    dangling: pi.zod.boolean().optional().describe("For ls: only unused volumes"),
    confirm: pi.zod.boolean().optional().describe("Required for rm/prune"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const { action, name, driver, labels, dangling, confirm } = params;

    if (action === "ls") {
      const args = ["volume", "ls", "--format", "{{json .}}"];
      if (dangling) args.push("--filter", "dangling=true");
      const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 30_000 });
      if (res.code !== 0) return fail(`docker volume ls failed (exit ${res.code}):\n${clamp(res.stderr || res.stdout)}`);
      const rows = parseJsonLines<VolumeRow>(res.stdout);
      if (rows.length === 0) return ok("No volumes match.", { count: 0 });
      return ok(
        table(
          ["NAME", "DRIVER", "SCOPE", "MOUNTPOINT"],
          rows.map((row) => [row.Name, row.Driver, row.Scope, row.Mountpoint || "-"]),
          { maxColumnWidth: 60 },
        ),
        { count: rows.length, volumes: rows.map((row) => ({ name: row.Name, driver: row.Driver })) },
      );
    }

    if (!name && action !== "prune") return fail(`action '${action}' requires 'name'`);

    switch (action) {
      case "inspect": {
        const res = await runDocker(pi.exec, ["volume", "inspect", name!], { signal, cwd: pi.cwd, timeoutMs: 30_000 });
        if (res.code !== 0) return commandResult(`docker volume inspect ${name}`, res);
        const parsed = JSON.parse(res.stdout) as VolumeInspect[];
        const volume = parsed[0];
        const labelList = Object.entries(volume?.Labels ?? {});
        return ok(
          [
            `name:       ${volume?.Name}`,
            `driver:     ${JSON.stringify(parsed[0] ? "see raw" : "unknown")}`,
            `mountpoint: ${volume?.Mountpoint}`,
            `created:    ${volume?.CreatedAt ?? "unknown"}`,
            `labels:     ${labelList.length > 0 ? labelList.map(([k, v]) => `${k}=${v}`).join(", ") : "(none)"}`,
          ].join("\n"),
          { volume: volume?.Name, mountpoint: volume?.Mountpoint },
        );
      }
      case "create": {
        const args = ["volume", "create"];
        if (driver) args.push("--driver", driver);
        for (const label of labels ?? []) {
          if (!label.includes("=")) return fail(`label ${JSON.stringify(label)} must be KEY=VALUE`);
          args.push("--label", label);
        }
        args.push(name!);
        const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 30_000 });
        return commandResult(`docker volume create ${name}`, res);
      }
      case "rm": {
        const refusal = requireConfirm(confirm, `remove volume ${name}`);
        if (refusal) return refusal;
        const res = await runDocker(pi.exec, ["volume", "rm", name!], { signal, cwd: pi.cwd, timeoutMs: 30_000 });
        return commandResult(`docker volume rm ${name}`, res);
      }
      case "prune": {
        const refusal = requireConfirm(confirm, "prune unused volumes");
        if (refusal) return refusal;
        const res = await runDocker(pi.exec, ["volume", "prune", "--force"], { signal, cwd: pi.cwd, timeoutMs: 60_000 });
        return commandResult("docker volume prune", res);
      }
    }

    return fail(`Refusing to run unsupported volume action: ${String(action)}`);
  },
});

export default factory;