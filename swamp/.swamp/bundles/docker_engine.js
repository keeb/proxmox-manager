// extensions/models/docker_engine.ts
import { z } from "npm:zod@4";

// extensions/models/lib/ssh.ts
function isValidSshHost(host) {
  if (!host) return false;
  if (typeof host !== "string") return false;
  if (host === "null" || host === "undefined") return false;
  return true;
}
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

// extensions/models/docker_engine.ts
var GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname/IP of the target VM"),
  sshUser: z.string().default("root").describe("SSH user (default 'root')")
});
var ResultSchema = z.object({
  success: z.boolean(),
  logs: z.string().optional(),
  timestamp: z.string()
});
var ImageSchema = z.object({
  imageTag: z.string(),
  context: z.string(),
  logs: z.string().optional(),
  timestamp: z.string()
});
var ContainerSchema = z.object({
  containerName: z.string(),
  imageTag: z.string(),
  running: z.boolean(),
  containerId: z.string().optional(),
  logs: z.string().optional(),
  timestamp: z.string()
});
var model = {
  type: "@user/docker/engine",
  version: "2026.02.11.2",
  resources: {
    "result": {
      description: "Docker engine operation result",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10
    },
    "image": {
      description: "Docker image build result",
      schema: ImageSchema,
      lifetime: "infinite",
      garbageCollection: 5
    },
    "container": {
      description: "Docker container state",
      schema: ContainerSchema,
      lifetime: "infinite",
      garbageCollection: 10
    }
  },
  globalArguments: GlobalArgs,
  methods: {
    install: {
      description: "Install Docker Engine on an Alpine VM via SSH",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required \u2014 VM must be running with an IP");
        const logs = [];
        const log = (msg) => logs.push(msg);
        log(`Installing Docker on ${sshHost}`);
        const result = await sshExec(sshHost, sshUser, `apk add docker && rc-update add docker default && service docker start`);
        log(`Docker installed and started`);
        log(result.stdout || result.stderr);
        const handle = await context.writeResource("result", "result", {
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
    build: {
      description: "Build a Docker image on the remote host",
      arguments: z.object({
        imageTag: z.string().describe("Tag for the built image"),
        contextPath: z.string().describe("Build context path on remote host"),
        dockerfilePath: z.string().optional().describe("Path to Dockerfile (relative to context)")
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required \u2014 VM must be running with an IP");
        const { imageTag, contextPath } = args;
        const dfFlag = args.dockerfilePath ? ` -f ${args.dockerfilePath}` : "";
        const logs = [];
        const log = (msg) => logs.push(msg);
        log(`Building image '${imageTag}' on ${sshHost} (context: ${contextPath})`);
        const result = await sshExec(sshHost, sshUser, `docker build -t ${imageTag}${dfFlag} ${contextPath}`);
        log(`Image '${imageTag}' built`);
        log((result.stdout || result.stderr).trim());
        const handle = await context.writeResource("image", imageTag, {
          imageTag,
          context: contextPath,
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
    run: {
      description: "Run a Docker container (stops existing container with same name first)",
      arguments: z.object({
        containerName: z.string().describe("Name for the container"),
        imageTag: z.string().describe("Image to run"),
        ports: z.union([
          z.array(z.string()),
          z.string()
        ]).optional().describe("Port mappings (e.g. ['8080:8080'])"),
        volumes: z.union([
          z.array(z.string()),
          z.string()
        ]).optional().describe("Volume mounts"),
        env: z.string().optional().describe("Environment variables as JSON object string"),
        envFile: z.string().optional().describe("Path to env file on remote host"),
        restart: z.string().optional().describe("Restart policy (e.g. 'unless-stopped')"),
        command: z.string().optional().describe("Command to run in the container")
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required \u2014 VM must be running with an IP");
        const { containerName, imageTag } = args;
        const parsedPorts = args.ports ? typeof args.ports === "string" ? JSON.parse(args.ports) : args.ports : [];
        const parsedVolumes = args.volumes ? typeof args.volumes === "string" ? JSON.parse(args.volumes) : args.volumes : [];
        const parsedEnv = args.env ? JSON.parse(args.env) : null;
        const logs = [];
        const log = (msg) => logs.push(msg);
        log(`Stopping old container '${containerName}' if it exists`);
        await sshExecRaw(sshHost, sshUser, `docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null; true`);
        let envFilePath = args.envFile;
        if (parsedEnv && !envFilePath) {
          envFilePath = `/tmp/${containerName}.env`;
          const envLines = Object.entries(parsedEnv).map(([k, v]) => `${k}=${v}`).join("\\n");
          log(`Writing env file to ${envFilePath}`);
          await sshExec(sshHost, sshUser, `printf '${envLines}\\n' > ${envFilePath}`);
        }
        const runArgs = [
          "docker",
          "run",
          "-d",
          "--name",
          containerName
        ];
        if (args.restart) runArgs.push("--restart", args.restart);
        for (const p of parsedPorts) runArgs.push("-p", p);
        for (const v of parsedVolumes) runArgs.push("-v", v);
        if (envFilePath) runArgs.push("--env-file", envFilePath);
        runArgs.push(imageTag);
        if (args.command) runArgs.push(args.command);
        log(`Starting container '${containerName}' with image '${imageTag}'`);
        log(`Command: ${runArgs.join(" ")}`);
        const result = await sshExec(sshHost, sshUser, runArgs.join(" "));
        const containerId = result.stdout.trim();
        log(`Container '${containerName}' running (${containerId.slice(0, 12)})`);
        const handle = await context.writeResource("container", containerName, {
          containerName,
          imageTag,
          running: true,
          containerId,
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
    stop: {
      description: "Stop and remove a Docker container (idempotent)",
      arguments: z.object({
        containerName: z.string().describe("Name of the container to stop")
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required \u2014 VM must be running with an IP");
        const { containerName } = args;
        const logs = [];
        const log = (msg) => logs.push(msg);
        log(`Stopping container '${containerName}' on ${sshHost}`);
        await sshExecRaw(sshHost, sshUser, `docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null; true`);
        log(`Container '${containerName}' stopped`);
        const handle = await context.writeResource("container", containerName, {
          containerName,
          imageTag: "",
          running: false,
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
    inspect: {
      description: "Inspect a Docker container",
      arguments: z.object({
        containerName: z.string().describe("Name of the container to inspect")
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required \u2014 VM must be running with an IP");
        const { containerName } = args;
        const logs = [];
        const log = (msg) => logs.push(msg);
        log(`Inspecting container '${containerName}' on ${sshHost}`);
        const result = await sshExecRaw(sshHost, sshUser, `docker inspect --format '{{.State.Running}} {{.Id}} {{.Config.Image}}' ${containerName} 2>/dev/null`);
        if (result.code !== 0) {
          log(`Container '${containerName}' not found`);
          const handle2 = await context.writeResource("container", containerName, {
            containerName,
            imageTag: "",
            running: false,
            logs: logs.join("\n"),
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        const parts = result.stdout.trim().split(" ");
        const running = parts[0] === "true";
        const containerId = parts[1] || "";
        const imageTag = parts[2] || "";
        log(`Container '${containerName}': running=${running}, id=${containerId.slice(0, 12)}, image=${imageTag}`);
        const handle = await context.writeResource("container", containerName, {
          containerName,
          imageTag,
          running,
          containerId,
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
    exec: {
      description: "Execute a command inside a running Docker container",
      arguments: z.object({
        containerName: z.string().describe("Name of the container"),
        command: z.string().describe("Command to execute"),
        workdir: z.string().optional().describe("Working directory inside the container")
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required \u2014 VM must be running with an IP");
        const { containerName, command } = args;
        const wdFlag = args.workdir ? ` -w ${args.workdir}` : "";
        const logs = [];
        const log = (msg) => logs.push(msg);
        log(`Running command in '${containerName}' on ${sshHost}: ${command}`);
        const result = await sshExec(sshHost, sshUser, `docker exec${wdFlag} ${containerName} ${command}`);
        log(`Command completed`);
        log((result.stdout || result.stderr).trim());
        const handle = await context.writeResource("result", "result", {
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
    }
  }
};
export {
  model
};
