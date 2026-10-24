/**
 * Extends `@keeb/tailscale/node` with `installDebian` — the base `install`
 * method is Alpine-only (apk/openrc). This one uses Tailscale's official
 * install script (apt + systemd on Debian/Ubuntu), then joins with an auth key.
 */
import { z } from "npm:zod@4";
import { sshExec, isValidSshHost } from "./lib/ssh.ts";

const InstallDebianArgs = z.object({
  vmName: z.string().optional().describe(
    "Fleet VM name (resolves sshHost via CEL)",
  ),
  authKey: z.string().meta({ sensitive: true }).describe(
    "Tailscale auth key for non-interactive login",
  ),
  hostname: z.string().optional().describe(
    "Tailnet machine name (defaults to the OS hostname)",
  ),
});

export const extension = {
  type: "@keeb/tailscale/node",
  methods: [
    {
      installDebian: {
        description:
          "Install Tailscale on a Debian/Ubuntu (systemd) host via the official install script and authenticate",
        arguments: InstallDebianArgs,
        // deno-lint-ignore no-explicit-any
        execute: async (args: any, context: any) => {
          const { authKey, hostname } = args;
          const { sshHost, sshUser = "root" } = context.globalArgs;
          if (!isValidSshHost(sshHost)) {
            throw new Error("sshHost is required — VM must be running with an IP");
          }

          console.log(`[installDebian] Installing Tailscale on ${sshHost}...`);
          await sshExec(
            sshHost,
            sshUser,
            `command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh; systemctl enable --now tailscaled`,
          );

          console.log(`[installDebian] Authenticating with Tailscale...`);
          const hostnameFlag = hostname ? ` --hostname=${hostname}` : "";
          const result = await sshExec(
            sshHost,
            sshUser,
            `tailscale up --authkey=${authKey}${hostnameFlag}`,
          );

          const ipResult = await sshExec(sshHost, sshUser, `tailscale ip -4`);
          const tailscaleIp = ipResult.stdout.trim();
          console.log(`[installDebian] Tailscale IP: ${tailscaleIp}`);

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
  ],
};
