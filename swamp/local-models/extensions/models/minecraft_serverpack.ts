import { z } from "npm:zod@4";
import { sshExec, sshExecRaw, isValidSshHost } from "./lib/ssh.ts";

// Manages versioned Minecraft server-pack installs on a single VM with a
// "copy on write" layout:
//
//   ~/game                  -> game-<activeFileId>     (symlink)
//   ~/game-<fileId>/        full install: mods/, config/, world/, start.sh, ...
//
// Each installation owns its own world. Forking copies the active install's
// world into the new install so play continues from that snapshot. Rollback
// is a symlink swap — the previous install's world is untouched.

const GlobalArgs = z.object({
  sshHost: z.string().nullable().describe("SSH hostname/IP — set via CEL from fleet, nullable when VM is stopped"),
  sshUser: z.string().default("root"),
  serverParent: z.string().default("/root").describe("Directory holding the versioned game dirs and the active symlink (e.g. /root, ~ won't expand in some shells)"),
  linkName: z.string().default("game").describe("Symlink name within serverParent (active install)"),
  stagingDir: z.string().default("/tmp/serverpacks").describe("Where uploaded zips are staged on the remote host"),
});

const InstallSchema = z.object({
  fileId: z.string(),
  serverDir: z.string(),
  bytesOnDisk: z.number().nullable(),
  installedAt: z.string(),
  forkedFrom: z.string().nullable().describe("fileId of the install whose world was copied in"),
});

const ActiveSchema = z.object({
  fileId: z.string().nullable(),
  serverDir: z.string().nullable(),
  link: z.string(),
  switchedAt: z.string(),
  previousFileId: z.string().nullable(),
});

const InstalledListSchema = z.object({
  installs: z.array(z.object({
    fileId: z.string(),
    serverDir: z.string(),
    bytes: z.number(),
    isActive: z.boolean(),
  })),
  active: z.string().nullable(),
  collectedAt: z.string(),
});

// helpers ────────────────────────────────────────────────────────────────────

function reqHost(host) {
  if (!isValidSshHost(host)) throw new Error("sshHost is required — is the target VM running?");
}

function shquote(s) {
  // Single-quote a string safely for inclusion in a remote sh -c command.
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function serverDirFor(parent, fileId) {
  return `${parent}/game-${fileId}`;
}

async function remoteFileExists(host, user, path) {
  const r = await sshExecRaw(host, user, `test -e ${shquote(path)}`);
  return r.code === 0;
}

// Read a sibling-model resource by shelling out to `swamp data get` — the
// in-process context API doesn't expose cross-model reads in this swamp build.
async function readSiblingResourceContent(modelName, instanceName) {
  // @ts-ignore - Deno API
  const cmd = new Deno.Command("swamp", {
    args: ["data", "get", modelName, instanceName, "--json"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  if (code !== 0) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(stdout));
    return j.content || j.attributes || null;
  } catch { return null; }
}

async function readActiveFileId(host, user, parent, link) {
  const target = `${parent}/${link}`;
  // Classify: symlink / real dir / missing.
  const kindRes = await sshExecRaw(host, user, `if [ -L ${shquote(target)} ]; then echo symlink; elif [ -d ${shquote(target)} ]; then echo dir; else echo missing; fi`);
  const kind = (kindRes.stdout || "").trim();
  if (kind === "symlink") {
    const r = await sshExecRaw(host, user, `readlink ${shquote(target)} 2>/dev/null || true`);
    const out = (r.stdout || "").trim();
    if (!out) return { fileId: null, serverDir: null, kind };
    const resolved = out.startsWith("/") ? out : `${parent}/${out.replace(/^\.\//, "")}`;
    const m = resolved.match(/\/game-([^/]+)\/?$/);
    return { fileId: m ? m[1] : null, serverDir: resolved, kind };
  }
  if (kind === "dir") {
    // Real directory at the link path — pre-bootstrap layout. Treat it as a
    // synthetic 'preexisting' install so the first deploy can fork its world.
    return { fileId: "preexisting", serverDir: target, kind };
  }
  return { fileId: null, serverDir: null, kind };
}

// model ──────────────────────────────────────────────────────────────────────

export const model = {
  type: "@keeb/minecraft/serverpack",
  version: "2026.05.16.3",
  resources: {
    install: {
      description: "A versioned server-pack install on the remote VM. Instance name = fileId.",
      schema: InstallSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    active: {
      description: "Current active install (symlink target). Instance name = linkName (default 'game').",
      schema: ActiveSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    installed: {
      description: "Snapshot of all installs found on disk. Instance name = 'snapshot'.",
      schema: InstalledListSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  globalArguments: GlobalArgs,
  methods: {
    install: {
      description: "Upload a server-pack zip to the VM and unzip it into <serverParent>/game-<fileId>/. If fileId/localPath aren't provided, reads them from the most recent projectInfinityModpack 'project' resource (set by curseforge discoverLatest + download). Does NOT touch the active install or fork the world — call forkState (after stopping the server) and then activate.",
      arguments: z.object({
        fileId: z.string().default("").describe("Server-pack fileId. If empty, resolved from curseforge project resource."),
        localPath: z.string().default("").describe("Absolute local path to the zip. If empty, resolved from curseforge project resource."),
        curseforgeModel: z.string().default("projectInfinityModpack").describe("Name of the curseforge/modpack instance to read the latest pointer from when fileId/localPath are empty."),
        curseforgeSlug: z.string().default("project-infinity-0-1").describe("Project resource instance name (= slug)."),
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", serverParent, stagingDir } = context.globalArgs;
        reqHost(sshHost);

        let fileId = args.fileId;
        let localPath = args.localPath;
        if (!fileId) {
          const projContent = await readSiblingResourceContent(args.curseforgeModel, args.curseforgeSlug);
          if (!projContent) throw new Error(`Could not resolve project resource ${args.curseforgeModel}/${args.curseforgeSlug}. Pass fileId explicitly.`);
          fileId = projContent.latestFileId;
        }
        if (!localPath && fileId) {
          // Read the file resource for this fileId — it has the localPath after download.
          const fileContent = await readSiblingResourceContent(args.curseforgeModel, fileId);
          if (fileContent) localPath = fileContent.localPath;
        }

        if (!fileId) throw new Error("fileId is required (and could not be resolved)");
        if (!localPath) throw new Error(`localPath is required (file resource for fileId=${fileId} has no localPath — run download first or pass it explicitly)`);

        const newDir = serverDirFor(serverParent, fileId);
        const remoteZip = `${stagingDir}/serverpack-${fileId}.zip`;

        // Idempotency: if the install dir already has a start.sh, treat it as
        // installed and skip the upload+unzip. Useful for re-running the deploy
        // workflow after a downstream step failed.
        if (await remoteFileExists(sshHost, sshUser, `${newDir}/start.sh`)) {
          console.log(`[serverpack/install] ${newDir}/start.sh already exists — skipping upload + unzip`);
          const duRes = await sshExecRaw(sshHost, sshUser, `du -sb ${shquote(newDir)} | awk '{print $1}'`);
          const bytesOnDisk = parseInt((duRes.stdout || "0").trim(), 10) || null;
          const handle = await context.writeResource("install", fileId, {
            fileId, serverDir: newDir, bytesOnDisk,
            installedAt: new Date().toISOString(), forkedFrom: null,
          });
          return { dataHandles: [handle] };
        }

        await sshExec(sshHost, sshUser, `mkdir -p ${shquote(stagingDir)} ${shquote(serverParent)} && (which unzip >/dev/null 2>&1 || (which apk >/dev/null 2>&1 && apk add --no-cache unzip) || (which apt >/dev/null 2>&1 && apt-get install -y unzip))`);

        console.log(`[serverpack/install] uploading ${localPath} -> ${sshUser}@${sshHost}:${remoteZip}`);
        // @ts-ignore - Deno API
        const scp = new Deno.Command("scp", {
          args: [
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ConnectTimeout=10",
            localPath, `${sshUser}@${sshHost}:${remoteZip}`,
          ],
        });
        const scpRes = await scp.output();
        if (scpRes.code !== 0) {
          const err = new TextDecoder().decode(scpRes.stderr);
          throw new Error(`scp failed: ${err}`);
        }

        if (await remoteFileExists(sshHost, sshUser, newDir)) {
          throw new Error(`Server dir ${newDir} already exists on ${sshHost}. Refusing to overwrite. Run removeInstallation first if you really want to reinstall.`);
        }

        console.log(`[serverpack/install] unzipping into ${newDir}`);
        const tmp = `${newDir}.unpacking`;
        await sshExec(sshHost, sshUser, `rm -rf ${shquote(tmp)} && mkdir -p ${shquote(tmp)} && unzip -q ${shquote(remoteZip)} -d ${shquote(tmp)}`);
        // ServerPackCreator zips sometimes wrap everything in a top-level folder, sometimes don't.
        await sshExec(sshHost, sshUser, `set -e; entries=$(ls -A ${shquote(tmp)}); count=$(printf '%s\\n' "$entries" | wc -l); if [ "$count" = "1" ] && [ -d ${shquote(tmp)}/$entries ]; then mv ${shquote(tmp)}/$entries ${shquote(newDir)} && rmdir ${shquote(tmp)}; else mv ${shquote(tmp)} ${shquote(newDir)}; fi`);
        await sshExec(sshHost, sshUser, `[ -f ${shquote(newDir)}/start.sh ] && chmod +x ${shquote(newDir)}/start.sh || true`);
        // Auto-accept EULA — the operator already accepted it on the existing install.
        await sshExec(sshHost, sshUser, `printf 'eula=true\\n' > ${shquote(newDir)}/eula.txt`);
        await sshExec(sshHost, sshUser, `rm -f ${shquote(remoteZip)}`);

        const duRes = await sshExecRaw(sshHost, sshUser, `du -sb ${shquote(newDir)} | awk '{print $1}'`);
        const bytesOnDisk = parseInt((duRes.stdout || "0").trim(), 10) || null;

        const handle = await context.writeResource("install", fileId, {
          fileId,
          serverDir: newDir,
          bytesOnDisk,
          installedAt: new Date().toISOString(),
          forkedFrom: null,
        });
        console.log(`[serverpack/install] installed ${newDir} (${bytesOnDisk} bytes)`);
        return { dataHandles: [handle] };
      },
    },

    forkState: {
      description: "Copy the world + admin-state (server.properties, ops.json, banned-*, whitelist, variables.txt) from the currently-active install into a new install. Run this AFTER stopping the server so the world isn't mid-write.",
      arguments: z.object({
        fileId: z.string().default("").describe("fileId of the install that should receive the forked world. If empty, resolved from curseforge project resource."),
        fromFileId: z.string().default("").describe("Override the fork source. Defaults to current active install."),
        curseforgeModel: z.string().default("projectInfinityModpack").describe("Curseforge model to resolve fileId from when empty."),
        curseforgeSlug: z.string().default("project-infinity-0-1").describe("Project resource instance name."),
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", serverParent, linkName } = context.globalArgs;
        reqHost(sshHost);

        let fileId = args.fileId;
        if (!fileId) {
          const content = await readSiblingResourceContent(args.curseforgeModel, args.curseforgeSlug);
          if (content) fileId = content.latestFileId;
        }
        if (!fileId) throw new Error("fileId is required (and could not be resolved)");

        const newDir = serverDirFor(serverParent, fileId);
        if (!(await remoteFileExists(sshHost, sshUser, newDir))) {
          throw new Error(`Target install ${newDir} does not exist — run install first.`);
        }

        let sourceDir = null;
        let forkedFrom = null;
        if (args.fromFileId) {
          sourceDir = serverDirFor(serverParent, args.fromFileId);
          if (!(await remoteFileExists(sshHost, sshUser, sourceDir))) {
            throw new Error(`fromFileId=${args.fromFileId}: ${sourceDir} does not exist`);
          }
          forkedFrom = args.fromFileId;
        } else {
          const active = await readActiveFileId(sshHost, sshUser, serverParent, linkName);
          if (active.fileId) {
            sourceDir = active.serverDir;
            forkedFrom = active.fileId;
            console.log(`[serverpack/forkState] forking from active install fileId=${active.fileId} (${sourceDir}, kind=${active.kind})`);
          }
        }
        if (!sourceDir) {
          console.log(`[serverpack/forkState] no active install to fork from; skipping`);
          const handle = await context.writeResource("install", fileId, {
            fileId, serverDir: newDir, bytesOnDisk: null,
            installedAt: new Date().toISOString(), forkedFrom: null,
          });
          return { dataHandles: [handle] };
        }

        // user_jvm_args.txt and the world+admin state are wholesale-forked.
        // variables.txt is NOT wholesale-copied — we keep the new pack's
        // version-detection fields and patch in only user-customizable fields
        // from the old variables.txt (JAVA_ARGS, ADDITIONAL_ARGS, SKIP_JAVA_CHECK,
        // RESTART, WAIT_FOR_USER_INPUT, JAVA).
        const stateFiles = [
          "server.properties", "ops.json", "banned-players.json",
          "banned-ips.json", "whitelist.json",
          "user_jvm_args.txt", "server-icon.png",
        ];
        for (const f of stateFiles) {
          await sshExec(sshHost, sshUser, `[ -e ${shquote(`${sourceDir}/${f}`)} ] && cp -a ${shquote(`${sourceDir}/${f}`)} ${shquote(`${newDir}/${f}`)} || true`);
        }

        // Patch variables.txt: preserve user-tunable fields from the source.
        // Read the source's values, then for each key, replace the matching
        // line in the new variables.txt (or append if absent). SKIP_JAVA_CHECK
        // is force-set to true because the VM's Java install is system-managed
        // and ServerPackCreator's Jabba auto-installer doesn't work on Alpine/musl.
        const carryKeys = ["JAVA_ARGS", "ADDITIONAL_ARGS", "JAVA", "RESTART", "WAIT_FOR_USER_INPUT"];
        const forceKeys = { SKIP_JAVA_CHECK: "true", WAIT_FOR_USER_INPUT: "false" };
        if (await remoteFileExists(sshHost, sshUser, `${sourceDir}/variables.txt`)) {
          for (const key of carryKeys) {
            // Pull the value from the source variables.txt and overwrite it in the new one.
            const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const cmd = `set -e; src=${shquote(`${sourceDir}/variables.txt`)}; dst=${shquote(`${newDir}/variables.txt`)}; line=$(grep -E '^${escKey}=' "$src" | tail -1 || true); if [ -n "$line" ]; then if grep -qE '^${escKey}=' "$dst"; then sed -i "s|^${escKey}=.*|$line|" "$dst"; else printf '%s\\n' "$line" >> "$dst"; fi; fi`;
            await sshExec(sshHost, sshUser, cmd);
          }
        }
        // Force critical fields regardless of source.
        for (const [k, v] of Object.entries(forceKeys)) {
          const line = `${k}=${v}`;
          const cmd = `set -e; dst=${shquote(`${newDir}/variables.txt`)}; if grep -qE '^${k}=' "$dst"; then sed -i 's|^${k}=.*|${line}|' "$dst"; else printf '%s\\n' '${line}' >> "$dst"; fi`;
          await sshExec(sshHost, sshUser, cmd);
        }
        const worldNameRes = await sshExecRaw(sshHost, sshUser, `grep -E '^level-name=' ${shquote(`${sourceDir}/server.properties`)} 2>/dev/null | head -1 | sed 's/^level-name=//' | tr -d '\\r'`);
        const worldName = (worldNameRes.stdout || "").trim() || "world";
        console.log(`[serverpack/forkState] copying world '${worldName}' (and _nether / _the_end if present)`);
        await sshExec(sshHost, sshUser, `rm -rf ${shquote(`${newDir}/${worldName}`)} ${shquote(`${newDir}/${worldName}_nether`)} ${shquote(`${newDir}/${worldName}_the_end`)}`);
        for (const dim of [worldName, `${worldName}_nether`, `${worldName}_the_end`]) {
          await sshExec(sshHost, sshUser, `[ -d ${shquote(`${sourceDir}/${dim}`)} ] && cp -a ${shquote(`${sourceDir}/${dim}`)} ${shquote(`${newDir}/${dim}`)} || true`);
        }

        const duRes = await sshExecRaw(sshHost, sshUser, `du -sb ${shquote(newDir)} | awk '{print $1}'`);
        const bytesOnDisk = parseInt((duRes.stdout || "0").trim(), 10) || null;

        const handle = await context.writeResource("install", fileId, {
          fileId, serverDir: newDir, bytesOnDisk,
          installedAt: new Date().toISOString(), forkedFrom,
        });
        console.log(`[serverpack/forkState] done; install size now ${bytesOnDisk} bytes (forkedFrom=${forkedFrom})`);
        return { dataHandles: [handle] };
      },
    },

    activate: {
      description: "Atomically point the active symlink at <serverParent>/game-<fileId>. The Minecraft server should be stopped first; this method only swaps the symlink and writes an 'active' resource. If fileId is empty, resolves from the curseforge project resource.",
      arguments: z.object({
        fileId: z.string().default("").describe("fileId of the install to activate. If empty, resolved from curseforge project resource."),
        curseforgeModel: z.string().default("projectInfinityModpack"),
        curseforgeSlug: z.string().default("project-infinity-0-1"),
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", serverParent, linkName } = context.globalArgs;
        reqHost(sshHost);

        let fileId = args.fileId;
        if (!fileId) {
          const content = await readSiblingResourceContent(args.curseforgeModel, args.curseforgeSlug);
          if (content) fileId = content.latestFileId;
        }
        if (!fileId) throw new Error("fileId is required (and could not be resolved)");

        const target = serverDirFor(serverParent, fileId);
        if (!(await remoteFileExists(sshHost, sshUser, target))) {
          throw new Error(`Cannot activate fileId=${fileId}: ${target} does not exist`);
        }

        const prev = await readActiveFileId(sshHost, sshUser, serverParent, linkName);
        const linkPath = `${serverParent}/${linkName}`;

        // Bootstrap: if the link path is a real directory (pre-managed install),
        // rename it to game-preexisting so the symlink can take its place.
        if (prev.kind === "dir") {
          const bootstrapDir = serverDirFor(serverParent, "preexisting");
          if (await remoteFileExists(sshHost, sshUser, bootstrapDir)) {
            throw new Error(`Cannot bootstrap: ${linkPath} is a real directory AND ${bootstrapDir} already exists. Resolve manually.`);
          }
          if (target === linkPath) {
            throw new Error(`Cannot activate fileId=${fileId}: would overwrite the existing real directory at ${linkPath}.`);
          }
          console.log(`[serverpack/activate] bootstrap: renaming ${linkPath} -> ${bootstrapDir}`);
          await sshExec(sshHost, sshUser, `mv ${shquote(linkPath)} ${shquote(bootstrapDir)}`);
        }

        // `ln -sfn` is atomic-replace on Linux (uses renameat2 internally on coreutils).
        await sshExec(sshHost, sshUser, `ln -sfn ${shquote(target)} ${shquote(linkPath)}`);
        console.log(`[serverpack/activate] ${linkPath} -> ${target} (was ${prev.fileId ?? "<none>"})`);

        const handle = await context.writeResource("active", linkName, {
          fileId,
          serverDir: target,
          link: linkPath,
          switchedAt: new Date().toISOString(),
          previousFileId: prev.fileId,
        });
        return { dataHandles: [handle] };
      },
    },

    currentActive: {
      description: "Read the active symlink and write an 'active' resource describing it.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { sshHost, sshUser = "root", serverParent, linkName } = context.globalArgs;
        reqHost(sshHost);
        const { fileId, serverDir } = await readActiveFileId(sshHost, sshUser, serverParent, linkName);
        const linkPath = `${serverParent}/${linkName}`;
        const handle = await context.writeResource("active", linkName, {
          fileId, serverDir, link: linkPath,
          switchedAt: new Date().toISOString(),
          previousFileId: null,
        });
        console.log(`[serverpack/currentActive] ${linkPath} -> ${serverDir ?? "<none>"} (fileId=${fileId ?? "none"})`);
        return { dataHandles: [handle] };
      },
    },

    listInstalled: {
      description: "List all server-pack installs on disk (directories named game-*). Writes an 'installed' resource.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { sshHost, sshUser = "root", serverParent, linkName } = context.globalArgs;
        reqHost(sshHost);
        const active = await readActiveFileId(sshHost, sshUser, serverParent, linkName);
        // BusyBox `find` (on Alpine) doesn't support -printf. Use a portable shell loop.
        const r = await sshExecRaw(sshHost, sshUser, `set -e; cd ${shquote(serverParent)} 2>/dev/null && for d in game-*; do [ -d "$d" ] && [ ! -L "$d" ] || continue; size=$(du -sb "$d" 2>/dev/null | awk '{print $1}'); printf '%s\\t%s\\n' "$d" "$size"; done`);
        const installs = [];
        for (const line of (r.stdout || "").split("\n")) {
          if (!line.trim()) continue;
          const [name, bytesStr] = line.split("\t");
          const m = (name || "").match(/^game-(.+)$/);
          if (!m) continue;
          const fileId = m[1];
          installs.push({
            fileId,
            serverDir: `${serverParent}/${name}`,
            bytes: parseInt(bytesStr || "0", 10) || 0,
            isActive: active.fileId === fileId,
          });
        }
        installs.sort((a, b) => (b.fileId > a.fileId ? 1 : -1));
        const handle = await context.writeResource("installed", "snapshot", {
          installs,
          active: active.fileId,
          collectedAt: new Date().toISOString(),
        });
        console.log(`[serverpack/listInstalled] found ${installs.length} install(s); active=${active.fileId ?? "<none>"}`);
        for (const i of installs) console.log(`  ${i.isActive ? "*" : " "} ${i.fileId}  ${i.bytes} bytes`);
        return { dataHandles: [handle] };
      },
    },

    removeInstallation: {
      description: "Remove a server-pack install directory. Refuses if it's the active install unless force=true.",
      arguments: z.object({
        fileId: z.string().default("").describe("Required at runtime."),
        force: z.boolean().default(false).describe("Bypass the 'active install' guard"),
      }),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", serverParent, linkName } = context.globalArgs;
        reqHost(sshHost);
        if (!args.fileId) throw new Error("fileId is required");

        const dir = serverDirFor(serverParent, args.fileId);
        if (!(await remoteFileExists(sshHost, sshUser, dir))) {
          throw new Error(`No such install: ${dir}`);
        }
        const active = await readActiveFileId(sshHost, sshUser, serverParent, linkName);
        if (active.fileId === args.fileId && !args.force) {
          throw new Error(`Refusing to remove the active install (fileId=${args.fileId}). Activate a different install first, or pass force=true.`);
        }
        await sshExec(sshHost, sshUser, `rm -rf ${shquote(dir)}`);
        console.log(`[serverpack/removeInstallation] removed ${dir}`);
        // We don't write a resource because the install no longer exists.
        // Callers can run listInstalled to refresh state.
        return { dataHandles: [] };
      },
    },
  },
};
