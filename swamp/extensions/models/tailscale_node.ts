import { z } from "npm:zod@4";
import { sshExec } from "./lib/ssh.ts";

const GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname/IP of the target VM (set via CEL from testVm)"),
  sshUser: z.string().default("root").describe("SSH user (default 'root')"),
});

const InstallArgs = z.object({
  authKey: z.string().describe("Tailscale auth key for non-interactive login"),
});

const ResultSchema = z.object({
  success: z.boolean(),
  tailscaleIp: z.string(),
  output: z.string().optional(),
  timestamp: z.string(),
});

export const model = {
  type: "@user/tailscale/node",
  version: "2026.02.11.1",
  resources: {
    "result": {
      description: "Tailscale install result",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  globalArguments: GlobalArgs,
  methods: {
    install: {
      description: "Install Tailscale on an Alpine VM, start the daemon, and authenticate",
      arguments: InstallArgs,
      execute: async (args, context) => {
        const { authKey } = args;
        const { sshHost, sshUser = "root" } = context.globalArgs;

        if (!sshHost) throw new Error("sshHost is required — VM must be running with an IP");
        if (!authKey) throw new Error("authKey is required for non-interactive tailscale up");

        console.log(`[install] Installing Tailscale on ${sshHost}...`);
        await sshExec(sshHost, sshUser, `apk add tailscale && rc-update add tailscale default && service tailscale start`);
        console.log(`[install] Tailscale installed and daemon started`);

        console.log(`[install] Authenticating with Tailscale...`);
        const result = await sshExec(sshHost, sshUser, `tailscale up --authkey=${authKey}`);
        console.log(`[install] Tailscale authenticated`);

        console.log(`[install] Getting Tailscale IP...`);
        const ipResult = await sshExec(sshHost, sshUser, `tailscale ip -4`);
        const tailscaleIp = ipResult.stdout.trim();
        console.log(`[install] Tailscale IP: ${tailscaleIp}`);

        const handle = await context.writeResource("result", "result", {
          success: true,
          tailscaleIp,
          output: result.stdout || result.stderr,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
