import { z } from "npm:zod@4";
import { resolveAuth, fetchWithCurl } from "./lib/proxmox.ts";

const GlobalArgs = z.object({
  apiUrl: z.string().describe("Proxmox API base URL (e.g., https://10.0.0.4:8006)"),
  username: z.string().optional().describe("Proxmox username for authentication"),
  password: z.string().optional().describe("Proxmox password for authentication"),
  realm: z.string().default("pam").describe("Authentication realm (pam, pve, etc.)"),
  node: z.string().describe("Proxmox node name"),
  skipTlsVerify: z.boolean().default(true).describe("Skip TLS certificate verification"),
});

const NodeDataSchema = z.object({
  ticket: z.string(),
  csrfToken: z.string(),
  username: z.string(),
  logs: z.string().optional(),
  timestamp: z.string(),
});

const NodeStatusSchema = z.object({
  memoryTotal: z.number().describe("Total memory in bytes"),
  memoryUsed: z.number().describe("Used memory in bytes"),
  memoryFree: z.number().describe("Free memory in bytes"),
  cpuUsage: z.number().describe("CPU usage (0-1)"),
  cpuCount: z.number().describe("Number of logical CPUs"),
  uptime: z.number().describe("Node uptime in seconds"),
  timestamp: z.string(),
});

function authOpts() {
  return { modelType: "@user/proxmox/node" };
}

export const model = {
  type: "@user/proxmox/node",
  version: "2026.02.18.1",
  resources: {
    "node": {
      description: "Auth tokens for Proxmox node",
      schema: NodeDataSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "status": {
      description: "Node resource usage (memory, CPU, uptime)",
      schema: NodeStatusSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
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
        const auth = await resolveAuth(context.globalArgs, context, { ...authOpts(), skipCache: true });
        log(`Authentication successful (source: ${auth.source})`);

        const handle = await context.writeResource("node", "node", {
          ticket: auth.ticket, csrfToken: auth.csrfToken,
          username: auth.username,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        }, { lifetime: "2h" });
        return { dataHandles: [handle] };
      },
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
            "CSRFPreventionToken": auth.csrfToken,
          },
          skipTlsVerify,
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
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
