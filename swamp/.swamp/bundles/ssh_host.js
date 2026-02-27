// extensions/models/ssh_host.ts
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
async function sshExecRaw(ip, user, command) {
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
  return {
    code: result.code,
    stdout,
    stderr
  };
}
async function waitForSsh(ip, user, timeoutSeconds = 60, pollInterval = 3) {
  const deadline = Date.now() + timeoutSeconds * 1e3;
  while (Date.now() < deadline) {
    const result = await sshExecRaw(ip, user, "echo ready");
    if (result.code === 0 && result.stdout.trim() === "ready") {
      return true;
    }
    await new Promise((r) => setTimeout(r, pollInterval * 1e3));
  }
  return false;
}

// extensions/models/ssh_host.ts
var SshConnectionArgs = z.object({
  host: z.string().describe("SSH hostname or IP"),
  user: z.string().default("root").describe("SSH user")
});
var ExecArgs = z.object({
  command: z.string().describe("Command to execute"),
  timeout: z.number().default(60).describe("Timeout in seconds")
});
var UploadArgs = z.object({
  source: z.string().describe("Local source path"),
  dest: z.string().describe("Remote destination path")
});
var WaitForConnectionArgs = z.object({
  timeout: z.number().default(60).describe("Timeout in seconds")
});
var ResultSchema = z.object({
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().optional(),
  command: z.string().optional(),
  host: z.string().optional(),
  source: z.string().optional(),
  dest: z.string().optional(),
  connected: z.boolean().optional(),
  success: z.boolean().optional(),
  logs: z.string().optional(),
  timestamp: z.string()
});
var model = {
  type: "@user/ssh/host",
  version: "2026.02.18.1",
  resources: {
    "result": {
      description: "SSH operation result",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10
    }
  },
  globalArguments: SshConnectionArgs,
  methods: {
    exec: {
      description: "Run a command over SSH and return stdout/stderr/exitCode",
      arguments: ExecArgs,
      execute: async (args, context) => {
        const { command } = args;
        const { host, user = "root" } = context.globalArgs;
        const logs = [];
        const log = (msg) => logs.push(msg);
        log(`Running command on ${user}@${host}: ${command.length > 120 ? command.slice(0, 120) + "..." : command}`);
        const result = await sshExec(host, user, command);
        log(`Command completed (stdout: ${result.stdout.length} bytes, stderr: ${result.stderr.length} bytes)`);
        const handle = await context.writeResource("result", "result", {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.code,
          command,
          host,
          logs: logs.join("\n"),
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    upload: {
      description: "Upload files to a remote host via rsync",
      arguments: UploadArgs,
      execute: async (args, context) => {
        const { source, dest } = args;
        const { host, user = "root" } = context.globalArgs;
        const logs = [];
        const log = (msg) => logs.push(msg);
        log(`Uploading ${source} to ${user}@${host}:${dest}`);
        const scp = new Deno.Command("scp", {
          args: [
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-o",
            "ConnectTimeout=10",
            source,
            `${user}@${host}:${dest}`
          ]
        });
        const result = await scp.output();
        if (result.code !== 0) {
          const err = new TextDecoder().decode(result.stderr);
          throw new Error(`scp failed: ${err}`);
        }
        log(`Upload complete`);
        const handle = await context.writeResource("result", "result", {
          source,
          dest,
          host,
          success: true,
          logs: logs.join("\n"),
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    waitForConnection: {
      description: "Poll SSH until the host is reachable",
      arguments: WaitForConnectionArgs,
      execute: async (args, context) => {
        const { timeout = 60 } = args;
        const { host, user = "root" } = context.globalArgs;
        const logs = [];
        const log = (msg) => logs.push(msg);
        log(`Waiting for SSH on ${user}@${host} (up to ${timeout}s)`);
        const connected = await waitForSsh(host, user, timeout);
        if (!connected) {
          throw new Error(`SSH not reachable on ${host} after ${timeout}s`);
        }
        log(`SSH connection established`);
        const handle = await context.writeResource("result", "result", {
          connected: true,
          host,
          logs: logs.join("\n"),
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
