#!/usr/bin/env node
// curseforge-scraper.js — called by the swamp @user/curseforge/modpack model.
//
// Uses a persistent chromium userDataDir so Cloudflare clearance cookies survive
// between runs. Once the context is warmed, we drive curseforge's internal JSON
// API (page.request.get) instead of scraping the DOM — much more stable.
//
// Usage:
//   node curseforge-scraper.js <method> <argsJson>
//
// Methods + args (argsJson is process.argv[3], not stdin):
//   resolveProjectId  { slug, userDataDir, headless }
//   listMainFiles     { slug, userDataDir, headless, pageSize? }
//   listServerPacks   { slug, userDataDir, headless, pageSize? }
//     -> walks the main-file list, fetches additional-files for each main
//        file whose hasServerPack=true, returns each server pack with the
//        parent main file's metadata attached.
//   discoverLatest    { slug, userDataDir, headless }
//     -> shorthand for "latest server pack". Returns one entry or null.
//   download          { slug, fileId, userDataDir, headless, downloadDir, downloadFilename? }
//     -> triggers a browser-initiated download via the page's /download/<id>
//        endpoint and saves it locally.
//   warmup            { slug, userDataDir, headless }
//     -> opens the page so a human can solve any Cloudflare challenge once.
//
// stdout: a single JSON object.
// stderr: progress + errors.

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const log = (msg) => process.stderr.write(`[cf/scraper] ${msg}\n`);

function modpackPageUrl(slug) {
  return `https://www.curseforge.com/minecraft/modpacks/${slug}`;
}
function fileDownloadUrl(slug, fileId) {
  return `https://www.curseforge.com/minecraft/modpacks/${slug}/download/${fileId}`;
}
function apiFiles(projectId, pageIndex, pageSize) {
  return `https://www.curseforge.com/api/v1/mods/${projectId}/files?pageIndex=${pageIndex}&pageSize=${pageSize}&sort=dateCreated&sortDescending=true`;
}
function apiAdditionalFiles(projectId, mainFileId) {
  return `https://www.curseforge.com/api/v1/mods/${projectId}/files/${mainFileId}/additional-files`;
}

async function ensureDir(p) { await fs.promises.mkdir(p, { recursive: true }); }

async function launchContext(userDataDir, headless) {
  await ensureDir(userDataDir);
  const channel = process.env.CHROME_CHANNEL || undefined;
  log(`launching chromium userDataDir=${userDataDir} headless=${headless} channel=${channel ?? "bundled"}`);
  return await chromium.launchPersistentContext(userDataDir, {
    headless: headless === true || headless === "true",
    channel,
    viewport: { width: 1400, height: 950 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    acceptDownloads: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

async function navigateAndClearCloudflare(page, url, { timeout = 60000 } = {}) {
  log(`goto ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  const title = await page.title().catch(() => "");
  if (/just a moment|attention required|cloudflare/i.test(title)) {
    log(`cloudflare interstitial detected — waiting up to 30s for auto-clear`);
    try {
      await page.waitForFunction(() => !/just a moment|attention required|cloudflare/i.test(document.title), null, { timeout: 30000 });
      log(`cloudflare cleared`);
    } catch {
      throw new Error("CLOUDFLARE_BLOCKED — run `warmup` headed to solve the challenge once: node scripts/curseforge-scraper.js warmup '{\"slug\":\"<slug>\",\"userDataDir\":\"<dir>\",\"headless\":false}'");
    }
  }
}

// Extract projectId from the schema.org JSON-LD on the modpack overview page.
async function extractProjectId(page, slug) {
  await navigateAndClearCloudflare(page, modpackPageUrl(slug));
  const projectId = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const s of scripts) {
      try {
        const j = JSON.parse(s.textContent || "{}");
        const stack = Array.isArray(j["@graph"]) ? j["@graph"] : [j];
        for (const node of stack) {
          if (node?.identifier && /^\d+$/.test(String(node.identifier))) return String(node.identifier);
          if (node?.mainEntity?.identifier && /^\d+$/.test(String(node.mainEntity.identifier))) return String(node.mainEntity.identifier);
        }
      } catch { /* keep looking */ }
    }
    return null;
  });
  if (!projectId) throw new Error(`Could not extract projectId from ${slug}`);
  log(`projectId for ${slug} = ${projectId}`);
  return projectId;
}

async function apiGet(page, url) {
  const resp = await page.request.get(url, { headers: { accept: "application/json" } });
  const status = resp.status();
  if (status !== 200) {
    const body = await resp.text();
    throw new Error(`API ${status} ${url}: ${body.slice(0, 200)}`);
  }
  return await resp.json();
}

async function listMainFilesPage(page, projectId, pageSize = 50) {
  const j = await apiGet(page, apiFiles(projectId, 0, pageSize));
  return j.data || [];
}

async function listServerPacksImpl(page, projectId, pageSize) {
  const mains = await listMainFilesPage(page, projectId, pageSize);
  const out = [];
  for (const main of mains) {
    if (!main.hasServerPack) continue;
    const j = await apiGet(page, apiAdditionalFiles(projectId, main.id));
    const additional = j.data || [];
    for (const sp of additional) {
      // additional files include other types — accept only "ServerPack" if the
      // API exposes a fileType, otherwise heuristically match the filename.
      const isServer = /server/i.test(sp.fileName || sp.displayName || "") || sp.fileType === "ServerPack";
      if (!isServer) continue;
      out.push({
        fileId: String(sp.id),
        fileName: sp.fileName,
        displayName: sp.displayName,
        fileSize: sp.fileLength,
        releaseType: sp.releaseType,           // 1=release,2=beta,3=alpha
        gameVersions: sp.gameVersions || [],
        dateCreated: sp.dateCreated,
        dateModified: sp.dateModified,
        parentFileId: String(main.id),
        parentFileName: main.fileName,
        parentDateCreated: main.dateCreated,
      });
    }
  }
  return out;
}

// ----- methods --------------------------------------------------------------

async function resolveProjectId(args) {
  const ctx = await launchContext(args.userDataDir, args.headless);
  try {
    const page = await ctx.newPage();
    const projectId = await extractProjectId(page, args.slug);
    return { slug: args.slug, projectId };
  } finally { await ctx.close(); }
}

async function listMainFiles(args) {
  const ctx = await launchContext(args.userDataDir, args.headless);
  try {
    const page = await ctx.newPage();
    const projectId = await extractProjectId(page, args.slug);
    const files = await listMainFilesPage(page, projectId, args.pageSize || 50);
    return { projectId, files };
  } finally { await ctx.close(); }
}

async function listServerPacks(args) {
  const ctx = await launchContext(args.userDataDir, args.headless);
  try {
    const page = await ctx.newPage();
    const projectId = await extractProjectId(page, args.slug);
    const files = await listServerPacksImpl(page, projectId, args.pageSize || 50);
    return { projectId, files };
  } finally { await ctx.close(); }
}

async function discoverLatest(args) {
  const ctx = await launchContext(args.userDataDir, args.headless);
  try {
    const page = await ctx.newPage();
    const projectId = await extractProjectId(page, args.slug);
    const files = await listServerPacksImpl(page, projectId, 20);
    if (files.length === 0) return { projectId, file: null };
    // server packs come ordered by main-file dateCreated desc
    return { projectId, file: files[0] };
  } finally { await ctx.close(); }
}

async function download(args) {
  const { slug, fileId, userDataDir, headless, downloadDir, downloadFilename } = args;
  if (!slug || !fileId || !userDataDir || !downloadDir) {
    throw new Error("download: slug, fileId, userDataDir, downloadDir required");
  }
  await ensureDir(downloadDir);

  const ctx = await launchContext(userDataDir, headless);
  try {
    const page = await ctx.newPage();
    // Warm cookies by visiting the modpack page (sets cf clearance for the path scope).
    await navigateAndClearCloudflare(page, modpackPageUrl(slug));

    const dlUrl = fileDownloadUrl(slug, fileId);
    log(`triggering download via ${dlUrl}`);
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 300000 }),
      page.evaluate((u) => { window.location.href = u; }, dlUrl),
    ]);
    const suggested = dl.suggestedFilename();
    const finalName = downloadFilename || suggested || `serverpack-${fileId}.zip`;
    const finalPath = path.join(downloadDir, finalName);
    await dl.saveAs(finalPath);
    const stat = await fs.promises.stat(finalPath);
    log(`saved ${finalPath} (${stat.size} bytes)`);
    return { fileId: String(fileId), fileName: finalName, localPath: finalPath, bytes: stat.size };
  } finally {
    await ctx.close();
  }
}

async function warmup(args) {
  const { slug, userDataDir, headless } = args;
  log(`warmup: opening ${slug} (headless=${headless}) — solve any Cloudflare challenge then close`);
  const ctx = await launchContext(userDataDir, headless);
  try {
    const page = await ctx.newPage();
    await page.goto(modpackPageUrl(slug), { waitUntil: "domcontentloaded", timeout: 120000 });
    // Hold the browser open long enough to solve a challenge manually if needed.
    await page.waitForTimeout(headless === false || headless === "false" ? 180000 : 5000);
  } finally { await ctx.close(); }
  return { ok: true };
}

// ----- main ----------------------------------------------------------------

async function main() {
  const [, , method, argsJson] = process.argv;
  if (!method) {
    process.stderr.write("Usage: curseforge-scraper.js <method> <argsJson>\n");
    process.exit(2);
  }
  const args = argsJson ? JSON.parse(argsJson) : {};
  let result;
  switch (method) {
    case "resolveProjectId": result = await resolveProjectId(args); break;
    case "listMainFiles":    result = await listMainFiles(args); break;
    case "listServerPacks":  result = await listServerPacks(args); break;
    case "discoverLatest":   result = await discoverLatest(args); break;
    case "download":         result = await download(args); break;
    case "warmup":           result = await warmup(args); break;
    default:
      process.stderr.write(`Unknown method: ${method}\n`);
      process.exit(2);
  }
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stderr.write(`[cf/scraper] FATAL ${err.stack || err.message || String(err)}\n`);
  process.exit(1);
});
