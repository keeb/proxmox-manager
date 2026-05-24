import { z } from "npm:zod@4";

// ── Schemas ──────────────────────────────────────────────────────────────────

const GlobalArgs = z.object({
  slug: z.string().describe("CurseForge modpack slug, e.g. 'project-infinity-0-1' (last URL segment)."),
  scraperScript: z.string().default("scripts/curseforge-scraper.js").describe("Path to the Node.js Playwright scraper, relative to repoDir."),
  chromeProfileDir: z.string().describe("Absolute path to a persistent chromium userDataDir. Wire from vault."),
  headless: z.boolean().default(true).describe("Run Playwright headless. Use false for the first-ever warmup."),
  downloadDir: z.string().default("/tmp/curseforge-downloads").describe("Local directory where downloaded server-pack zips are written."),
});

const FileSchema = z.object({
  fileId: z.string(),
  fileName: z.string(),
  displayName: z.string().optional(),
  fileSize: z.number().nullable(),
  releaseType: z.number().nullable().describe("1=release, 2=beta, 3=alpha"),
  gameVersions: z.array(z.string()).default([]),
  dateCreated: z.string().nullable(),
  dateModified: z.string().nullable(),
  parentFileId: z.string().nullable(),
  parentFileName: z.string().nullable(),
  parentDateCreated: z.string().nullable(),
  localPath: z.string().nullable().default(null).describe("Set after download() runs"),
  downloadedAt: z.string().nullable().default(null),
  bytesOnDisk: z.number().nullable().default(null),
  discoveredAt: z.string(),
});

const ProjectSchema = z.object({
  slug: z.string(),
  projectId: z.string(),
  // Pointer fields — kept on the project resource so workflows can chain
  // discoverLatest → download → deploy without knowing the fileId in advance.
  latestFileId: z.string().nullable().default(null),
  latestFileName: z.string().nullable().default(null),
  latestFileSize: z.number().nullable().default(null),
  latestDateCreated: z.string().nullable().default(null),
  latestLocalPath: z.string().nullable().default(null).describe("Convenience copy of file.localPath after the latest file has been downloaded"),
  resolvedAt: z.string(),
});

const DiscoverLatestArgs = z.object({});
const ListServerPacksArgs = z.object({
  pageSize: z.number().int().min(1).max(200).default(50).describe("Pages of main files to walk (each main file has at most one server pack)."),
});
const DownloadArgs = z.object({
  fileId: z.string().default("").describe("Server-pack file ID to download. If empty, downloads whatever discoverLatest currently has."),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function runScraper(repoDir, scraperScript, method, methodArgs) {
  const scriptPath = `${repoDir}/${scraperScript}`;
  console.log(`[curseforge/${method}] node ${scriptPath} ${method} ${JSON.stringify(methodArgs)}`);
  // @ts-ignore - Deno API
  const cmd = new Deno.Command("node", {
    args: [scriptPath, method, JSON.stringify(methodArgs)],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  const errText = new TextDecoder().decode(stderr);
  if (errText) console.log(errText.trim());
  if (code !== 0) {
    throw new Error(`curseforge-scraper.js ${method} failed (exit ${code}): ${errText.slice(-800)}`);
  }
  const outText = new TextDecoder().decode(stdout);
  if (!outText.trim()) throw new Error(`curseforge-scraper.js ${method} returned empty stdout`);
  try {
    return JSON.parse(outText);
  } catch (err) {
    throw new Error(`curseforge-scraper.js ${method} returned non-JSON: ${outText.slice(0, 200)}`);
  }
}

function discoveredFile(raw, now) {
  return {
    fileId: raw.fileId,
    fileName: raw.fileName,
    displayName: raw.displayName ?? raw.fileName,
    fileSize: raw.fileSize ?? null,
    releaseType: raw.releaseType ?? null,
    gameVersions: raw.gameVersions ?? [],
    dateCreated: raw.dateCreated ?? null,
    dateModified: raw.dateModified ?? null,
    parentFileId: raw.parentFileId ?? null,
    parentFileName: raw.parentFileName ?? null,
    parentDateCreated: raw.parentDateCreated ?? null,
    localPath: null,
    downloadedAt: null,
    bytesOnDisk: null,
    discoveredAt: now,
  };
}

// Look up an existing file resource for this fileId. We use queryData if
// available, otherwise the runtime returns undefined.
async function readExistingFile(context, fileId) {
  if (typeof context.readResource === "function") {
    try {
      const handle = await context.readResource("file", fileId);
      return handle?.attributes ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

// ── Model ────────────────────────────────────────────────────────────────────

export const model = {
  type: "@keeb/curseforge/modpack",
  version: "2026.05.16.2",
  resources: {
    project: {
      description: "CurseForge project metadata. Spec name 'project', instance name = projectSlug.",
      schema: ProjectSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    file: {
      description: "A CurseForge server-pack file. Instance name = fileId. Updated in place when downloaded.",
      schema: FileSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  globalArguments: GlobalArgs,
  methods: {
    discoverLatest: {
      description: "Hit CurseForge's internal API (via a Playwright-warmed context) and return the latest server-pack file. Writes a 'file' resource keyed by the server-pack fileId, plus a 'project' resource with the resolved projectId.",
      arguments: DiscoverLatestArgs,
      execute: async (_args, context) => {
        const { slug, scraperScript, chromeProfileDir, headless } = context.globalArgs;
        const now = new Date().toISOString();
        const result = await runScraper(context.repoDir, scraperScript, "discoverLatest", {
          slug, userDataDir: chromeProfileDir, headless,
        });
        const handles = [];
        if (!result.file) {
          handles.push(await context.writeResource("project", slug, {
            slug, projectId: result.projectId,
            latestFileId: null, latestFileName: null, latestFileSize: null,
            latestDateCreated: null, latestLocalPath: null,
            resolvedAt: now,
          }));
          console.log(`[curseforge/discoverLatest] No server pack found for slug=${slug}`);
          return { dataHandles: handles };
        }
        const existing = await readExistingFile(context, result.file.fileId);
        const fileData = {
          ...discoveredFile(result.file, now),
          localPath: existing?.localPath ?? null,
          downloadedAt: existing?.downloadedAt ?? null,
          bytesOnDisk: existing?.bytesOnDisk ?? null,
        };
        handles.push(await context.writeResource("file", result.file.fileId, fileData));
        handles.push(await context.writeResource("project", slug, {
          slug, projectId: result.projectId,
          latestFileId: fileData.fileId,
          latestFileName: fileData.fileName,
          latestFileSize: fileData.fileSize,
          latestDateCreated: fileData.dateCreated,
          latestLocalPath: fileData.localPath,
          resolvedAt: now,
        }));
        console.log(`[curseforge/discoverLatest] latest server pack: ${fileData.fileName} (fileId=${fileData.fileId}, ${fileData.fileSize ?? "?"} bytes, ${fileData.dateCreated})`);
        return { dataHandles: handles };
      },
    },

    listServerPacks: {
      description: "Enumerate server-pack files for this modpack (up to pageSize main-file pages). Writes one 'file' resource per server pack.",
      arguments: ListServerPacksArgs,
      execute: async (args, context) => {
        const { slug, scraperScript, chromeProfileDir, headless } = context.globalArgs;
        const now = new Date().toISOString();
        const result = await runScraper(context.repoDir, scraperScript, "listServerPacks", {
          slug, userDataDir: chromeProfileDir, headless, pageSize: args.pageSize,
        });
        const handles = [];
        // We don't update the project pointer here — that's discoverLatest's job.
        for (const raw of result.files || []) {
          const existing = await readExistingFile(context, raw.fileId);
          const fileData = {
            ...discoveredFile(raw, now),
            localPath: existing?.localPath ?? null,
            downloadedAt: existing?.downloadedAt ?? null,
            bytesOnDisk: existing?.bytesOnDisk ?? null,
          };
          handles.push(await context.writeResource("file", raw.fileId, fileData));
        }
        console.log(`[curseforge/listServerPacks] wrote ${handles.length - 1} server-pack files`);
        return { dataHandles: handles };
      },
    },

    download: {
      description: "Download the server-pack zip for a given fileId. Updates the 'file' resource with localPath, bytesOnDisk, downloadedAt.",
      arguments: DownloadArgs,
      execute: async (args, context) => {
        const { slug, scraperScript, chromeProfileDir, headless, downloadDir } = context.globalArgs;

        let fileId = args.fileId || "";
        let parentMeta = null;
        if (!fileId) {
          // Resolve "latest" against the API right now.
          const latest = await runScraper(context.repoDir, scraperScript, "discoverLatest", {
            slug, userDataDir: chromeProfileDir, headless,
          });
          if (!latest.file) throw new Error(`No server pack available for slug=${slug}`);
          fileId = latest.file.fileId;
          parentMeta = latest.file;
          console.log(`[curseforge/download] no fileId provided — using latest=${fileId}`);
        }

        // Idempotency: if the file is already on disk at the expected path with
        // the expected size, skip the curseforge round-trip entirely. The
        // playwright download is 600+ MB per run for Project Infinity.
        const existing = await readExistingFile(context, fileId);
        let dl;
        let skippedDownload = false;
        if (existing?.localPath && existing?.fileSize) {
          try {
            // @ts-ignore - Deno API
            const stat = await Deno.stat(existing.localPath);
            if (stat.isFile && stat.size === existing.fileSize) {
              console.log(`[curseforge/download] skipping download — ${existing.localPath} already on disk (${stat.size} bytes matches fileSize)`);
              dl = { fileId, fileName: existing.fileName, localPath: existing.localPath, bytes: stat.size };
              skippedDownload = true;
            }
          } catch { /* not on disk, proceed with download */ }
        }
        if (!dl) {
          dl = await runScraper(context.repoDir, scraperScript, "download", {
            slug, fileId, userDataDir: chromeProfileDir, headless, downloadDir,
          });
        }

        // Merge into existing or seed from parentMeta (latest discover result).
        const now = new Date().toISOString();
        const base = existing ?? (parentMeta ? discoveredFile(parentMeta, now) : null);
        if (!base) {
          // Last resort: write a minimal record with what the download returned.
          const fileData = {
            fileId, fileName: dl.fileName, displayName: dl.fileName,
            fileSize: dl.bytes, releaseType: null, gameVersions: [],
            dateCreated: null, dateModified: null,
            parentFileId: null, parentFileName: null, parentDateCreated: null,
            localPath: dl.localPath, downloadedAt: now, bytesOnDisk: dl.bytes,
            discoveredAt: now,
          };
          const h = await context.writeResource("file", fileId, fileData);
          return { dataHandles: [h] };
        }
        const fileData = {
          ...base,
          localPath: dl.localPath,
          downloadedAt: now,
          bytesOnDisk: dl.bytes,
        };
        const fileHandle = await context.writeResource("file", fileId, fileData);
        const handles = [fileHandle];
        // If this is the latest file (per the project pointer), refresh the
        // latestLocalPath so workflows can reference it without knowing fileId.
        let project = null;
        if (typeof context.readResource === "function") {
          try { project = (await context.readResource("project", slug))?.attributes ?? null; } catch { project = null; }
        }
        if (project && project.latestFileId === fileId) {
          handles.push(await context.writeResource("project", slug, {
            ...project,
            latestLocalPath: dl.localPath,
            resolvedAt: now,
          }));
        }
        console.log(`[curseforge/download] saved ${dl.localPath} (${dl.bytes} bytes)`);
        return { dataHandles: handles };
      },
    },
  },
};
