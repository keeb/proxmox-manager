import { z } from "npm:zod@4";
import { sshExec, waitForSsh } from "./lib/ssh.ts";

// Global arguments — SSH connection params shared by every method
const SshConnectionArgs = z.object({
  host: z.string().describe("SSH hostname or IP"),
  user: z.string().default("root").describe("SSH user"),
});

// Per-method argument schemas
const ExecArgs = z.object({
  command: z.string().describe("Command to execute"),
  timeout: z.number().default(60).describe("Timeout in seconds"),
});

const UploadArgs = z.object({
  source: z.string().describe("Local source path"),
  dest: z.string().describe("Remote destination path"),
});

const WaitForConnectionArgs = z.object({
  timeout: z.number().default(60).describe("Timeout in seconds"),
});

const ResultSchema = z.object({
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
  timestamp: z.string(),
});

export const model = {
  type: "@user/ssh/host",
  version: "2026.02.18.1",
  resources: {
    "result": {
      description: "SSH operation result",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
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

        log(`Running command on ${user}@${host}: ${command.length > 120 ? command.slice(0, 120) + '...' : command}`);
        const result = await sshExec(host, user, command);
        log(`Command completed (stdout: ${result.stdout.length} bytes, stderr: ${result.stderr.length} bytes)`);

        const handle = await context.writeResource("result", "result", {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.code,
          command,
          host,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
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

        // @ts-ignore - Deno API
        const scp = new Deno.Command("scp", {
          args: [
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ConnectTimeout=10",
            source,
            `${user}@${host}:${dest}`,
          ],
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
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
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
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
