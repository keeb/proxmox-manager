import { z } from "npm:zod@4";
import { resolveAuth } from "./lib/proxmox.ts";

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

function authOpts() {
  return { modelType: "@user/proxmox/node" };
}

export const model = {
  type: "@user/proxmox/node",
  version: "2026.02.11.2",
  resources: {
    "node": {
      description: "Auth tokens for Proxmox node",
      schema: NodeDataSchema,
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
  },
};
