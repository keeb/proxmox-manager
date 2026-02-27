// extensions/models/alpine_overlay.ts
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

// extensions/models/alpine_overlay.ts
var GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname/IP of the VM running Alpine (set via CEL from lookupVm/ensureVmRunning)"),
  sshUser: z.string().default("root").describe("SSH user (default 'root')")
});
var DeployApkovlArgs = z.object({
  tftpHost: z.string().describe("TFTP server IP for apkovl deployment"),
  tftpPath: z.string().describe("TFTP server apkovl directory path")
});
var OverlaySchema = z.object({
  success: z.boolean(),
  vmIp: z.string(),
  hostname: z.string(),
  overlayFile: z.string(),
  tftpHost: z.string(),
  tftpTarget: z.string(),
  timestamp: z.string()
});
var model = {
  type: "@user/alpine/overlay",
  version: "2026.02.11.1",
  resources: {
    "overlay": {
      description: "Overlay deployment result",
      schema: OverlaySchema,
      lifetime: "infinite",
      garbageCollection: 10
    }
  },
  globalArguments: GlobalArgs,
  methods: {
    deployApkovl: {
      description: "Package the Alpine overlay on a VM via lbu and deploy it to the TFTP server",
      arguments: DeployApkovlArgs,
      execute: async (args, context) => {
        const { tftpHost, tftpPath } = args;
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!sshHost) throw new Error("sshHost is required \u2014 run ensureVmRunning first to populate the VM IP");
        if (!tftpHost) throw new Error("tftpHost is required for apkovl deployment");
        if (!tftpPath) throw new Error("tftpPath is required for apkovl deployment");
        console.log(`[deployApkovl] VM: ${sshHost}, TFTP: ${tftpHost}:${tftpPath}`);
        console.log(`[deployApkovl] Step 1: Getting hostname from VM...`);
        const hostnameResult = await sshExec(sshHost, sshUser, "hostname");
        const hostname = hostnameResult.stdout.trim();
        console.log(`[deployApkovl] Hostname: ${hostname}`);
        const overlayFile = `${hostname}.apkovl.tar.gz`;
        const remotePath = `/tmp/${overlayFile}`;
        console.log(`[deployApkovl] Step 2: Packaging overlay via lbu...`);
        await sshExec(sshHost, sshUser, `lbu package ${remotePath}`);
        console.log(`[deployApkovl] Overlay packaged: ${remotePath}`);
        console.log(`[deployApkovl] Step 3: Copying overlay from VM to local /tmp...`);
        const scpDown = new Deno.Command("scp", {
          args: [
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            `${sshUser}@${sshHost}:${remotePath}`,
            `/tmp/${overlayFile}`
          ]
        });
        const scpDownResult = await scpDown.output();
        if (scpDownResult.code !== 0) {
          const err = new TextDecoder().decode(scpDownResult.stderr);
          throw new Error(`SCP from VM failed: ${err}`);
        }
        console.log(`[deployApkovl] Overlay copied to /tmp/${overlayFile}`);
        const tftpTarget = `${tftpPath}/alpine.apkovl.tar.gz`;
        console.log(`[deployApkovl] Step 4: Deploying overlay to TFTP server ${tftpHost}:${tftpTarget}...`);
        const scpUp = new Deno.Command("scp", {
          args: [
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            `/tmp/${overlayFile}`,
            `root@${tftpHost}:${tftpTarget}`
          ]
        });
        const scpUpResult = await scpUp.output();
        if (scpUpResult.code !== 0) {
          const err = new TextDecoder().decode(scpUpResult.stderr);
          throw new Error(`SCP to TFTP server failed: ${err}`);
        }
        console.log(`[deployApkovl] Overlay deployed to ${tftpHost}:${tftpTarget}`);
        try {
          await Deno.remove(`/tmp/${overlayFile}`);
        } catch (_e) {
        }
        console.log(`[deployApkovl] Deployment complete`);
        const handle = await context.writeResource("overlay", "overlay", {
          success: true,
          vmIp: sshHost,
          hostname,
          overlayFile,
          tftpHost,
          tftpTarget,
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
