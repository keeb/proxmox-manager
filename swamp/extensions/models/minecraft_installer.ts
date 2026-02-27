import { z } from "npm:zod@4";
import { sshExec, sshExecRaw, isValidSshHost, waitForSsh } from "./lib/ssh.ts";

const GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname/IP (set via CEL from fleet)"),
  sshUser: z.string().default("root").describe("SSH user"),
});

const DepsSchema = z.object({
  packages: z.string(),
  javaVersion: z.string().optional(),
  timestamp: z.string(),
});

const UploadSchema = z.object({
  localPath: z.string(),
  remotePath: z.string(),
  timestamp: z.string(),
});

const ServerSchema = z.object({
  modloader: z.string().optional(),
  mcVersion: z.string().optional(),
  modloaderVersion: z.string().optional(),
  startScript: z.string(),
  serverDir: z.string(),
  logPath: z.string(),
  timestamp: z.string(),
});

const ConfigSchema = z.object({
  jvmMemory: z.string(),
  eulaAccepted: z.boolean(),
  timestamp: z.string(),
});

export const model = {
  type: "@user/minecraft/installer",
  version: "2026.02.16.1",
  resources: {
    "deps": {
      description: "Package install result",
      schema: DepsSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "upload": {
      description: "Server pack upload result",
      schema: UploadSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "server": {
      description: "Discovered server config (modloader, start script, paths)",
      schema: ServerSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "config": {
      description: "Server configuration result (JVM, EULA)",
      schema: ConfigSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  globalArguments: GlobalArgs,
  methods: {
    installDeps: {
      description: "Install required packages (JDK, tmux, bash, curl, unzip) on the VM",
      arguments: z.object({
        vmName: z.string().describe("VM name (used as resource instance name)"),
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
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    upload: {
      description: "Upload a server pack zip to the VM via rsync",
      arguments: z.object({
        vmName: z.string().describe("VM name (used as resource instance name)"),
        localPath: z.string().describe("Local path to the server pack zip"),
      }),
      execute: async (args, context) => {
        const { vmName, localPath } = args;
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required - is the VM running?");

        const remotePath = "~/server-pack.zip";
        console.log(`[upload] Uploading ${localPath} to ${sshUser}@${sshHost}:${remotePath}`);

        // @ts-ignore - Deno API
        const rsync = new Deno.Command("rsync", {
          args: [
            "-avz",
            "-e", "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10",
            localPath,
            `${sshUser}@${sshHost}:${remotePath}`,
          ],
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
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    extract: {
      description: "Extract server pack zip, discover modloader config and start script",
      arguments: z.object({
        vmName: z.string().describe("VM name (used as resource instance name)"),
        remotePath: z.string().describe("Remote path to the server pack zip"),
        serverDir: z.string().default("~/game").describe("Directory to extract into"),
      }),
      execute: async (args, context) => {
        const { vmName, remotePath, serverDir } = args;
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required - is the VM running?");

        console.log(`[extract] Extracting ${remotePath} to ${serverDir}`);
        await sshExec(sshHost, sshUser, `mkdir -p ${serverDir}`);
        await sshExec(sshHost, sshUser, `cd ${serverDir} && unzip -o ${remotePath}`);

        // Parse variables.txt if present
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

        // Discover start script
        const findResult = await sshExecRaw(sshHost, sshUser,
          `cd ${serverDir} && ls -1 startserver.sh start.sh run.sh ServerStart.sh Start.sh 2>/dev/null | head -1`);
        let startScript = findResult.stdout.trim();
        if (!startScript) {
          // Fallback: find any .sh that looks like a start script
          const fallback = await sshExecRaw(sshHost, sshUser,
            `cd ${serverDir} && ls -1 *.sh 2>/dev/null | head -1`);
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
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    configure: {
      description: "Configure JVM memory, EULA, and server variables",
      arguments: z.object({
        vmName: z.string().describe("VM name (used as resource instance name)"),
        serverDir: z.string().describe("Server directory"),
        jvmMemory: z.string().default("10G").describe("JVM memory (e.g. 10G)"),
      }),
      execute: async (args, context) => {
        const { vmName, serverDir, jvmMemory } = args;
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required - is the VM running?");

        console.log(`[configure] Configuring server in ${serverDir}`);

        // Update variables.txt if present
        const hasVars = await sshExecRaw(sshHost, sshUser, `test -f ${serverDir}/variables.txt && echo yes || echo no`);
        if (hasVars.stdout.trim() === "yes") {
          console.log(`[configure] Setting JVM memory to -Xmx${jvmMemory} -Xms${jvmMemory}`);
          await sshExec(sshHost, sshUser,
            `cd ${serverDir} && sed -i 's/JAVA_ARGS=.*/JAVA_ARGS="-Xmx${jvmMemory} -Xms${jvmMemory}"/' variables.txt`);

          // Set common variables for unattended operation
          await sshExec(sshHost, sshUser,
            `cd ${serverDir} && sed -i 's/SKIP_JAVA_CHECK=.*/SKIP_JAVA_CHECK=true/' variables.txt`);
          await sshExec(sshHost, sshUser,
            `cd ${serverDir} && sed -i 's/WAIT_FOR_USER_INPUT=.*/WAIT_FOR_USER_INPUT=false/' variables.txt`);
          await sshExec(sshHost, sshUser,
            `cd ${serverDir} && sed -i 's/RESTART=.*/RESTART=false/' variables.txt`);
          console.log(`[configure] variables.txt updated`);
        }

        // Accept EULA
        console.log(`[configure] Accepting EULA`);
        await sshExec(sshHost, sshUser, `echo "eula=true" > ${serverDir}/eula.txt`);

        // chmod start scripts
        await sshExecRaw(sshHost, sshUser, `chmod +x ${serverDir}/*.sh 2>/dev/null || true`);
        console.log(`[configure] Start scripts marked executable`);

        // Create logs dir
        await sshExecRaw(sshHost, sshUser, `mkdir -p ${serverDir}/logs`);

        const handle = await context.writeResource("config", vmName, {
          jvmMemory,
          eulaAccepted: true,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
