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
];

export const model = {
  type: "@user/swamp/repo",
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
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", remoteDir } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required — is the target VM running?");

        const userExcludes = typeof args.excludes === "string" ? JSON.parse(args.excludes) : args.excludes;
        const repoDir = context.repoDir;
        const logs = [];
        const log = (msg) => logs.push(msg);

        log(`Ensuring rsync on ${sshHost}`);
        await sshExec(sshHost, sshUser, `which rsync || apk add rsync`);

        const excludeArgs = [];
        for (const ex of [...SWAMP_EXCLUDES, ...userExcludes]) {
          excludeArgs.push("--exclude", ex);
        }

        log(`Syncing repo to ${sshUser}@${sshHost}:${remoteDir}`);
        // @ts-ignore - Deno API
        const rsync = new Deno.Command("rsync", {
          args: [
            "-avz", "--delete",
            "-e", "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10",
            ...excludeArgs,
            `${repoDir}/`,
            `${sshUser}@${sshHost}:${remoteDir}/`,
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
        binaryName: z.string().default("swamp").describe("Name of the binary to find via which"),
        remotePath: z.string().default("swamp").describe("Relative path within remoteDir for the binary"),
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", remoteDir } = context.globalArgs;
        if (!isValidSshHost(sshHost)) throw new Error("sshHost is required — is the target VM running?");

        const binaryName = args.binaryName || "swamp";
        const remotePath = args.remotePath || "swamp";
        const logs = [];
        const log = (msg) => logs.push(msg);

        log(`Finding local ${binaryName} binary`);
        // @ts-ignore - Deno API
        const whichCmd = new Deno.Command("which", { args: [binaryName] });
        const whichResult = await whichCmd.output();
        const localPath = new TextDecoder().decode(whichResult.stdout).trim();
        if (!localPath) throw new Error(`${binaryName} binary not found on host`);

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
