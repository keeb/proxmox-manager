// extensions/models/proxmox_node.ts
import { z } from "npm:zod@4";

// extensions/models/lib/proxmox.ts
async function fetchWithCurl(url, options) {
  const { method = "GET", headers = {}, body, skipTlsVerify } = options;
  const args = [
    "-s",
    "-S"
  ];
  if (skipTlsVerify) {
    args.push("-k");
  }
  args.push("-X", method);
  for (const [key, value] of Object.entries(headers)) {
    args.push("-H", `${key}: ${value}`);
  }
  if (body) {
    args.push("-d", body);
  }
  args.push("-i");
  args.push(url);
  const command = new Deno.Command("curl", {
    args
  });
  const { code, stdout, stderr } = await command.output();
  if (code !== 0) {
    const errorText = new TextDecoder().decode(stderr);
    throw new Error(`curl failed with code ${code}: ${errorText}`);
  }
  const output = new TextDecoder().decode(stdout);
  const headerEndIndex = output.indexOf("\r\n\r\n");
  const headersText = output.substring(0, headerEndIndex);
  const bodyText = output.substring(headerEndIndex + 4);
  const statusLine = headersText.split("\r\n")[0];
  const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1]) : 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: statusLine,
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText)
  };
}
var AUTH_TTL_MS = 2 * 60 * 60 * 1e3;
async function resolveAuth(globalArgs, context, opts = {}) {
  const { apiUrl, skipTlsVerify } = globalArgs;
  const { ticket: explicitTicket, csrfToken: explicitCsrf } = globalArgs;
  if (explicitTicket && explicitCsrf) {
    return {
      ticket: explicitTicket,
      csrfToken: explicitCsrf,
      source: "explicit",
      freshAuth: false
    };
  }
  if (!opts.skipCache) {
    try {
      const modelType = opts.modelType || "@user/proxmox/api";
      const defId = context.definition.id;
      const authDir = `${context.repoDir}/.swamp/data/${modelType}/${defId}/auth`;
      const entries = [];
      for await (const entry of Deno.readDir(authDir)) {
        if (entry.isDirectory) entries.push(entry);
      }
      if (entries.length > 0) {
        const versions = entries.map((e) => parseInt(e.name, 10)).filter((n) => !isNaN(n));
        const latest = Math.max(...versions);
        const rawPath = `${authDir}/${latest}/raw`;
        const metaPath = `${authDir}/${latest}/metadata.yaml`;
        const metaText = await Deno.readTextFile(metaPath);
        const createdAtMatch = metaText.match(/createdAt:\s*'([^']+)'/);
        if (createdAtMatch) {
          const createdAt = new Date(createdAtMatch[1]);
          const ageMs = Date.now() - createdAt.getTime();
          if (ageMs < AUTH_TTL_MS) {
            const rawText = await Deno.readTextFile(rawPath);
            const cached = JSON.parse(rawText);
            return {
              ticket: cached.ticket,
              csrfToken: cached.csrfToken,
              source: "cache",
              freshAuth: false
            };
          }
        }
      }
    } catch (_e) {
    }
  }
  const { username, password, realm } = globalArgs;
  if (!username || !password) {
    throw new Error("No auth available: no explicit ticket, no valid cached auth, and no username/password. Run 'swamp workflow run sync-proxmox-vms --json' to authenticate via vault.");
  }
  const authUrl = `${apiUrl}/api2/json/access/ticket`;
  const formData = new URLSearchParams();
  formData.append("username", `${username}@${realm || "pam"}`);
  formData.append("password", password);
  const response = await fetchWithCurl(authUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: formData.toString(),
    skipTlsVerify: skipTlsVerify ?? true
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Authentication failed: ${response.status} ${response.statusText} - ${errorText}`);
  }
  const result = await response.json();
  const { ticket, CSRFPreventionToken } = result.data;
  return {
    ticket,
    csrfToken: CSRFPreventionToken,
    username: `${username}@${realm || "pam"}`,
    source: "password",
    freshAuth: true
  };
}

// extensions/models/proxmox_node.ts
var GlobalArgs = z.object({
  apiUrl: z.string().describe("Proxmox API base URL (e.g., https://10.0.0.4:8006)"),
  username: z.string().optional().describe("Proxmox username for authentication"),
  password: z.string().optional().describe("Proxmox password for authentication"),
  realm: z.string().default("pam").describe("Authentication realm (pam, pve, etc.)"),
  node: z.string().describe("Proxmox node name"),
  skipTlsVerify: z.boolean().default(true).describe("Skip TLS certificate verification")
});
var NodeDataSchema = z.object({
  ticket: z.string(),
  csrfToken: z.string(),
  username: z.string(),
  logs: z.string().optional(),
  timestamp: z.string()
});
var NodeStatusSchema = z.object({
  memoryTotal: z.number().describe("Total memory in bytes"),
  memoryUsed: z.number().describe("Used memory in bytes"),
  memoryFree: z.number().describe("Free memory in bytes"),
  cpuUsage: z.number().describe("CPU usage (0-1)"),
  cpuCount: z.number().describe("Number of logical CPUs"),
  uptime: z.number().describe("Node uptime in seconds"),
  timestamp: z.string()
});
function authOpts() {
  return {
    modelType: "@user/proxmox/node"
  };
}
var model = {
  type: "@user/proxmox/node",
  version: "2026.02.18.1",
  resources: {
    "node": {
      description: "Auth tokens for Proxmox node",
      schema: NodeDataSchema,
      lifetime: "infinite",
      garbageCollection: 10
    },
    "status": {
      description: "Node resource usage (memory, CPU, uptime)",
      schema: NodeStatusSchema,
      lifetime: "infinite",
      garbageCollection: 10
    }
  },
  globalArguments: GlobalArgs,
  methods: {
    auth: {
      description: "Authenticate with Proxmox and return ticket/csrfToken",
      arguments: z.object({}),
      execute: async (args, context) => {
        const logs = [];
        const log = (msg) => logs.push(msg);
        log(`Authenticating with Proxmox at ${context.globalArgs.apiUrl}`);
        const auth = await resolveAuth(context.globalArgs, context, {
          ...authOpts(),
          skipCache: true
        });
        log(`Authentication successful (source: ${auth.source})`);
        const handle = await context.writeResource("node", "node", {
          ticket: auth.ticket,
          csrfToken: auth.csrfToken,
          username: auth.username,
          logs: logs.join("\n"),
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        }, {
          lifetime: "2h"
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    status: {
      description: "Fetch current node resource usage (memory, CPU, uptime)",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { apiUrl, node, skipTlsVerify } = context.globalArgs;
        const auth = await resolveAuth(context.globalArgs, context, authOpts());
        const response = await fetchWithCurl(`${apiUrl}/api2/json/nodes/${node}/status`, {
          method: "GET",
          headers: {
            "Cookie": `PVEAuthCookie=${auth.ticket}`,
            "CSRFPreventionToken": auth.csrfToken
          },
          skipTlsVerify
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch node status: ${response.status}`);
        }
        const result = await response.json();
        const d = result.data;
        const handle = await context.writeResource("status", "status", {
          memoryTotal: d.memory.total,
          memoryUsed: d.memory.used,
          memoryFree: d.memory.total - d.memory.used,
          cpuUsage: d.cpu,
          cpuCount: d.cpuinfo.cpus,
          uptime: d.uptime,
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
