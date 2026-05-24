import { z } from "npm:zod@4";
import { sshExec, isValidSshHost } from "./lib/ssh.ts";

const GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname/IP of the target host"),
  sshUser: z.string().default("root").describe("SSH user"),
  remoteDir: z.string().describe("Remote directory for the swamp repo"),
});

const RepoSchema = z.object({
  remoteDir: z.string(),
  component: z.string(),
  success: z.boolean(),
  logs: z.string().optional(),
  timestamp: z.string(),
});

const SWAMP_EXCLUDES = [
  ".swamp/data/",
  ".swamp/outputs/",
  ".swamp/workflow-runs/",
  ".swamp/logs/",
  ".swamp/definitions-evaluated/",
  ".swamp/workflows-evaluated/",
  // Host-local state — clobbering slate's copy with the local one rewires its
  // catalog to /home/keeb/... paths and/or wipes pulled extensions (slate's
  // extension set may differ from local — e.g. @keeb/mongodb-datastore).
  ".swamp/_extension_catalog.db*",
  ".swamp/pulled-extensions/",
  ".swamp/audit/",
  ".swamp/bundles/",
  ".swamp/datastore/",
  ".swamp/datastore-bundles/",
  ".swamp/driver-bundles/",
  ".swamp/report-bundles/",
  ".swamp/vault-bundles/",
  ".swamp/files/",
  ".swamp/inputs-evaluated/",
  ".swamp/telemetry/",
];

export const model = {
  type: "@keeb/swamp/repo",
  version: "2026.02.11.1",
  resources: {
    "repo": {
      description: "Swamp repo sync result",
      schema: RepoSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  globalArguments: GlobalArgs,
  methods: {
    syncCode: {
      description: "Rsync swamp repo to remote host",
      arguments: z.object({
        excludes: z.union([z.array(z.string()), z.string()]).default([]).describe("Additional rsync excludes"),
        localDir: z.string().optional().describe("Override source directory (absolute or relative to repoDir)"),
        remoteSubdir: z.string().optional().describe("Subdirectory within remoteDir to sync into"),
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", remoteDir } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required — is the target VM running?");

        const userExcludes = typeof args.excludes === "string" ? JSON.parse(args.excludes) : args.excludes;
        const sourceDir = args.localDir
          ? (args.localDir.startsWith("/") ? args.localDir : `${context.repoDir}/${args.localDir}`)
          : context.repoDir;
        const targetDir = args.remoteSubdir ? `${remoteDir}/${args.remoteSubdir}` : remoteDir;
        const logs = [];
        const log = (msg) => logs.push(msg);

        log(`Ensuring rsync on ${sshHost}`);
        await sshExec(sshHost, sshUser, `which rsync || apk add rsync`);

        const excludeArgs = [];
        for (const ex of [...SWAMP_EXCLUDES, ...userExcludes]) {
          excludeArgs.push("--exclude", ex);
        }

        log(`Syncing ${sourceDir} to ${sshUser}@${sshHost}:${targetDir}`);
        // @ts-ignore - Deno API
        const rsync = new Deno.Command("rsync", {
          args: [
            "-avz", "--delete",
            "-e", "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10",
            ...excludeArgs,
            `${sourceDir}/`,
            `${sshUser}@${sshHost}:${targetDir}/`,
          ],
        });
        const result = await rsync.output();
        const rsyncOut = new TextDecoder().decode(result.stdout);
        if (result.code !== 0) {
          const err = new TextDecoder().decode(result.stderr);
          throw new Error(`rsync failed: ${err}`);
        }
        log(`Repo synced`);
        log(rsyncOut.trim());

        const handle = await context.writeResource("repo", "code", {
          remoteDir,
          component: "code",
          success: true,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    syncBinary: {
      description: "Copy swamp binary to remote host",
      arguments: z.object({
        binaryName: z.string().default("swamp").describe("Name of the binary to find via which (ignored if localPath set)"),
        remotePath: z.string().default("swamp").describe("Relative path within remoteDir for the binary"),
        localPath: z.string().default("").describe("Absolute path to a specific binary to copy. Overrides which lookup."),
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", remoteDir } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required — is the target VM running?");

        const binaryName = args.binaryName || "swamp";
        const remotePath = args.remotePath || "swamp";
        const logs = [];
        const log = (msg) => logs.push(msg);

        let localPath = args.localPath;
        if (!localPath) {
          log(`Finding local ${binaryName} binary`);
          // @ts-ignore - Deno API
          const whichCmd = new Deno.Command("which", { args: [binaryName] });
          const whichResult = await whichCmd.output();
          localPath = new TextDecoder().decode(whichResult.stdout).trim();
          if (!localPath) throw new Error(`${binaryName} binary not found on host`);
        } else {
          log(`Using explicit localPath ${localPath}`);
        }

        const fullRemotePath = `${remoteDir}/${remotePath}`;
        const remoteParent = fullRemotePath.substring(0, fullRemotePath.lastIndexOf("/"));

        log(`Copying ${localPath} to ${sshUser}@${sshHost}:${fullRemotePath}`);
        await sshExec(sshHost, sshUser, `mkdir -p ${remoteParent}`);

        // @ts-ignore - Deno API
        const scp = new Deno.Command("scp", {
          args: [
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            localPath,
            `${sshUser}@${sshHost}:${fullRemotePath}`,
          ],
        });
        const scpResult = await scp.output();
        if (scpResult.code !== 0) {
          const err = new TextDecoder().decode(scpResult.stderr);
          throw new Error(`scp ${binaryName} binary failed: ${err}`);
        }

        await sshExec(sshHost, sshUser, `chmod +x ${fullRemotePath}`);
        log(`Binary copied to ${fullRemotePath}`);

        const handle = await context.writeResource("repo", "binary", {
          remoteDir,
          component: "binary",
          success: true,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    syncAuth: {
      description: "Copy swamp auth config to remote host",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required — is the target VM running?");

        const logs = [];
        const log = (msg) => logs.push(msg);

        // @ts-ignore - Deno API
        const home = Deno.env.get("HOME");
        const localPath = `${home}/.config/swamp/auth.json`;

        log(`Ensuring ~/.config/swamp/ on ${sshHost}`);
        await sshExec(sshHost, sshUser, "mkdir -p ~/.config/swamp");

        log(`Copying auth.json to ${sshUser}@${sshHost}`);
        // @ts-ignore - Deno API
        const scp = new Deno.Command("scp", {
          args: [
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ConnectTimeout=10",
            localPath,
            `${sshUser}@${sshHost}:.config/swamp/auth.json`,
          ],
        });
        const result = await scp.output();
        if (result.code !== 0) {
          const err = new TextDecoder().decode(result.stderr);
          throw new Error(`scp auth.json failed: ${err}`);
        }
        log("Auth config synced");

        const handle = await context.writeResource("repo", "auth", {
          remoteDir: context.globalArgs.remoteDir,
          component: "auth",
          success: true,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    updateSwamp: {
      description: "Self-update the swamp binary on the remote host via a glibc container (slate is musl, so the binary needs a glibc runtime to self-replace)",
      arguments: z.object({
        binarySubpath: z.string().default("swamp").describe("Path to swamp binary relative to remoteDir"),
        image: z.string().default("denoland/deno:debian").describe("Glibc-based docker image to run swamp inside"),
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", remoteDir } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required — is the target VM running?");

        const fullRemotePath = `${remoteDir}/${args.binarySubpath}`;
        const remoteParent = fullRemotePath.substring(0, fullRemotePath.lastIndexOf("/"));
        const binaryName = fullRemotePath.substring(fullRemotePath.lastIndexOf("/") + 1);
        const logs = [];
        const log = (msg) => logs.push(msg);

        log(`Updating ${sshHost}:${fullRemotePath} via ${args.image}`);
        // Bind-mount the parent dir (not the file itself) so swamp update's atomic rename lands on host disk.
        const cmd = `docker run --rm -v ${remoteParent}:/work ${args.image} /work/${binaryName} update`;
        const result = await sshExec(sshHost, sshUser, cmd);
        const combined = `${result.stdout}\n${result.stderr}`.trim();
        log(combined);

        const handle = await context.writeResource("repo", "swamp-update", {
          remoteDir,
          component: "swamp-update",
          success: true,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    syncSecrets: {
      description: "Rsync vault secrets to remote host (soft-fail)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { sshHost, sshUser = "root", remoteDir } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required — is the target VM running?");

        const repoDir = context.repoDir;
        const logs = [];
        const log = (msg) => logs.push(msg);

        log(`Syncing vault secrets to ${sshHost}`);

        // @ts-ignore - Deno API
        const rsync = new Deno.Command("rsync", {
          args: [
            "-avz",
            "-e", "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null",
            `${repoDir}/.swamp/secrets/`,
            `${sshUser}@${sshHost}:${remoteDir}/.swamp/secrets/`,
          ],
        });
        const result = await rsync.output();
        const rsyncOut = new TextDecoder().decode(result.stdout);
        const rsyncErr = new TextDecoder().decode(result.stderr);

        let success = true;
        if (result.code !== 0) {
          log(`Warning: vault secrets sync failed — swamp workflows may need manual vault setup on remote`);
          log(rsyncErr.trim());
          success = false;
        } else {
          log(`Vault secrets synced`);
          log(rsyncOut.trim());
        }

        const handle = await context.writeResource("repo", "secrets", {
          remoteDir,
          component: "secrets",
          success,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
