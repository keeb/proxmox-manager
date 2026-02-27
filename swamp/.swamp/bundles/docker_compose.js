// extensions/models/docker_compose.ts
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

// extensions/models/docker_compose.ts
var GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname or IP address"),
  sshUser: z.string().default("root").describe("SSH user (default 'root')"),
  composePath: z.string().describe("Path to docker-compose directory on remote host"),
  serviceName: z.string().optional().describe("Specific service name (optional, operates on all services if omitted)")
});
var ResultSchema = z.object({
  success: z.boolean(),
  output: z.string().optional(),
  timestamp: z.string()
});
function composeCmd(path, serviceName, action) {
  const svc = serviceName ? ` ${serviceName}` : "";
  return `cd ${path} && docker compose ${action}${svc}`;
}
var model = {
  type: "@user/docker/compose",
  version: "2026.02.11.1",
  resources: {
    "result": {
      description: "Docker compose operation result",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10
    }
  },
  globalArguments: GlobalArgs,
  methods: {
    start: {
      description: "Start Docker Compose services",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", composePath, serviceName } = context.globalArgs;
        const cmd = composeCmd(composePath, serviceName, "up -d");
        console.log(`[start] Starting services at ${sshHost}:${composePath}`);
        const result = await sshExec(sshHost, sshUser, cmd);
        console.log(`[start] Services started successfully`);
        const handle = await context.writeResource("result", "result", {
          success: true,
          output: result.stdout || result.stderr,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    stop: {
      description: "Stop Docker Compose services",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", composePath, serviceName } = context.globalArgs;
        const cmd = composeCmd(composePath, serviceName, "down") + " && sleep 3";
        console.log(`[stop] Stopping services at ${sshHost}:${composePath}`);
        const result = await sshExec(sshHost, sshUser, cmd);
        console.log(`[stop] Services stopped successfully`);
        const handle = await context.writeResource("result", "result", {
          success: true,
          output: result.stdout || result.stderr,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    update: {
      description: "Pull latest images and restart Docker Compose services",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", composePath, serviceName } = context.globalArgs;
        const svc = serviceName ? ` ${serviceName}` : "";
        const cmd = `cd ${composePath} && docker compose pull${svc} && docker compose up -d${svc}`;
        console.log(`[update] Updating services at ${sshHost}:${composePath}`);
        const result = await sshExec(sshHost, sshUser, cmd);
        console.log(`[update] Services updated successfully`);
        const handle = await context.writeResource("result", "result", {
          success: true,
          output: result.stdout || result.stderr,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    status: {
      description: "Show Docker Compose service status",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", composePath, serviceName } = context.globalArgs;
        const cmd = composeCmd(composePath, serviceName, "ps");
        console.log(`[status] Checking services at ${sshHost}:${composePath}`);
        const result = await sshExec(sshHost, sshUser, cmd);
        console.log(`[status] Service status:
${result.stdout}`);
        const handle = await context.writeResource("result", "result", {
          success: true,
          output: result.stdout,
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
