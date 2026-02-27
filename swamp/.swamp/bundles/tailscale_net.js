// extensions/models/tailscale_net.ts
import { z } from "npm:zod@4";
var MachineSchema = z.object({
  hostname: z.string(),
  dnsName: z.string(),
  tailscaleIp: z.string(),
  online: z.boolean(),
  os: z.string(),
  lastSeen: z.string(),
  timestamp: z.string()
});
var SyncArgs = z.object({
  statusJson: z.string().describe("Raw JSON output from tailscale status --json")
});
var model = {
  type: "@user/tailscale/net",
  version: "2026.02.14.2",
  resources: {
    "machine": {
      description: "Tailnet machine",
      schema: MachineSchema,
      lifetime: "infinite",
      garbageCollection: 10
    }
  },
  methods: {
    sync: {
      description: "Parse tailscale status JSON and write a named resource per machine",
      arguments: SyncArgs,
      execute: async (args, context) => {
        const status = JSON.parse(args.statusJson);
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const handles = [];
        const peers = [];
        if (status.Self) {
          peers.push(status.Self);
        }
        if (status.Peer) {
          for (const peer of Object.values(status.Peer)) {
            peers.push(peer);
          }
        }
        for (const peer of peers) {
          const hostname = (peer.HostName || "").toLowerCase();
          if (!hostname) continue;
          const dnsName = peer.DNSName || "";
          const resourceName = dnsName.split(".")[0] || hostname;
          const ips = peer.TailscaleIPs || [];
          const ipv4 = ips.find((ip) => ip.includes(".")) || ips[0] || "";
          const data = {
            hostname,
            dnsName,
            tailscaleIp: ipv4,
            online: peer.Online === true,
            os: peer.OS || "",
            lastSeen: peer.LastSeen || "",
            timestamp: now
          };
          console.log(`[sync]   ${resourceName} ip=${ipv4} online=${data.online}`);
          const handle = await context.writeResource("machine", resourceName, data);
          handles.push(handle);
        }
        console.log(`[sync] Complete: ${handles.length} machines synced`);
        return {
          dataHandles: handles
        };
      }
    }
  }
};
export {
  model
};
