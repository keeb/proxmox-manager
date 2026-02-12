import { z } from "npm:zod@4";
import { sshExec } from "./lib/ssh.ts";

const GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname for the proxy server"),
  sshUser: z.string().default("keeb").describe("SSH user (default 'keeb')"),
  streamDir: z.string().default("~/stream").describe("Path to stream proxy directory"),
});

const ConfigureArgs = z.object({
  vmName: z.string().describe("Service name used for config filename"),
  targetIp: z.string().describe("Tailscale IP of the backend service"),
  portMap: z.string().describe("Port mappings: 'listen:backend[/proto],...' e.g. '25565:25565,7777:7777/udp'"),
});

const ProxySchema = z.object({
  success: z.boolean(),
  vmName: z.string(),
  portsAdded: z.array(z.string()),
  configWritten: z.string(),
  timestamp: z.string(),
});

function parsePortMap(portMap) {
  return portMap.split(",").map((entry) => {
    const trimmed = entry.trim();
    // Format: listen:backend[/proto]
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
    return { listen, backend: backend || listen, proto };
  });
}

function generateNginxConfig(targetIp, mappings) {
  const blocks = mappings.map(({ listen, backend, proto }) => {
    const listenDirective = proto === "udp" ? `listen ${listen} udp;` : `listen ${listen};`;
    return `server {\n    ${listenDirective}\n    proxy_pass ${targetIp}:${backend};\n}`;
  });
  return blocks.join("\n\n") + "\n";
}

function formatPortLine(listen, proto) {
  if (proto === "udp") {
    return `'${listen}:${listen}/udp'`;
  }
  return `'${listen}:${listen}'`;
}

export const model = {
  type: "@user/nginx/stream",
  version: "2026.02.11.1",
  resources: {
    "proxy": {
      description: "Proxy configuration result",
      schema: ProxySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  globalArguments: GlobalArgs,
  methods: {
    configure: {
      description: "Configure nginx stream proxy for a service",
      arguments: ConfigureArgs,
      execute: async (args, context) => {
        const { vmName, targetIp, portMap } = args;
        const { sshHost, sshUser = "keeb", streamDir = "~/stream" } = context.globalArgs;

        const mappings = parsePortMap(portMap);
        console.log(`[configure] Configuring proxy for ${vmName} -> ${targetIp} (${mappings.length} port mapping(s))`);

        // 1. Generate and write nginx stream config
        const nginxConfig = generateNginxConfig(targetIp, mappings);
        const confPath = `${streamDir}/stream.d/${vmName}-nginx.conf`;
        console.log(`[configure] Writing nginx config to ${confPath}`);

        await sshExec(sshHost, sshUser, `cat > ${confPath} << 'NGINX_EOF'\n${nginxConfig}NGINX_EOF`);

        // 2. Read current docker-compose.yml
        console.log(`[configure] Reading docker-compose.yml`);
        const composeResult = await sshExec(sshHost, sshUser, `cat ${streamDir}/docker-compose.yml`);
        const composeContent = composeResult.stdout;

        // 3. Add missing ports to docker-compose.yml
        const existingPorts = new Set();
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

          // Find the last port line and its indentation
          const lines = composeContent.split("\n");
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
            const updatedCompose = lines.join("\n");

            console.log(`[configure] Writing updated docker-compose.yml`);
            await sshExec(sshHost, sshUser, `cat > ${streamDir}/docker-compose.yml << 'COMPOSE_EOF'\n${updatedCompose}COMPOSE_EOF`);
          }
        } else {
          console.log(`[configure] All ports already present in docker-compose.yml`);
        }

        // 4. Restart nginx
        console.log(`[configure] Restarting nginx proxy`);
        await sshExec(sshHost, sshUser, `cd ${streamDir} && docker compose up -d`);

        console.log(`[configure] Proxy configured successfully for ${vmName}`);
        const handle = await context.writeResource("proxy", "proxy", {
          success: true,
          vmName,
          portsAdded: portsToAdd,
          configWritten: confPath,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
