// extensions/models/minecraft_installer.ts
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

// extensions/models/minecraft_installer.ts
var GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname/IP (set via CEL from fleet)"),
  sshUser: z.string().default("root").describe("SSH user")
});
var DepsSchema = z.object({
  packages: z.string(),
  javaVersion: z.string().optional(),
  timestamp: z.string()
});
var UploadSchema = z.object({
  localPath: z.string(),
  remotePath: z.string(),
  timestamp: z.string()
});
var ServerSchema = z.object({
  modloader: z.string().optional(),
  mcVersion: z.string().optional(),
  modloaderVersion: z.string().optional(),
  startScript: z.string(),
  serverDir: z.string(),
  logPath: z.string(),
  timestamp: z.string()
});
var ConfigSchema = z.object({
  jvmMemory: z.string(),
  eulaAccepted: z.boolean(),
  timestamp: z.string()
});
var model = {
  type: "@user/minecraft/installer",
  version: "2026.02.16.1",
  resources: {
    "deps": {
      description: "Package install result",
      schema: DepsSchema,
      lifetime: "infinite",
      garbageCollection: 5
    },
    "upload": {
      description: "Server pack upload result",
      schema: UploadSchema,
      lifetime: "infinite",
      garbageCollection: 5
    },
    "server": {
      description: "Discovered server config (modloader, start script, paths)",
      schema: ServerSchema,
      lifetime: "infinite",
      garbageCollection: 5
    },
    "config": {
      description: "Server configuration result (JVM, EULA)",
      schema: ConfigSchema,
      lifetime: "infinite",
      garbageCollection: 5
    }
  },
  globalArguments: GlobalArgs,
  methods: {
    installDeps: {
      description: "Install required packages (JDK, tmux, bash, curl, unzip) on the VM",
      arguments: z.object({
        vmName: z.string().describe("VM name (used as resource instance name)")
      }),
      execute: async (args, context) => {
        const { vmName } = args;
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required - is the VM running?");
        console.log(`[installDeps] Waiting for SSH on ${sshHost}...`);
        const ready = await waitForSsh(sshHost, sshUser);
        if (!ready) throw new Error(`SSH not reachable on ${sshHost} after 60s`);
        const packages = "openjdk21-jre tmux bash curl unzip";
        console.log(`[installDeps] Installing packages: ${packages}`);
        await sshExec(sshHost, sshUser, `apk add ${packages}`);
        const javaResult = await sshExecRaw(sshHost, sshUser, "java -version 2>&1 | head -1");
        const javaVersion = javaResult.stdout.trim();
        console.log(`[installDeps] Java version: ${javaVersion}`);
        const handle = await context.writeResource("deps", vmName, {
          packages,
          javaVersion,
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
      description: "Upload a server pack zip to the VM via rsync",
      arguments: z.object({
        vmName: z.string().describe("VM name (used as resource instance name)"),
        localPath: z.string().describe("Local path to the server pack zip")
      }),
      execute: async (args, context) => {
        const { vmName, localPath } = args;
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required - is the VM running?");
        const remotePath = "~/server-pack.zip";
        console.log(`[upload] Uploading ${localPath} to ${sshUser}@${sshHost}:${remotePath}`);
        const rsync = new Deno.Command("rsync", {
          args: [
            "-avz",
            "-e",
            "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10",
            localPath,
            `${sshUser}@${sshHost}:${remotePath}`
          ]
        });
        const result = await rsync.output();
        if (result.code !== 0) {
          const err = new TextDecoder().decode(result.stderr);
          throw new Error(`rsync failed: ${err}`);
        }
        console.log(`[upload] Upload complete`);
        const handle = await context.writeResource("upload", vmName, {
          localPath,
          remotePath,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    extract: {
      description: "Extract server pack zip, discover modloader config and start script",
      arguments: z.object({
        vmName: z.string().describe("VM name (used as resource instance name)"),
        remotePath: z.string().describe("Remote path to the server pack zip"),
        serverDir: z.string().default("~/game").describe("Directory to extract into")
      }),
      execute: async (args, context) => {
        const { vmName, remotePath, serverDir } = args;
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required - is the VM running?");
        console.log(`[extract] Extracting ${remotePath} to ${serverDir}`);
        await sshExec(sshHost, sshUser, `mkdir -p ${serverDir}`);
        await sshExec(sshHost, sshUser, `cd ${serverDir} && unzip -o ${remotePath}`);
        let modloader = "";
        let mcVersion = "";
        let modloaderVersion = "";
        const varsResult = await sshExecRaw(sshHost, sshUser, `cat ${serverDir}/variables.txt 2>/dev/null || echo ""`);
        if (varsResult.stdout.trim()) {
          const vars = varsResult.stdout;
          const mlMatch = vars.match(/MODLOADER=(\S+)/);
          const mcMatch = vars.match(/MINECRAFT_VERSION=(\S+)/);
          const mlvMatch = vars.match(/MODLOADER_VERSION=(\S+)/);
          if (mlMatch) modloader = mlMatch[1];
          if (mcMatch) mcVersion = mcMatch[1];
          if (mlvMatch) modloaderVersion = mlvMatch[1];
          console.log(`[extract] Discovered: modloader=${modloader} mc=${mcVersion} modloaderVersion=${modloaderVersion}`);
        }
        const findResult = await sshExecRaw(sshHost, sshUser, `cd ${serverDir} && ls -1 startserver.sh start.sh run.sh ServerStart.sh Start.sh 2>/dev/null | head -1`);
        let startScript = findResult.stdout.trim();
        if (!startScript) {
          const fallback = await sshExecRaw(sshHost, sshUser, `cd ${serverDir} && ls -1 *.sh 2>/dev/null | head -1`);
          startScript = fallback.stdout.trim() || "startserver.sh";
        }
        console.log(`[extract] Start script: ${startScript}`);
        const logPath = `${serverDir}/logs/latest.log`;
        const handle = await context.writeResource("server", vmName, {
          modloader,
          mcVersion,
          modloaderVersion,
          startScript: `./${startScript}`,
          serverDir,
          logPath,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    configure: {
      description: "Configure JVM memory, EULA, and server variables",
      arguments: z.object({
        vmName: z.string().describe("VM name (used as resource instance name)"),
        serverDir: z.string().describe("Server directory"),
        jvmMemory: z.string().default("10G").describe("JVM memory (e.g. 10G)")
      }),
      execute: async (args, context) => {
        const { vmName, serverDir, jvmMemory } = args;
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required - is the VM running?");
        console.log(`[configure] Configuring server in ${serverDir}`);
        const hasVars = await sshExecRaw(sshHost, sshUser, `test -f ${serverDir}/variables.txt && echo yes || echo no`);
        if (hasVars.stdout.trim() === "yes") {
          console.log(`[configure] Setting JVM memory to -Xmx${jvmMemory} -Xms${jvmMemory}`);
          await sshExec(sshHost, sshUser, `cd ${serverDir} && sed -i 's/JAVA_ARGS=.*/JAVA_ARGS="-Xmx${jvmMemory} -Xms${jvmMemory}"/' variables.txt`);
          await sshExec(sshHost, sshUser, `cd ${serverDir} && sed -i 's/SKIP_JAVA_CHECK=.*/SKIP_JAVA_CHECK=true/' variables.txt`);
          await sshExec(sshHost, sshUser, `cd ${serverDir} && sed -i 's/WAIT_FOR_USER_INPUT=.*/WAIT_FOR_USER_INPUT=false/' variables.txt`);
          await sshExec(sshHost, sshUser, `cd ${serverDir} && sed -i 's/RESTART=.*/RESTART=false/' variables.txt`);
          console.log(`[configure] variables.txt updated`);
        }
        console.log(`[configure] Accepting EULA`);
        await sshExec(sshHost, sshUser, `echo "eula=true" > ${serverDir}/eula.txt`);
        await sshExecRaw(sshHost, sshUser, `chmod +x ${serverDir}/*.sh 2>/dev/null || true`);
        console.log(`[configure] Start scripts marked executable`);
        await sshExecRaw(sshHost, sshUser, `mkdir -p ${serverDir}/logs`);
        const handle = await context.writeResource("config", vmName, {
          jvmMemory,
          eulaAccepted: true,
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
