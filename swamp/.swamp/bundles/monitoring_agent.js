// extensions/models/monitoring_agent.ts
import { z } from "npm:zod@4";

// extensions/models/lib/ssh.ts
function isValidSshHost(host) {
  if (!host) return false;
  if (typeof host !== "string") return false;
  if (host === "null" || host === "undefined") return false;
  return true;
}
async function sshExec(ip, user, command) {
  const proc = new Deno.Command("ssh", {
    args: [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "ConnectTimeout=10",
      `${user}@${ip}`,
      command
    ]
  });
  const result = await proc.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.code !== 0) {
    throw new Error(`SSH command failed (exit ${result.code}): ${stderr.slice(-500)}`);
  }
  return {
    code: result.code,
    stdout,
    stderr
  };
}

// extensions/models/monitoring_agent.ts
var GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname/IP of the target VM"),
  sshUser: z.string().default("root").describe("SSH user (default 'root')")
});
var InstallArgs = z.object({
  vmName: z.string().describe("VM name (used for resource naming)")
});
var ConfigureArgs = z.object({
  vmName: z.string().describe("VM name (used as host label in promtail)"),
  lokiUrl: z.string().describe("Loki push URL (e.g. http://10.0.0.12:3100/loki/api/v1/push)")
});
var InstallSchema = z.object({
  nodeExporterRunning: z.boolean(),
  promtailInstalled: z.boolean(),
  timestamp: z.string()
});
var ConfigSchema = z.object({
  lokiUrl: z.string(),
  promtailConfigured: z.boolean(),
  timestamp: z.string()
});
var TextfileSchema = z.object({
  textfileCollectorEnabled: z.boolean(),
  timestamp: z.string()
});
function promtailConfig(lokiUrl, vmName) {
  return `server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /var/lib/promtail/positions.yaml

clients:
  - url: ${lokiUrl}

scrape_configs:
  - job_name: syslog
    static_configs:
      - targets: [localhost]
        labels:
          host: ${vmName}
          job: syslog
          __path__: /var/log/messages
  - job_name: logs
    static_configs:
      - targets: [localhost]
        labels:
          host: ${vmName}
          job: logs
          __path__: /var/log/*.log
`;
}
var model = {
  type: "@user/monitoring/agent",
  version: "2026.02.17.1",
  resources: {
    "install": {
      description: "Monitoring agent install state",
      schema: InstallSchema,
      lifetime: "infinite",
      garbageCollection: 10
    },
    "config": {
      description: "Monitoring agent configuration state",
      schema: ConfigSchema,
      lifetime: "infinite",
      garbageCollection: 10
    },
    "textfile": {
      description: "Textfile collector setup state",
      schema: TextfileSchema,
      lifetime: "infinite",
      garbageCollection: 10
    }
  },
  globalArguments: GlobalArgs,
  methods: {
    install: {
      description: "Install node-exporter and promtail binary on an Alpine VM (no configuration)",
      arguments: InstallArgs,
      execute: async (args, context) => {
        const { vmName } = args;
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required \u2014 VM must be running with an IP");
        console.log(`[install] Installing monitoring agents on ${sshHost} (${vmName})`);
        console.log(`[install] Enabling Alpine community repo`);
        await sshExec(sshHost, sshUser, `sed -i '/^#.*\\/community$/s/^#//' /etc/apk/repositories && apk update`);
        console.log(`[install] Installing node-exporter`);
        await sshExec(sshHost, sshUser, `apk add prometheus-node-exporter && rc-update add node-exporter default && service node-exporter start`);
        console.log(`[install] Verifying node-exporter on :9100`);
        await sshExec(sshHost, sshUser, `wget -qO /dev/null http://localhost:9100/metrics`);
        console.log(`[install] node-exporter responding`);
        console.log(`[install] Installing promtail via apk`);
        await sshExec(sshHost, sshUser, `apk add loki-promtail loki-promtail-openrc`);
        await sshExec(sshHost, sshUser, `rc-update add loki-promtail default`);
        console.log(`[install] promtail installed (service not started \u2014 no config yet)`);
        const handle = await context.writeResource("install", vmName, {
          nodeExporterRunning: true,
          promtailInstalled: true,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    configure: {
      description: "Configure promtail to push logs to Loki and start the service",
      arguments: ConfigureArgs,
      execute: async (args, context) => {
        const { vmName, lokiUrl } = args;
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required \u2014 VM must be running with an IP");
        console.log(`[configure] Configuring promtail on ${sshHost} (${vmName}) \u2192 ${lokiUrl}`);
        const config = promtailConfig(lokiUrl, vmName);
        await sshExec(sshHost, sshUser, `mkdir -p /etc/loki /var/lib/promtail`);
        await sshExec(sshHost, sshUser, `cat > /etc/loki/promtail-local-config.yaml << 'EOF'
${config}EOF`);
        console.log(`[configure] Wrote /etc/loki/promtail-local-config.yaml`);
        await sshExec(sshHost, sshUser, `docker stop promtail 2>/dev/null || true && docker rm promtail 2>/dev/null || true`);
        await sshExec(sshHost, sshUser, `apk info -e loki-promtail >/dev/null 2>&1 || apk add loki-promtail loki-promtail-openrc`);
        console.log(`[configure] Starting native promtail service`);
        await sshExec(sshHost, sshUser, `rc-update add loki-promtail default 2>/dev/null || true`);
        await sshExec(sshHost, sshUser, `service loki-promtail restart 2>/dev/null || service loki-promtail start`);
        console.log(`[configure] promtail service running`);
        const handle = await context.writeResource("config", vmName, {
          lokiUrl,
          promtailConfigured: true,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    enableTextfileCollector: {
      description: "Enable node-exporter textfile collector for custom .prom metrics (one-time setup)",
      arguments: InstallArgs,
      execute: async (args, context) => {
        const { vmName } = args;
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required \u2014 VM must be running with an IP");
        console.log(`[enableTextfileCollector] Setting up textfile collector on ${sshHost} (${vmName})`);
        await sshExec(sshHost, sshUser, `mkdir -p /var/lib/node_exporter/textfile_collector`);
        console.log(`[enableTextfileCollector] Configuring node-exporter textfile directory`);
        await sshExec(sshHost, sshUser, [
          `grep -q 'textfile.directory' /etc/conf.d/node-exporter 2>/dev/null`,
          `|| echo 'ARGS="--collector.textfile.directory=/var/lib/node_exporter/textfile_collector"' >> /etc/conf.d/node-exporter`
        ].join(" "));
        console.log(`[enableTextfileCollector] Restarting node-exporter`);
        await sshExec(sshHost, sshUser, `service node-exporter restart`);
        await sshExec(sshHost, sshUser, `wget -qO- http://localhost:9100/metrics | grep -q 'node_textfile_scrape_error' && echo ok`);
        console.log(`[enableTextfileCollector] Textfile collector enabled`);
        const handle = await context.writeResource("textfile", vmName, {
          textfileCollectorEnabled: true,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    }
  }
};
export {
  model
};
