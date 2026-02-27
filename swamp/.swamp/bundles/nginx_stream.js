// extensions/models/nginx_stream.ts
import { z } from "npm:zod@4";

// extensions/models/lib/ssh.ts
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

// extensions/models/nginx_stream.ts
var GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname for the proxy server"),
  sshUser: z.string().default("keeb").describe("SSH user (default 'keeb')"),
  streamDir: z.string().default("~/stream").describe("Path to stream proxy directory")
});
var ConfigureArgs = z.object({
  vmName: z.string().describe("Service name used for config filename"),
  targetIp: z.string().describe("Tailscale IP of the backend service"),
  portMap: z.string().describe("Port mappings: 'listen:backend[/proto],...' e.g. '25565:25565,7777:7777/udp'")
});
var InitSchema = z.object({
  success: z.boolean(),
  streamDir: z.string(),
  timestamp: z.string()
});
var ProxySchema = z.object({
  success: z.boolean(),
  vmName: z.string(),
  portsAdded: z.array(z.string()),
  configWritten: z.string(),
  timestamp: z.string()
});
function parsePortMap(portMap) {
  return portMap.split(",").map((entry) => {
    const trimmed = entry.trim();
    const protoMatch = trimmed.match(/^(.+)\/(tcp|udp)$/);
    let ports;
    let proto;
    if (protoMatch) {
      ports = protoMatch[1];
      proto = protoMatch[2];
    } else {
      ports = trimmed;
      proto = "tcp";
    }
    const [listen, backend] = ports.split(":");
    return {
      listen,
      backend: backend || listen,
      proto
    };
  });
}
function generateNginxConfig(targetIp, mappings) {
  const blocks = mappings.map(({ listen, backend, proto }) => {
    const listenDirective = proto === "udp" ? `listen ${listen} udp;` : `listen ${listen};`;
    return `server {
    ${listenDirective}
    proxy_pass ${targetIp}:${backend};
}`;
  });
  return blocks.join("\n\n") + "\n";
}
function formatPortLine(listen, proto) {
  if (proto === "udp") {
    return `'${listen}:${listen}/udp'`;
  }
  return `'${listen}:${listen}'`;
}
var model = {
  type: "@user/nginx/stream",
  version: "2026.02.14.1",
  resources: {
    "server": {
      description: "Proxy server init result",
      schema: InitSchema,
      lifetime: "infinite",
      garbageCollection: 10
    },
    "proxy": {
      description: "Proxy configuration result",
      schema: ProxySchema,
      lifetime: "infinite",
      garbageCollection: 10
    }
  },
  globalArguments: GlobalArgs,
  methods: {
    init: {
      description: "Bootstrap nginx stream proxy directory and start container",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { sshHost, sshUser = "keeb", streamDir = "~/stream" } = context.globalArgs;
        console.log(`[init] Bootstrapping stream proxy on ${sshHost} at ${streamDir}`);
        await sshExec(sshHost, sshUser, `mkdir -p ${streamDir}/stream.d`);
        const nginxConf = `worker_processes 1;
events { worker_connections 1024; }
stream { include /stream.d/*.conf; }
`;
        await sshExec(sshHost, sshUser, `cat > ${streamDir}/nginx.conf << 'EOF'
${nginxConf}EOF`);
        const composeYml = `services:
  nginx-proxy:
    image: nginx:alpine
    container_name: stream-proxy
    ports: []
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./stream.d:/stream.d:ro
    restart: unless-stopped
`;
        await sshExec(sshHost, sshUser, `cat > ${streamDir}/docker-compose.yml << 'EOF'
${composeYml}EOF`);
        console.log(`[init] Starting nginx proxy container`);
        await sshExec(sshHost, sshUser, `cd ${streamDir} && docker compose up -d`);
        console.log(`[init] Stream proxy bootstrapped successfully`);
        const handle = await context.writeResource("server", "server", {
          success: true,
          streamDir,
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
      description: "Configure nginx stream proxy for a service",
      arguments: ConfigureArgs,
      execute: async (args, context) => {
        const { vmName, targetIp, portMap } = args;
        const { sshHost, sshUser = "keeb", streamDir = "~/stream" } = context.globalArgs;
        const mappings = parsePortMap(portMap);
        console.log(`[configure] Configuring proxy for ${vmName} -> ${targetIp} (${mappings.length} port mapping(s))`);
        const nginxConfig = generateNginxConfig(targetIp, mappings);
        const confPath = `${streamDir}/stream.d/${vmName}-nginx.conf`;
        console.log(`[configure] Writing nginx config to ${confPath}`);
        await sshExec(sshHost, sshUser, `cat > ${confPath} << 'NGINX_EOF'
${nginxConfig}NGINX_EOF`);
        console.log(`[configure] Reading docker-compose.yml`);
        const composeResult = await sshExec(sshHost, sshUser, `cat ${streamDir}/docker-compose.yml`);
        const composeContent = composeResult.stdout;
        const existingPorts = /* @__PURE__ */ new Set();
        const portLineRegex = /^\s*-\s*['"]?(\d+):(\d+)(?:\/(tcp|udp))?['"]?\s*$/gm;
        let match;
        while ((match = portLineRegex.exec(composeContent)) !== null) {
          const port = match[1];
          const proto = match[3] || "tcp";
          existingPorts.add(`${port}/${proto}`);
        }
        const portsToAdd = [];
        for (const { listen, proto } of mappings) {
          const key = `${listen}/${proto}`;
          if (!existingPorts.has(key)) {
            portsToAdd.push(formatPortLine(listen, proto));
          }
        }
        if (portsToAdd.length > 0) {
          console.log(`[configure] Adding ${portsToAdd.length} new port(s) to docker-compose.yml`);
          const lines = composeContent.split("\n");
          let updatedCompose;
          const emptyPortsIdx = lines.findIndex((l) => /^\s*ports:\s*\[\s*\]\s*$/.test(l));
          if (emptyPortsIdx >= 0) {
            const indent = lines[emptyPortsIdx].match(/^(\s*)/)[1];
            const newPortLines = portsToAdd.map((p) => `${indent}  - ${p}`);
            lines.splice(emptyPortsIdx, 1, `${indent}ports:`, ...newPortLines);
            updatedCompose = lines.join("\n");
          } else {
            let lastPortIdx = -1;
            let portIndent = "      ";
            for (let i = 0; i < lines.length; i++) {
              if (/^\s*-\s*['"]?\d+:\d+/.test(lines[i])) {
                lastPortIdx = i;
                const indentMatch = lines[i].match(/^(\s*)/);
                if (indentMatch) portIndent = indentMatch[1];
              }
            }
            if (lastPortIdx >= 0) {
              const newPortLines = portsToAdd.map((p) => `${portIndent}- ${p}`);
              lines.splice(lastPortIdx + 1, 0, ...newPortLines);
              updatedCompose = lines.join("\n");
            }
          }
          if (updatedCompose) {
            console.log(`[configure] Writing updated docker-compose.yml`);
            await sshExec(sshHost, sshUser, `cat > ${streamDir}/docker-compose.yml << 'COMPOSE_EOF'
${updatedCompose}COMPOSE_EOF`);
          }
        } else {
          console.log(`[configure] All ports already present in docker-compose.yml`);
        }
        console.log(`[configure] Restarting nginx proxy`);
        await sshExec(sshHost, sshUser, `cd ${streamDir} && docker compose up -d`);
        console.log(`[configure] Proxy configured successfully for ${vmName}`);
        const handle = await context.writeResource("proxy", "proxy", {
          success: true,
          vmName,
          portsAdded: portsToAdd,
          configWritten: confPath,
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
