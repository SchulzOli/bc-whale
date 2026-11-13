import type { Target } from "./config.js";
import { inspectContainer, loadContainerCredential } from "./docker.js";

export interface Connection {
  /** altool connection arguments (--server, --environmentname, ...). */
  args: string[];
  /** Environment for the altool process (credentials are passed here, never as args). */
  env: Record<string, string>;
  /** Equivalent launch.json configuration fields. */
  launch: Record<string, unknown>;
  summary: string;
  company?: string;
}

export async function resolveConnection(target: Target, signal?: AbortSignal): Promise<Connection> {
  signal?.throwIfAborted();
  switch (target.type) {
    case "cloud": {
      const args = ["--environmenttype", target.environmentType ?? "Sandbox", "--environmentname", target.environmentName];
      if (target.tenant) args.push("--tenant", target.tenant);
      return {
        args,
        env: {},
        launch: {
          environmentType: target.environmentType ?? "Sandbox",
          environmentName: target.environmentName,
          ...(target.tenant ? { tenant: target.tenant } : {}),
        },
        summary: `BC Online ${target.environmentType ?? "Sandbox"} '${target.environmentName}'${target.tenant ? ` (tenant ${target.tenant})` : ""}`,
        company: target.company,
      };
    }
    case "onprem": {
      const auth = target.authentication ?? "UserPassword";
      const args = ["--server", target.server, "--serverinstance", target.serverInstance ?? "BC", "--environmenttype", "OnPrem", "--authentication", auth];
      if (target.port) args.push("--port", String(target.port));
      if (target.tenant) args.push("--tenant", target.tenant);
      const env: Record<string, string> = {};
      if (auth === "UserPassword") {
        const pw = target.passwordEnv ? process.env[target.passwordEnv] : process.env.BC_SERVER_PASSWORD;
        const user = target.username ?? process.env.BC_SERVER_USERNAME;
        if (!user || !pw) throw new Error(`Target needs credentials: set username and the env var '${target.passwordEnv ?? "BC_SERVER_PASSWORD"}'.`);
        env.BC_SERVER_USERNAME = user;
        env.BC_SERVER_PASSWORD = pw;
      }
      return {
        args,
        env,
        launch: {
          server: target.server,
          serverInstance: target.serverInstance ?? "BC",
          authentication: auth,
          environmentType: "OnPrem",
          ...(target.port ? { port: target.port } : {}),
          ...(target.tenant ? { tenant: target.tenant } : {}),
        },
        summary: `${target.server}/${target.serverInstance ?? "BC"} (${auth})`,
        company: target.company,
      };
    }
    case "docker": {
      const info = await inspectContainer(target.container, signal);
      if (!info.running) throw new Error(`Container '${target.container}' is not running (${info.status}). Start it with 'bc-whale container start ${target.container}'.`);
      // SSL containers use a certificate issued for the container name (hosts entry required); plain HTTP works via IP.
      const host = info.useSSL ? `https://${info.name}` : `http://${info.ip}`;
      const isWindows = (info.auth ?? "").toLowerCase() === "windows";
      const auth = isWindows ? "Windows" : "UserPassword";
      const env: Record<string, string> = {};
      if (!isWindows) {
        const cred = await loadContainerCredential(info.name, signal);
        const user = cred?.username ?? process.env.BC_SERVER_USERNAME ?? info.username;
        const pw = cred?.password ?? process.env.BC_SERVER_PASSWORD;
        if (!user || !pw) throw new Error(`No stored credential for container '${info.name}'. Set BC_SERVER_USERNAME/BC_SERVER_PASSWORD or run 'bc-whale container credential ${info.name}'.`);
        env.BC_SERVER_USERNAME = user;
        env.BC_SERVER_PASSWORD = pw;
      }
      return {
        args: ["--server", host, "--serverinstance", "BC", "--environmenttype", "OnPrem", "--authentication", auth],
        env,
        launch: { server: host, serverInstance: "BC", authentication: auth, environmentType: "OnPrem" },
        summary: `container ${info.name} (${host}, BC ${info.bcVersion ?? "?"} ${info.country ?? ""}, ${auth})`,
        company: target.company,
      };
    }
  }
}
