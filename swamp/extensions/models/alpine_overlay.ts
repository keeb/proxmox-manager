import { z } from "npm:zod@4";
import { sshExec } from "./lib/ssh.ts";

const GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname/IP of the VM running Alpine (set via CEL from lookupVm/ensureVmRunning)"),
  sshUser: z.string().default("root").describe("SSH user (default 'root')"),
});

const DeployApkovlArgs = z.object({
  tftpHost: z.string().describe("TFTP server IP for apkovl deployment"),
  tftpPath: z.string().describe("TFTP server apkovl directory path"),
});

const OverlaySchema = z.object({
  success: z.boolean(),
  vmIp: z.string(),
  hostname: z.string(),
  overlayFile: z.string(),
  tftpHost: z.string(),
  tftpTarget: z.string(),
  timestamp: z.string(),
});

export const model = {
  type: "@user/alpine/overlay",
  version: "2026.02.11.1",
  resources: {
    "overlay": {
      description: "Overlay deployment result",
      schema: OverlaySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  globalArguments: GlobalArgs,
  methods: {
    deployApkovl: {
      description: "Package the Alpine overlay on a VM via lbu and deploy it to the TFTP server",
      arguments: DeployApkovlArgs,
      execute: async (args, context) => {
        const { tftpHost, tftpPath } = args;
        const { sshHost, sshUser = "root" } = context.globalArgs;

        if (!sshHost) throw new Error("sshHost is required — run ensureVmRunning first to populate the VM IP");
        if (!tftpHost) throw new Error("tftpHost is required for apkovl deployment");
        if (!tftpPath) throw new Error("tftpPath is required for apkovl deployment");

        console.log(`[deployApkovl] VM: ${sshHost}, TFTP: ${tftpHost}:${tftpPath}`);

        // Step 1: Get hostname from the VM
        console.log(`[deployApkovl] Step 1: Getting hostname from VM...`);
        const hostnameResult = await sshExec(sshHost, sshUser, "hostname");
        const hostname = hostnameResult.stdout.trim();
        console.log(`[deployApkovl] Hostname: ${hostname}`);

        const overlayFile = `${hostname}.apkovl.tar.gz`;
        const remotePath = `/tmp/${overlayFile}`;

        // Step 2: Package overlay via lbu
        console.log(`[deployApkovl] Step 2: Packaging overlay via lbu...`);
        await sshExec(sshHost, sshUser, `lbu package ${remotePath}`);
        console.log(`[deployApkovl] Overlay packaged: ${remotePath}`);

        // Step 3: SCP overlay from VM to local /tmp
        console.log(`[deployApkovl] Step 3: Copying overlay from VM to local /tmp...`);
        // @ts-ignore - Deno API
        const scpDown = new Deno.Command("scp", {
          args: [
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            `${sshUser}@${sshHost}:${remotePath}`,
            `/tmp/${overlayFile}`,
          ],
        });
        const scpDownResult = await scpDown.output();
        if (scpDownResult.code !== 0) {
          const err = new TextDecoder().decode(scpDownResult.stderr);
          throw new Error(`SCP from VM failed: ${err}`);
        }
        console.log(`[deployApkovl] Overlay copied to /tmp/${overlayFile}`);

        // Step 4: SCP overlay from local to TFTP server
        const tftpTarget = `${tftpPath}/alpine.apkovl.tar.gz`;
        console.log(`[deployApkovl] Step 4: Deploying overlay to TFTP server ${tftpHost}:${tftpTarget}...`);
        // @ts-ignore - Deno API
        const scpUp = new Deno.Command("scp", {
          args: [
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            `/tmp/${overlayFile}`,
            `root@${tftpHost}:${tftpTarget}`,
          ],
        });
        const scpUpResult = await scpUp.output();
        if (scpUpResult.code !== 0) {
          const err = new TextDecoder().decode(scpUpResult.stderr);
          throw new Error(`SCP to TFTP server failed: ${err}`);
        }
        console.log(`[deployApkovl] Overlay deployed to ${tftpHost}:${tftpTarget}`);

        // Cleanup local temp file
        try {
          // @ts-ignore - Deno API
          await Deno.remove(`/tmp/${overlayFile}`);
        } catch (_e) {
          // Ignore cleanup errors
        }

        console.log(`[deployApkovl] Deployment complete`);

        const handle = await context.writeResource("overlay", "overlay", {
          success: true,
          vmIp: sshHost,
          hostname,
          overlayFile,
          tftpHost,
          tftpTarget,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
