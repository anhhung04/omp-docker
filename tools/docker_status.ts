import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { clamp, fail, ok, runDocker, table } from "./_docker";

interface InfoLike {
  OperatingSystem?: string;
  ServerVersion?: string;
  Driver?: string;
  Containers?: number;
  ContainersRunning?: number;
  Images?: number;
  RegistryConfig?: { IndexConfigs?: Record<string, { Secure?: boolean }> };
  Swarm?: { LocalNodeState?: string };
}

interface VersionLike {
  Client?: { Version?: string };
  Server?: { Version?: string };
}

interface ComposeVersionLike {
  version?: string;
}

interface DfRow {
  Type: string;
  TotalCount: string;
  Active: string;
  Size: string;
  Reclaimable: string;
}

/**
 * Daemon health, versions and reasoning hints.
 *
 * This is the tool the skill routes "is Docker working" questions to: one call gives
 * the agent versions, container counts, disk usage, and the specific reason a daemon is
 * unreachable together with the next step to try.
 */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_status",
  label: "Docker Status",
  description:
    "Check Docker availability and health: client/server versions, compose plugin availability, " +
    "container counts, disk usage, and daemon reachability with actionable diagnostics. " +
    "Call this FIRST when Docker behaviour is unexpected or before assuming a container failure is real. " +
    "Note: `docker info` reflects the daemon that $DOCKER_HOST points at, so it reaches remote daemons too.",
  approval: "read",
  parameters: pi.zod.object({
    verbose: pi.zod.boolean().optional().describe("Include insecure registries and swarm state"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const { verbose } = params;

    const infoRes = await runDocker(pi.exec, ["info", "--format", "{{json .}}"], {
      signal,
      cwd: pi.cwd,
      timeoutMs: 30_000,
    });
    if (infoRes.code !== 0) {
      const msg = `${infoRes.stderr}\n${infoRes.stdout}`;
      let reason: string;
      if (/Cannot connect to the Docker daemon/i.test(msg)) {
        reason =
          "daemon unreachable. Verify the daemon is running (`systemctl status docker` on Linux), and $DOCKER_HOST " +
          "(default unix:///var/run/docker.sock). For remote daemons set DOCKER_HOST=tcp://host:2375. " +
          "This is usually a daemon-side problem, not the plugin.";
      } else if (/permission denied while trying to connect/i.test(msg)) {
        reason =
          "permission denied on the Docker socket. `sudo usermod -aG docker $USER`, re-login, or run rootless Docker. " +
          "Tools cannot work around this — fix group membership or the socket permissions.";
      } else {
        reason = `unexpected 'docker info' failure (exit ${infoRes.code}). Verify the CLI install and DOCKER_BIN=${process.env.DOCKER_BIN ?? "(unset)"}.`;
      }
      return fail(`Docker is not usable: ${reason}\n\nstderr:\n${clamp(msg, 4_000)}`);
    }

    const info = JSON.parse(infoRes.stdout) as InfoLike;

    const versionRes = await runDocker(pi.exec, ["version", "--format", "{{json .}}"], {
      signal,
      cwd: pi.cwd,
      timeoutMs: 30_000,
    });
    const version = versionRes.code === 0 ? (JSON.parse(versionRes.stdout) as VersionLike) : undefined;

    const composeRes = await runDocker(pi.exec, ["compose", "version", "--format", "json"], {
      signal,
      cwd: pi.cwd,
      timeoutMs: 30_000,
    });
    const compose =
      composeRes.code === 0 ? (JSON.parse(composeRes.stdout) as ComposeVersionLike) : undefined;

    const dfRes = await runDocker(pi.exec, ["system", "df", "--format", "{{json .}}"], {
      signal,
      cwd: pi.cwd,
      timeoutMs: 60_000,
    });
    const df =
      dfRes.code === 0
        ? dfRes.stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line) as DfRow)
        : [];

    const stopped = (info.Containers ?? 0) - (info.ContainersRunning ?? 0);
    const lines = [
      `Docker daemon: ${info.OperatingSystem ?? "unknown"}, Server ${info.ServerVersion ?? "?"}, Client ${version?.Client?.Version ?? "?"}`,
      `Containers: ${info.Containers ?? "?"} total, ${info.ContainersRunning ?? "?"} running, ${Math.max(0, stopped)} stopped/paused`,
      `Images: ${info.Images ?? "?"}, storage driver ${info.Driver ?? "?"}`,
      df.length > 0
        ? `Disk: ${df.map((row) => `${row.Type}: ${row.Size} (${row.Reclaimable} reclaimable)`).join("; ")}`
        : "Disk: unknown",
      `Compose plugin: ${compose?.version ?? "NOT INSTALLED — docker_compose is unusable until installed"}`,
      `Context: ${process.env.DOCKER_HOST ?? "default socket"}`,
    ];
    if (verbose) {
      const insecure = Object.entries(info.RegistryConfig?.IndexConfigs ?? {})
        .filter(([, config]) => config.Secure === false)
        .map(([host]) => host);
      if (insecure.length > 0) lines.push(`Insecure registries: ${insecure.join(", ")}`);
      if (info.Swarm?.LocalNodeState) lines.push(`Swarm: ${info.Swarm.LocalNodeState}`);
    }
    return ok(lines.join("\n"), {
      serverVersion: info.ServerVersion,
      clientVersion: version?.Client?.Version,
      composeVersion: compose?.version,
      containers: info.Containers,
      running: info.ContainersRunning,
      stopped: Math.max(0, stopped),
      images: info.Images,
      dockerHost: process.env.DOCKER_HOST,
      disk: df,
    });
  },
});

export default factory;