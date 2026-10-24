/**
 * @keeb/swamp/activity — "what actually ran" reporting over the shared
 * @keeb/mongodb-datastore.
 *
 * The datastore is the only place that sees every writer (this repo on
 * think.tank, slate's /opt/proxmox-manager crons, swamp-media, ...), so the
 * report is built straight off its collections rather than off any one host's
 * .swamp/ cache.
 *
 * Collections per repo, prefixed `t_<tenantId>_r_<namespace>_`:
 *   _paths  — { _id: relPath, hash, size, updatedAt, deletedAt }
 *   _blobs  — inline { _id: sha256, size, data: Binary }
 *             chunked { _id: sha256, size, chunkCount } + { _id: "<sha>:<i>", data }
 *
 * `updatedAt` only moves when a file's content hash changes (see pushChanged in
 * the datastore extension), so "path docs updated in the window" is a faithful
 * "written during the window".
 *
 * Ledgers read, and why:
 *   data/workflow/<id>/report-swamp-workflow-summary-json/<v>/raw
 *       one small doc per workflow run: name, run id, status, per-step
 *       model+method. Ephemeral cron containers push these, so this is the
 *       ledger that sees slate's runs.
 *   data/<type>/<id>/report-swamp-method-summary-json/<v>/raw
 *       one small doc per model method run: model, method, status, args.
 *   workflow-runs/<wfId>/workflow-run-<runId>.yaml
 *       the full run record — counted (and merged by run id) so runs whose
 *       reports were skipped still show up. Content is deliberately NOT read:
 *       run records embed step outputs including auth tickets.
 *   outputs/<type>/<method>/<modelId>-<ts>.log
 *       per-invocation output log, merged with the method summaries.
 *   definitions-evaluated/<type>/<id>.yaml — models created/changed
 *   workflows-evaluated/<id>.yaml          — workflows created/changed
 *   audit/commands-<date>.jsonl            — CLI command audit trail
 */
import { z } from "npm:zod@4";
import { MongoClient } from "npm:mongodb@6.12.0";

const GlobalArgs = z.object({
  mongoUri: z.string().describe(
    "MongoDB URI without credentials, e.g. mongodb://10.0.0.12:27017/?replicaSet=rs0&authSource=admin",
  ),
  mongoUser: z.string().default("").describe(
    "MongoDB username (empty = connect unauthenticated)",
  ),
  passwordEnv: z.string().default("MONGO_PASSWORD").describe(
    "Env var (falling back to <repoDir>/.env) holding the MongoDB password — same convention as the datastore config, which keeps the password out of the vault-derived redactor",
  ),
  database: z.string().default("swamp").describe("Database shared by all repos"),
  tenantId: z.string().default("keeb").describe(
    "Tenant whose namespaces are reported on",
  ),
});

const CountSchema = z.object({ key: z.string(), count: z.number() });

const ActivitySchema = z.object({
  generatedAt: z.string(),
  windowDays: z.number(),
  windowStart: z.string(),
  windowEnd: z.string(),
  host: z.string(),
  database: z.string(),
  tenantId: z.string(),
  // Flat who/action/when ledger across every namespace, newest first.
  // "who" is swamp's own notion of an actor: the workflow run and step that
  // drove the call, or the model itself when the method was invoked directly.
  // No human or host identity exists in any synced ledger to attribute to.
  events: z.array(z.object({
    at: z.string(),
    namespace: z.string(),
    actorKind: z.string(),
    actor: z.string(),
    action: z.string(),
    result: z.string(),
    detail: z.string(),
    runId: z.string(),
  })),
  eventsTruncated: z.boolean(),
  eventsTotal: z.number(),
  totals: z.object({
    namespaces: z.number(),
    workflowRuns: z.number(),
    methodRuns: z.number(),
    dataWrites: z.number(),
    modelsChanged: z.number(),
    workflowsChanged: z.number(),
    commands: z.number(),
    filesWritten: z.number(),
    bytesWritten: z.number(),
  }),
  namespaces: z.array(z.object({
    namespace: z.string(),
    files: z.object({
      written: z.number(),
      deleted: z.number(),
      bytes: z.number(),
      bySubdir: z.array(z.object({
        key: z.string(),
        count: z.number(),
        bytes: z.number(),
      })),
    }),
    workflowRuns: z.object({
      total: z.number(),
      fromSummaries: z.number(),
      fromRunRecords: z.number(),
      truncated: z.boolean(),
      byStatus: z.array(CountSchema),
      byWorkflow: z.array(z.object({
        key: z.string(),
        count: z.number(),
        succeeded: z.number(),
        failed: z.number(),
        other: z.number(),
        lastAt: z.string(),
      })),
      runs: z.array(z.object({
        workflow: z.string(),
        runId: z.string(),
        status: z.string(),
        at: z.string(),
        steps: z.number(),
        failedSteps: z.number(),
        stepDetail: z.string(),
      })),
    }),
    methodRuns: z.object({
      total: z.number(),
      fromSummaries: z.number(),
      fromOutputLogs: z.number(),
      truncated: z.boolean(),
      byStatus: z.array(CountSchema),
      byMethod: z.array(z.object({
        key: z.string(),
        count: z.number(),
        lastAt: z.string(),
      })),
      runs: z.array(z.object({
        at: z.string(),
        modelName: z.string(),
        modelType: z.string(),
        modelId: z.string(),
        method: z.string(),
        status: z.string(),
        narrative: z.string(),
      })),
    }),
    dataWrites: z.object({
      total: z.number(),
      truncated: z.boolean(),
      byModel: z.array(CountSchema),
      items: z.array(z.object({
        modelType: z.string(),
        modelId: z.string(),
        dataName: z.string(),
        version: z.number(),
        at: z.string(),
        bytes: z.number(),
      })),
    }),
    models: z.array(z.object({
      name: z.string(),
      type: z.string(),
      id: z.string(),
      version: z.number(),
      at: z.string(),
      isNew: z.boolean(),
    })),
    workflows: z.array(z.object({
      name: z.string(),
      id: z.string(),
      at: z.string(),
      schedule: z.string(),
    })),
    commands: z.object({
      total: z.number(),
      swamp: z.number(),
      other: z.number(),
      truncated: z.boolean(),
      sessions: z.number(),
      items: z.array(z.object({
        at: z.string(),
        command: z.string(),
        cwd: z.string(),
        sessionId: z.string(),
      })),
    }),
  })),
});

const OUTPUT_RE =
  /^outputs\/(.+)\/([^/]+)\/([0-9a-f-]{36})-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.log$/;
const DATA_RE = /^data\/(.+)\/([0-9a-f-]{36})\/(.+)\/(\d+)\/[^/]+$/;
const WF_SUMMARY_RE =
  /^data\/workflow\/([0-9a-f-]{36})\/report-swamp-workflow-summary-json\/\d+\/raw$/;
const METHOD_SUMMARY_RE =
  /^data\/(.+)\/([0-9a-f-]{36})\/report-swamp-method-summary-json\/\d+\/raw$/;
const RUN_YAML_RE =
  /^workflow-runs\/([0-9a-f-]{36})\/workflow-run-([0-9a-f-]{36})\.yaml$/;
const DEF_RE = /^definitions-evaluated\/(.+)\/([0-9a-f-]{36})\.yaml$/;
const WF_DEF_RE = /^workflows-evaluated\/([0-9a-f-]{36})\.yaml$/;
const AUDIT_RE = /^audit\/commands-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const SUFFIX_RE = /^t_(.+)_r_(.+?)_paths$/;

const BLOB_BATCH = 400;

// outputs/ filenames stamp the time as 2026-07-29T02-42-14-168Z.
function fileStampToIso(stamp: string): string {
  const [date, rest] = stamp.split("T");
  const t = rest.replace(/Z$/, "").split("-");
  return `${date}T${t[0]}:${t[1]}:${t[2]}.${t[3]}Z`;
}

// Evaluated definitions are machine-generated YAML whose scalars we need sit at
// the top level, so a line scan beats pulling in a YAML parser.
function topLevelScalars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_]*): +(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return out;
}

// Pull the step list out of a workflow run record without a YAML parser and
// without touching step outputs (which embed auth tickets). Indentation is
// fixed by the writer: `      - stepName:` opens a step, its own scalars sit at
// 8 spaces, and `output:`'s direct children — model/method — at 10. Anything
// deeper is resource attributes and is never matched.
function runRecordSteps(text: string): Array<{
  stepName: string;
  modelName: string;
  methodName: string;
  status: string;
  startedAt: string;
}> {
  const steps = [];
  let cur: {
    stepName: string;
    modelName: string;
    methodName: string;
    status: string;
    startedAt: string;
  } | null = null;
  for (const line of text.split("\n")) {
    const open = line.match(/^ {6}- stepName: +(.*)$/);
    if (open) {
      if (cur) steps.push(cur);
      cur = {
        stepName: open[1].trim().replace(/^['"]|['"]$/g, ""),
        modelName: "",
        methodName: "",
        status: "",
        startedAt: "",
      };
      continue;
    }
    if (!cur) continue;
    const own = line.match(/^ {8}(status|startedAt): +(.*)$/);
    if (own) {
      const v = own[2].trim().replace(/^['"]|['"]$/g, "");
      if (own[1] === "status" && !cur.status) cur.status = v;
      if (own[1] === "startedAt" && !cur.startedAt) cur.startedAt = v;
      continue;
    }
    const out = line.match(/^ {10}(model|method): +(.*)$/);
    if (out) {
      const v = out[2].trim().replace(/^['"]|['"]$/g, "");
      if (out[1] === "model" && !cur.modelName) cur.modelName = v;
      if (out[1] === "method" && !cur.methodName) cur.methodName = v;
    }
  }
  if (cur) steps.push(cur);
  // Steps of a run that was killed mid-flight carry no `output:` block, so
  // model/method stay empty here and are recovered from the workflow
  // definition by step name.
  return steps;
}

// stepName → model/method from an evaluated workflow definition, for runs whose
// records never got far enough to name what they called.
function workflowDefSteps(
  text: string,
): Map<string, { modelName: string; methodName: string }> {
  const out = new Map<string, { modelName: string; methodName: string }>();
  let stepName = "";
  let modelName = "";
  let methodName = "";
  const flush = () => {
    if (stepName && modelName && methodName) {
      out.set(stepName, { modelName, methodName });
    }
    modelName = "";
    methodName = "";
  };
  for (const line of text.split("\n")) {
    const open = line.match(/^ {6}- name: +(.*)$/);
    if (open) {
      flush();
      stepName = open[1].trim().replace(/^['"]|['"]$/g, "");
      continue;
    }
    const task = line.match(/^ {10}(modelIdOrName|methodName): +(.*)$/);
    if (task) {
      const v = task[2].trim().replace(/^['"]|['"]$/g, "");
      if (task[1] === "modelIdOrName") modelName = v;
      else methodName = v;
    }
  }
  flush();
  return out;
}

function bump(
  map: Map<string, { count: number; lastAt: string }>,
  key: string,
  at: string,
) {
  const cur = map.get(key);
  if (!cur) map.set(key, { count: 1, lastAt: at });
  else {
    cur.count += 1;
    if (at > cur.lastAt) cur.lastAt = at;
  }
}

function tallied(map: Map<string, { count: number; lastAt: string }>) {
  return [...map.entries()]
    .map(([key, v]) => ({ key, count: v.count, lastAt: v.lastAt }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

async function resolvePassword(
  envName: string,
  repoDir: string,
): Promise<string> {
  const fromEnv = Deno.env.get(envName);
  if (fromEnv) return fromEnv;
  try {
    const text = await Deno.readTextFile(`${repoDir}/.env`);
    for (const raw of text.split("\n")) {
      const m = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)$/);
      if (m && m[1] === envName) {
        return m[2].replace(/^['"]|['"]$/g, "");
      }
    }
  } catch {
    // no .env — fall through to unauthenticated
  }
  return "";
}

export const model = {
  type: "@keeb/swamp/activity",
  version: "2026.07.30.1",
  resources: {
    "activity": {
      description: "What ran across the datastore over a trailing window",
      schema: ActivitySchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  files: {
    "summary": {
      description: "Human-readable activity report",
      contentType: "text/markdown",
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  globalArguments: GlobalArgs,
  methods: {
    report: {
      description:
        "Report exactly what ran over a trailing window — workflow invocations, model method invocations, data versions written, models/workflows created or changed, and the CLI command audit trail — for every namespace under the tenant.",
      arguments: z.object({
        days: z.number().int().positive().default(7).describe(
          "Window size in days, counting back from now",
        ),
        namespace: z.string().default("").describe(
          "Limit to one namespace (empty = every namespace under the tenant)",
        ),
        maxDetail: z.number().int().positive().default(400).describe(
          "Per-list cap on itemized detail; aggregate counts stay exact",
        ),
        maxRunRecords: z.number().int().positive().default(1200).describe(
          "How many workflow run records to open for status/timing when no run summary was pushed; counts stay exact beyond the cap",
        ),
        maxRunRecordBytes: z.number().int().positive().default(524288).describe(
          "Skip opening run records larger than this (deploy runs embed every step output)",
        ),
        maxEvents: z.number().int().positive().default(2000).describe(
          "Rows kept in the flat who/action/when ledger; counts stay exact",
        ),
      }),
      execute: async (
        args: {
          days: number;
          namespace: string;
          maxDetail: number;
          maxRunRecords: number;
          maxRunRecordBytes: number;
          maxEvents: number;
        },
        context: {
          globalArgs: z.infer<typeof GlobalArgs>;
          repoDir: string;
          logger: {
            info: (msg: string, fields?: Record<string, unknown>) => void;
            warning: (msg: string, fields?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<unknown>;
          createFileWriter: (
            specName: string,
            name: string,
          ) => { writeText: (text: string) => Promise<unknown> };
        },
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = context.globalArgs;
        const end = new Date();
        const start = new Date(end.getTime() - args.days * 86400_000);
        const startIso = start.toISOString();
        const endIso = end.toISOString();
        const hostMatch = g.mongoUri.match(/\/\/(?:[^@]*@)?([^/?]+)/);
        const host = hostMatch ? hostMatch[1] : g.mongoUri;
        const password = await resolvePassword(g.passwordEnv, context.repoDir);

        const client = new MongoClient(g.mongoUri, {
          serverSelectionTimeoutMS: 15000,
          connectTimeoutMS: 15000,
          ...(g.mongoUser
            ? { auth: { username: g.mongoUser, password } }
            : {}),
        });

        try {
          await client.connect();
          const db = client.db(g.database);
          context.logger.info(
            "Scanning {db} on {host} for activity since {since}",
            { db: g.database, host, since: startIso },
          );

          const namespaces: string[] = [];
          for (const c of await db.listCollections().toArray()) {
            const m = c.name.match(SUFFIX_RE);
            if (!m) continue;
            if (m[1] !== g.tenantId) continue;
            if (args.namespace && m[2] !== args.namespace) continue;
            namespaces.push(m[2]);
          }
          namespaces.sort();
          if (namespaces.length === 0) {
            throw new Error(
              `No datastore namespaces found for tenant "${g.tenantId}" in database "${g.database}"`,
            );
          }

          // Batched blob reads — one $in per BLOB_BATCH hashes beats a findOne
          // per record when a busy week holds thousands of run summaries.
          const readBlobs = async (
            blobColl: string,
            hashes: string[],
          ): Promise<Map<string, string>> => {
            const out = new Map<string, string>();
            if (hashes.length === 0) return out;
            const blobs = db.collection(blobColl);
            const decoder = new TextDecoder();
            const unique = [...new Set(hashes)];
            for (let i = 0; i < unique.length; i += BLOB_BATCH) {
              const slice = unique.slice(i, i + BLOB_BATCH);
              const docs = await blobs
                // deno-lint-ignore no-explicit-any
                .find({ _id: { $in: slice as any } })
                // deno-lint-ignore no-explicit-any
                .toArray() as any[];
              for (const d of docs) {
                if (d.data) {
                  out.set(d._id, decoder.decode(new Uint8Array(d.data.buffer ?? d.data)));
                  continue;
                }
                if (!d.chunkCount) continue;
                const parts: Uint8Array[] = [];
                let ok = true;
                for (let n = 0; n < d.chunkCount; n++) {
                  const c = await blobs
                    // deno-lint-ignore no-explicit-any
                    .findOne({ _id: `${d._id}:${n}` as any }) as any;
                  if (!c?.data) {
                    ok = false;
                    break;
                  }
                  parts.push(new Uint8Array(c.data.buffer ?? c.data));
                }
                if (!ok) continue;
                const joined = new Uint8Array(
                  parts.reduce((n, p) => n + p.length, 0),
                );
                let at = 0;
                for (const p of parts) {
                  joined.set(p, at);
                  at += p.length;
                }
                out.set(d._id, decoder.decode(joined));
              }
            }
            return out;
          };

          // Run records embed every step output, so they are read in small
          // batches and discarded as we go rather than buffered.
          const streamBlobs = async (
            blobColl: string,
            hashes: string[],
            batchSize: number,
            onText: (hash: string, text: string) => void,
          ): Promise<void> => {
            const blobs = db.collection(blobColl);
            const decoder = new TextDecoder();
            const unique = [...new Set(hashes)];
            for (let i = 0; i < unique.length; i += batchSize) {
              const docs = await blobs
                // deno-lint-ignore no-explicit-any
                .find({ _id: { $in: unique.slice(i, i + batchSize) as any } })
                // deno-lint-ignore no-explicit-any
                .toArray() as any[];
              for (const d of docs) {
                if (!d.data) continue;
                onText(d._id, decoder.decode(new Uint8Array(d.data.buffer ?? d.data)));
              }
            }
          };

          const nsReports = [];
          const allEvents: Array<{
            at: string;
            namespace: string;
            actorKind: string;
            actor: string;
            action: string;
            result: string;
            detail: string;
            runId: string;
          }> = [];
          const totals = {
            namespaces: 0,
            workflowRuns: 0,
            methodRuns: 0,
            dataWrites: 0,
            modelsChanged: 0,
            workflowsChanged: 0,
            commands: 0,
            filesWritten: 0,
            bytesWritten: 0,
          };

          for (const ns of namespaces) {
            const prefix = `t_${g.tenantId}_r_${ns}`;
            const paths = db.collection(`${prefix}_paths`);
            const blobColl = `${prefix}_blobs`;
            context.logger.info("Reading {prefix}_paths", { prefix });
            // Idempotent; without it every report is a full collection scan.
            await paths.createIndex({ updatedAt: 1 });

            const touched = await paths
              .find(
                { updatedAt: { $gte: start } },
                {
                  projection: {
                    _id: 1,
                    hash: 1,
                    size: 1,
                    updatedAt: 1,
                    deletedAt: 1,
                  },
                },
              )
              // deno-lint-ignore no-explicit-any
              .toArray() as any[];

            const bySubdir = new Map<string, { count: number; bytes: number }>();
            let written = 0;
            let deleted = 0;
            let bytes = 0;

            const outputRuns: Array<{
              modelType: string;
              modelId: string;
              method: string;
              at: string;
            }> = [];
            const dataSeen = new Set<string>();
            const dataWrites: Array<{
              modelType: string;
              modelId: string;
              dataName: string;
              version: number;
              at: string;
              bytes: number;
            }> = [];
            const wfSummaryHashes: Array<{ hash: string; at: string }> = [];
            const methodSummaryHashes: Array<{ hash: string; at: string }> = [];
            const runRecords: Array<
              {
                workflowId: string;
                runId: string;
                at: string;
                hash: string;
                size: number;
              }
            > = [];
            const defHashes: Array<{ hash: string; at: string }> = [];
            const wfDefHashes: Array<{ hash: string; at: string }> = [];
            const auditHashes: string[] = [];

            for (const doc of touched) {
              const rel: string = doc._id;
              const at: string = new Date(doc.updatedAt).toISOString();
              const subdir = rel.split("/")[0] || "(root)";
              const cur = bySubdir.get(subdir) ?? { count: 0, bytes: 0 };
              cur.count += 1;
              cur.bytes += doc.size ?? 0;
              bySubdir.set(subdir, cur);
              if (doc.deletedAt) {
                deleted += 1;
                continue;
              }
              written += 1;
              bytes += doc.size ?? 0;

              const out = rel.match(OUTPUT_RE);
              if (out) {
                const stampedAt = fileStampToIso(out[4]);
                if (stampedAt >= startIso) {
                  outputRuns.push({
                    modelType: out[1],
                    method: out[2],
                    modelId: out[3],
                    at: stampedAt,
                  });
                }
                continue;
              }
              const runYaml = rel.match(RUN_YAML_RE);
              if (runYaml) {
                runRecords.push({
                  workflowId: runYaml[1],
                  runId: runYaml[2],
                  at,
                  hash: doc.hash,
                  size: doc.size ?? 0,
                });
                continue;
              }
              if (WF_SUMMARY_RE.test(rel)) wfSummaryHashes.push({ hash: doc.hash, at });
              else if (METHOD_SUMMARY_RE.test(rel)) {
                methodSummaryHashes.push({ hash: doc.hash, at });
              }
              const dat = rel.match(DATA_RE);
              if (dat) {
                const key = `${dat[1]}/${dat[2]}/${dat[3]}/${dat[4]}`;
                if (!dataSeen.has(key)) {
                  dataSeen.add(key);
                  dataWrites.push({
                    modelType: dat[1],
                    modelId: dat[2],
                    dataName: dat[3],
                    version: Number(dat[4]),
                    at,
                    bytes: doc.size ?? 0,
                  });
                }
                continue;
              }
              if (DEF_RE.test(rel)) {
                defHashes.push({ hash: doc.hash, at });
                continue;
              }
              if (WF_DEF_RE.test(rel)) {
                wfDefHashes.push({ hash: doc.hash, at });
                continue;
              }
              const aud = rel.match(AUDIT_RE);
              if (aud) auditHashes.push(doc.hash);
            }

            // ---- Workflow invocations ------------------------------------
            const runsById = new Map<string, {
              workflow: string;
              runId: string;
              status: string;
              at: string;
              steps: number;
              failedSteps: number;
              stepDetail: string;
            }>();
            const stepsByRunId = new Map<
              string,
              Array<{ stepName: string; modelName: string; methodName: string }>
            >();
            const runEndsById = new Map<string, string>();
            const exactStepsByRunId = new Map<
              string,
              ReturnType<typeof runRecordSteps>
            >();
            const runWorkflowId = new Map<string, string>();
            let fromSummaries = 0;
            const wfBlobs = await readBlobs(
              blobColl,
              wfSummaryHashes.map((h) => h.hash),
            );
            for (const h of wfSummaryHashes) {
              const text = wfBlobs.get(h.hash);
              if (!text) continue;
              let s: Record<string, unknown>;
              try {
                s = JSON.parse(text);
              } catch {
                continue;
              }
              const runId = String(s.workflowRunId ?? "");
              if (!runId) continue;
              // deno-lint-ignore no-explicit-any
              const steps = (s.steps as any[]) ?? [];
              stepsByRunId.set(
                runId,
                steps.map((st) => ({
                  stepName: String(st.stepName ?? ""),
                  modelName: String(st.modelName ?? ""),
                  methodName: String(st.methodName ?? ""),
                })),
              );
              runsById.set(runId, {
                workflow: String(s.workflowName ?? "(unknown)"),
                runId,
                status: String(s.status ?? "unknown"),
                at: h.at,
                steps: Number(s.totalSteps ?? steps.length),
                failedSteps: Number(s.failed ?? 0),
                stepDetail: steps
                  .map((st) =>
                    `${st.stepName}:${st.modelName}.${st.methodName}=${st.status}`
                  )
                  .join(" · "),
              });
              fromSummaries += 1;
            }
            // Run records cover runs whose summary report was never pushed —
            // in practice most of them, since the ephemeral cron containers
            // push run records but not the runs index. Only the top-level
            // scalars are read; step outputs (which embed auth tickets) are
            // never touched.
            let fromRunRecords = 0;
            const needRecord = runRecords
              .filter((r) => !runsById.has(r.runId))
              .sort((a, b) => b.at.localeCompare(a.at));
            const openable = needRecord
              .filter((r) => r.size > 0 && r.size <= args.maxRunRecordBytes)
              .slice(0, args.maxRunRecords);
            const byHash = new Map<string, typeof openable>();
            for (const r of openable) {
              const list = byHash.get(r.hash) ?? [];
              list.push(r);
              byHash.set(r.hash, list);
            }
            const parsedByRunId = new Map<
              string,
              { workflow: string; status: string; startedAt: string; completedAt: string }
            >();
            if (openable.length > 0) {
              context.logger.info(
                "Opening {n} workflow run records in {ns}",
                { n: openable.length, ns },
              );
              await streamBlobs(blobColl, [...byHash.keys()], 25, (hash, text) => {
                const s = topLevelScalars(text);
                const steps = runRecordSteps(text);
                for (const r of byHash.get(hash) ?? []) {
                  parsedByRunId.set(r.runId, {
                    workflow: s.workflowName ?? "",
                    status: s.status ?? "unknown",
                    startedAt: s.startedAt ?? "",
                    completedAt: s.completedAt ?? "",
                  });
                  if (steps.length > 0) exactStepsByRunId.set(r.runId, steps);
                }
              });
            }
            for (const r of needRecord) {
              const parsed = parsedByRunId.get(r.runId);
              runWorkflowId.set(r.runId, r.workflowId);
              if (parsed?.completedAt) runEndsById.set(r.runId, parsed.completedAt);
              runsById.set(r.runId, {
                workflow: parsed?.workflow || `workflow:${r.workflowId}`,
                runId: r.runId,
                status: parsed?.status ?? "unrecorded",
                at: parsed?.startedAt || r.at,
                steps: 0,
                failedSteps: 0,
                stepDetail: "",
              });
              fromRunRecords += 1;
            }

            // ---- Models / workflows created or changed --------------------
            const defBlobs = await readBlobs(
              blobColl,
              defHashes.map((h) => h.hash),
            );
            const models = [];
            for (const d of defHashes) {
              const text = defBlobs.get(d.hash);
              if (!text) continue;
              const s = topLevelScalars(text);
              models.push({
                name: s.name ?? "(unnamed)",
                type: s.type ?? "(unknown)",
                id: s.id ?? "",
                version: Number(s.version ?? 0),
                at: d.at,
                isNew: Number(s.version ?? 0) <= 1,
              });
            }
            models.sort((a, b) => b.at.localeCompare(a.at));

            const wfDefBlobs = await readBlobs(
              blobColl,
              wfDefHashes.map((h) => h.hash),
            );
            const workflows = [];
            const wfNameById = new Map<string, string>();
            for (const d of wfDefHashes) {
              const text = wfDefBlobs.get(d.hash);
              if (!text) continue;
              const s = topLevelScalars(text);
              const sched = text.match(/^\s+schedule: +(.*)$/m);
              if (s.id && s.name) wfNameById.set(s.id, s.name);
              workflows.push({
                name: s.name ?? "(unnamed)",
                id: s.id ?? "",
                at: d.at,
                schedule: sched ? sched[1].trim().replace(/^['"]|['"]$/g, "") : "",
              });
            }
            workflows.sort((a, b) => b.at.localeCompare(a.at));
            // Definitions for every workflow that ran, whether or not it
            // changed during the window: they carry both the display name and
            // the stepName → model.method map used to attribute killed runs.
            const defStepsById = new Map<
              string,
              ReturnType<typeof workflowDefSteps>
            >();
            const ranWorkflowIds = new Set(runRecords.map((r) => r.workflowId));
            for (const run of runsById.values()) {
              if (run.workflow.startsWith("workflow:")) {
                ranWorkflowIds.add(run.workflow.slice("workflow:".length));
              }
            }
            if (ranWorkflowIds.size > 0) {
              const wanted = [...ranWorkflowIds].map((id) =>
                `workflows-evaluated/${id}.yaml`
              );
              const defDocs = await paths
                // deno-lint-ignore no-explicit-any
                .find(
                  // deno-lint-ignore no-explicit-any
                  { _id: { $in: wanted as any } },
                  { projection: { _id: 1, hash: 1 } },
                )
                // deno-lint-ignore no-explicit-any
                .toArray() as any[];
              const lookup = await readBlobs(
                blobColl,
                defDocs.map((d) => d.hash),
              );
              for (const d of defDocs) {
                const text = lookup.get(d.hash);
                if (!text) continue;
                const s = topLevelScalars(text);
                if (s.id && s.name) wfNameById.set(s.id, s.name);
                const id = s.id ||
                  String(d._id).replace(/^workflows-evaluated\//, "").replace(
                    /\.yaml$/,
                    "",
                  );
                defStepsById.set(id, workflowDefSteps(text));
              }
            }
            for (const run of runsById.values()) {
              if (!run.workflow.startsWith("workflow:")) continue;
              const named = wfNameById.get(run.workflow.slice("workflow:".length));
              if (named) run.workflow = named;
            }

            const runs = [...runsById.values()].sort((a, b) =>
              b.at.localeCompare(a.at)
            );
            const statusTally = new Map<string, { count: number; lastAt: string }>();
            const wfTally = new Map<string, {
              count: number;
              succeeded: number;
              failed: number;
              other: number;
              lastAt: string;
            }>();
            for (const r of runs) {
              bump(statusTally, r.status, r.at);
              const cur = wfTally.get(r.workflow) ??
                { count: 0, succeeded: 0, failed: 0, other: 0, lastAt: "" };
              cur.count += 1;
              if (r.status === "succeeded") cur.succeeded += 1;
              else if (r.status === "failed") cur.failed += 1;
              else cur.other += 1;
              if (r.at > cur.lastAt) cur.lastAt = r.at;
              wfTally.set(r.workflow, cur);
            }

            // ---- Model method invocations ---------------------------------
            const methodRuns: Array<{
              at: string;
              modelName: string;
              modelType: string;
              modelId: string;
              method: string;
              status: string;
              narrative: string;
            }> = [];
            const methodBlobs = await readBlobs(
              blobColl,
              methodSummaryHashes.map((h) => h.hash),
            );
            for (const h of methodSummaryHashes) {
              const text = methodBlobs.get(h.hash);
              if (!text) continue;
              let s: Record<string, unknown>;
              try {
                s = JSON.parse(text);
              } catch {
                continue;
              }
              methodRuns.push({
                at: h.at,
                modelName: String(s.modelName ?? ""),
                modelType: String(s.modelType ?? ""),
                modelId: String(s.modelId ?? ""),
                method: String(s.methodName ?? "(unknown)"),
                status: String(s.status ?? "unknown"),
                narrative: String(s.narrative ?? ""),
              });
            }
            const methodSummaryCount = methodRuns.length;
            // An output log and a method summary describe the same invocation;
            // keep an output log only when no summary for that model+method
            // lands within a minute of it.
            let fromOutputLogs = 0;
            for (const o of outputRuns) {
              const t = Date.parse(o.at);
              const dup = methodRuns.some((m) =>
                m.modelId === o.modelId && m.method === o.method &&
                Math.abs(Date.parse(m.at) - t) < 60_000
              );
              if (dup) continue;
              methodRuns.push({
                at: o.at,
                modelName: "",
                modelType: o.modelType,
                modelId: o.modelId,
                method: o.method,
                status: "unknown",
                narrative: "",
              });
              fromOutputLogs += 1;
            }
            methodRuns.sort((a, b) => b.at.localeCompare(a.at));

            const methodTally = new Map<string, { count: number; lastAt: string }>();
            const methodStatus = new Map<string, { count: number; lastAt: string }>();
            for (const m of methodRuns) {
              bump(
                methodTally,
                `${m.modelName || m.modelType} · ${m.method}`,
                m.at,
              );
              bump(methodStatus, m.status, m.at);
            }

            // ---- who / action / when ledger --------------------------------
            // A method run is attributed to the workflow step that named it in
            // its run summary (exact). Cron containers push no summary, so the
            // fallback is the workflow run whose window contains the call —
            // marked inferred rather than presented as fact.
            const stepIndex = new Map<
              string,
              Array<{ runId: string; workflow: string; at: string; stepName: string }>
            >();
            for (const [runId, steps] of stepsByRunId) {
              const run = runsById.get(runId);
              if (!run) continue;
              for (const st of steps) {
                const key = `${st.modelName}|${st.methodName}`;
                const list = stepIndex.get(key) ?? [];
                list.push({
                  runId,
                  workflow: run.workflow,
                  at: run.at,
                  stepName: st.stepName,
                });
                stepIndex.set(key, list);
              }
            }
            const runsByStart = [...runsById.values()]
              .filter((r) => r.at)
              .sort((a, b) => a.at.localeCompare(b.at));

            for (const r of runs) {
              allEvents.push({
                at: r.at,
                namespace: ns,
                actorKind: "workflow-run",
                actor: r.workflow,
                action: r.steps
                  ? `workflow run · ${r.steps} steps`
                  : "workflow run",
                result: r.status,
                detail: r.stepDetail,
                runId: r.runId,
              });
            }

            // Steps read straight out of run records: exact actor, exact time.
            // These supersede the method-summary rows for the same calls.
            const coveredByStep: Array<{ key: string; at: number }> = [];
            for (const [runId, steps] of exactStepsByRunId) {
              const run = runsById.get(runId);
              if (!run) continue;
              const fromDef = defStepsById.get(runWorkflowId.get(runId) ?? "");
              for (const raw of steps) {
                const filled = fromDef?.get(raw.stepName);
                const st = {
                  ...raw,
                  modelName: raw.modelName || filled?.modelName || "",
                  methodName: raw.methodName || filled?.methodName || "",
                };
                if (!st.modelName || !st.methodName) continue;
                const at = st.startedAt || run.at;
                allEvents.push({
                  at,
                  namespace: ns,
                  actorKind: "workflow-step",
                  actor: `${run.workflow} › ${st.stepName}`,
                  action: `${st.modelName}.${st.methodName}`,
                  result: st.status || "unknown",
                  detail: "",
                  runId,
                });
                coveredByStep.push({
                  key: `${st.modelName}|${st.methodName}`,
                  at: Date.parse(at),
                });
              }
            }

            for (const m of methodRuns) {
              const model = m.modelName || m.modelType;
              const t = Date.parse(m.at);
              // Drop the summary row when a run record already recorded this
              // call — otherwise every cron step appears twice.
              const key = `${m.modelName}|${m.method}`;
              if (
                coveredByStep.some((c) =>
                  c.key === key && Math.abs(c.at - t) <= 900_000
                )
              ) continue;
              let actorKind = "direct-method";
              let actor = model;
              let runId = "";

              const exact = stepIndex.get(`${m.modelName}|${m.method}`) ?? [];
              let best: typeof exact[number] | null = null;
              let bestDelta = Infinity;
              for (const c of exact) {
                const d = Math.abs(Date.parse(c.at) - t);
                if (d < bestDelta && d <= 900_000) {
                  bestDelta = d;
                  best = c;
                }
              }
              if (best) {
                actorKind = "workflow-step";
                actor = `${best.workflow} › ${best.stepName}`;
                runId = best.runId;
              } else {
                // Latest run started at or before the call, still open or
                // closed less than a minute before it.
                for (let i = runsByStart.length - 1; i >= 0; i--) {
                  const r = runsByStart[i];
                  const startedMs = Date.parse(r.at);
                  if (startedMs > t) continue;
                  if (t - startedMs > 900_000) break;
                  const ended = runEndsById.get(r.runId);
                  if (ended && Date.parse(ended) + 60_000 < t) break;
                  actorKind = "workflow-run-inferred";
                  actor = `${r.workflow} (inferred)`;
                  runId = r.runId;
                  break;
                }
              }

              allEvents.push({
                at: m.at,
                namespace: ns,
                actorKind,
                actor,
                action: `${model}.${m.method}`,
                result: m.status,
                detail: m.narrative,
                runId,
              });
            }

            const modelTally = new Map<string, { count: number; lastAt: string }>();
            for (const d of dataWrites) bump(modelTally, d.modelType, d.at);
            dataWrites.sort((a, b) => b.at.localeCompare(a.at));

            // ---- CLI command audit ----------------------------------------
            const commands: Array<
              { at: string; command: string; cwd: string; sessionId: string }
            > = [];
            const sessions = new Set<string>();
            let swampCommands = 0;
            const auditBlobs = await readBlobs(blobColl, auditHashes);
            for (const hash of auditHashes) {
              const text = auditBlobs.get(hash);
              if (!text) continue;
              for (const line of text.split("\n")) {
                if (!line.trim()) continue;
                let rec: Record<string, unknown>;
                try {
                  rec = JSON.parse(line);
                } catch {
                  continue;
                }
                const at = String(rec.timestamp ?? "");
                if (at < startIso) continue;
                const cmd = String(rec.command ?? "");
                commands.push({
                  at,
                  command: cmd,
                  cwd: String(rec.cwd ?? ""),
                  sessionId: String(rec.sessionId ?? ""),
                });
                if (rec.sessionId) sessions.add(String(rec.sessionId));
                if (/(^|\W)swamp\s/.test(cmd)) swampCommands += 1;
              }
            }
            commands.sort((a, b) => b.at.localeCompare(a.at));

            totals.namespaces += 1;
            totals.workflowRuns += runs.length;
            totals.methodRuns += methodRuns.length;
            totals.dataWrites += dataWrites.length;
            totals.modelsChanged += models.length;
            totals.workflowsChanged += workflows.length;
            totals.commands += commands.length;
            totals.filesWritten += written;
            totals.bytesWritten += bytes;

            nsReports.push({
              namespace: ns,
              files: {
                written,
                deleted,
                bytes,
                bySubdir: [...bySubdir.entries()]
                  .map(([key, v]) => ({ key, count: v.count, bytes: v.bytes }))
                  .sort((a, b) => b.count - a.count),
              },
              workflowRuns: {
                total: runs.length,
                fromSummaries,
                fromRunRecords,
                truncated: runs.length > args.maxDetail,
                byStatus: tallied(statusTally).map((t) => ({
                  key: t.key,
                  count: t.count,
                })),
                byWorkflow: [...wfTally.entries()]
                  .map(([key, v]) => ({ key, ...v }))
                  .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
                runs: runs.slice(0, args.maxDetail),
              },
              methodRuns: {
                total: methodRuns.length,
                fromSummaries: methodSummaryCount,
                fromOutputLogs,
                truncated: methodRuns.length > args.maxDetail,
                byStatus: tallied(methodStatus).map((t) => ({
                  key: t.key,
                  count: t.count,
                })),
                byMethod: tallied(methodTally),
                runs: methodRuns.slice(0, args.maxDetail),
              },
              dataWrites: {
                total: dataWrites.length,
                truncated: dataWrites.length > args.maxDetail,
                byModel: tallied(modelTally).map((t) => ({
                  key: t.key,
                  count: t.count,
                })),
                items: dataWrites.slice(0, args.maxDetail),
              },
              models,
              workflows,
              commands: {
                total: commands.length,
                swamp: swampCommands,
                other: commands.length - swampCommands,
                truncated: commands.length > args.maxDetail,
                sessions: sessions.size,
                items: commands.slice(0, args.maxDetail),
              },
            });
          }

          allEvents.sort((a, b) => b.at.localeCompare(a.at));

          const report = {
            generatedAt: endIso,
            windowDays: args.days,
            windowStart: startIso,
            windowEnd: endIso,
            host,
            database: g.database,
            tenantId: g.tenantId,
            events: allEvents.slice(0, args.maxEvents),
            eventsTruncated: allEvents.length > args.maxEvents,
            eventsTotal: allEvents.length,
            totals,
            namespaces: nsReports,
          };

          const markdown = renderMarkdown(report);
          const handle = await context.writeResource(
            "activity",
            `window-${args.days}d`,
            report,
          );
          const mdHandle = await context
            .createFileWriter("summary", `summary-${args.days}d`)
            .writeText(markdown);

          context.logger.info(
            "{workflows} workflow runs, {methods} method runs, {data} data versions across {ns} namespaces",
            {
              workflows: totals.workflowRuns,
              methods: totals.methodRuns,
              data: totals.dataWrites,
              ns: totals.namespaces,
            },
          );

          return { dataHandles: [handle, mdHandle] };
        } finally {
          await client.close();
        }
      },
    },
  },
};

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// deno-lint-ignore no-explicit-any
function renderMarkdown(r: any): string {
  const L: string[] = [];
  const t = r.totals;
  L.push(`# Swamp activity — trailing ${r.windowDays} days`);
  L.push("");
  L.push(`**Window:** ${r.windowStart} → ${r.windowEnd}`);
  L.push(
    `**Datastore:** \`${r.database}\` on \`${r.host}\` (tenant \`${r.tenantId}\`)`,
  );
  L.push("");
  L.push(
    `${t.workflowRuns} workflow runs · ${t.methodRuns} model method runs · ` +
      `${t.dataWrites} data versions · ${t.modelsChanged} model definitions changed · ` +
      `${t.workflowsChanged} workflow definitions changed · ${t.commands} CLI commands · ` +
      `${t.filesWritten} files (${(t.bytesWritten / 1048576).toFixed(1)} MiB) ` +
      `across ${t.namespaces} namespace(s).`,
  );

  L.push("");
  L.push(`## Ledger — who did what, when (${r.eventsTotal} events)`);
  L.push("");
  L.push(
    "_\"Who\" is swamp's own actor: the workflow run and step that drove the call " +
      "(`›`), or the model itself for a direct invocation. Runs whose containers " +
      "pushed no summary are attributed by time window and marked `(inferred)`. " +
      "No human or host identity is recorded anywhere swamp syncs._",
  );
  L.push("");
  L.push("| when | who | action | result |");
  L.push("| --- | --- | --- | --- |");
  for (const e of r.events) {
    const who = e.actorKind === "direct-method"
      ? `${cell(e.actor)} _(direct)_`
      : cell(e.actor);
    L.push(
      `| ${e.at} | ${who} | ${cell(e.action)} | ${e.result} |`,
    );
  }
  if (r.eventsTruncated) {
    L.push("");
    L.push(
      `_Ledger truncated to the most recent ${r.events.length} of ${r.eventsTotal} events._`,
    );
  }

  for (const ns of r.namespaces) {
    L.push("");
    L.push(`## Namespace \`${ns.namespace}\``);

    L.push("");
    L.push(
      `### Workflow invocations — ${ns.workflowRuns.total} ` +
        `(${ns.workflowRuns.fromSummaries} from run summaries, ` +
        `${ns.workflowRuns.fromRunRecords} from run records only)`,
    );
    if (ns.workflowRuns.total === 0) {
      L.push("");
      L.push("_None._");
    } else {
      L.push("");
      L.push("| workflow | runs | succeeded | failed | other | last run |");
      L.push("| --- | --- | --- | --- | --- | --- |");
      for (const w of ns.workflowRuns.byWorkflow) {
        L.push(
          `| ${cell(w.key)} | ${w.count} | ${w.succeeded} | ${w.failed} | ${w.other} | ${w.lastAt} |`,
        );
      }
      L.push("");
      L.push("<details><summary>Every run</summary>");
      L.push("");
      L.push("| at | workflow | status | steps | detail | run id |");
      L.push("| --- | --- | --- | --- | --- | --- |");
      for (const run of ns.workflowRuns.runs) {
        const steps = run.steps
          ? `${run.steps - run.failedSteps}/${run.steps} ok`
          : "—";
        L.push(
          `| ${run.at} | ${cell(run.workflow)} | ${run.status} | ${steps} | ${cell(run.stepDetail)} | \`${run.runId}\` |`,
        );
      }
      if (ns.workflowRuns.truncated) {
        L.push("");
        L.push(`_Itemized list truncated; ${ns.workflowRuns.total} runs total._`);
      }
      L.push("");
      L.push("</details>");
    }

    L.push("");
    L.push(
      `### Model method invocations — ${ns.methodRuns.total} ` +
        `(${ns.methodRuns.fromSummaries} from method summaries, ` +
        `${ns.methodRuns.fromOutputLogs} from output logs only)`,
    );
    if (ns.methodRuns.total === 0) {
      L.push("");
      L.push("_None._");
    } else {
      L.push("");
      L.push("| model · method | runs | last run |");
      L.push("| --- | --- | --- |");
      for (const m of ns.methodRuns.byMethod) {
        L.push(`| ${cell(m.key)} | ${m.count} | ${m.lastAt} |`);
      }
      L.push("");
      L.push(
        `Status: ${
          ns.methodRuns.byStatus.map((s: { key: string; count: number }) =>
            `${s.count} ${s.key}`
          ).join(", ")
        }`,
      );
      L.push("");
      L.push("<details><summary>Every invocation</summary>");
      L.push("");
      L.push("| at | model | method | status | what it did |");
      L.push("| --- | --- | --- | --- | --- |");
      for (const m of ns.methodRuns.runs) {
        L.push(
          `| ${m.at} | ${cell(m.modelName || m.modelType)} | ${m.method} | ${m.status} | ${cell(m.narrative)} |`,
        );
      }
      if (ns.methodRuns.truncated) {
        L.push("");
        L.push(
          `_Itemized list truncated; ${ns.methodRuns.total} invocations total._`,
        );
      }
      L.push("");
      L.push("</details>");
    }

    L.push("");
    L.push(`### Models created or changed — ${ns.models.length}`);
    if (ns.models.length === 0) {
      L.push("");
      L.push("_None._");
    } else {
      L.push("");
      L.push("| at | model | type | definition version | new? |");
      L.push("| --- | --- | --- | --- | --- |");
      for (const m of ns.models) {
        L.push(
          `| ${m.at} | ${cell(m.name)} | ${cell(m.type)} | v${m.version} | ${m.isNew ? "**new**" : "changed"} |`,
        );
      }
    }

    L.push("");
    L.push(`### Workflows created or changed — ${ns.workflows.length}`);
    if (ns.workflows.length === 0) {
      L.push("");
      L.push("_None._");
    } else {
      L.push("");
      L.push("| at | workflow | schedule |");
      L.push("| --- | --- | --- |");
      for (const w of ns.workflows) {
        L.push(`| ${w.at} | ${cell(w.name)} | ${w.schedule || "—"} |`);
      }
    }

    L.push("");
    L.push(`### Data written — ${ns.dataWrites.total} versions`);
    if (ns.dataWrites.total === 0) {
      L.push("");
      L.push("_None._");
    } else {
      L.push("");
      L.push("| model type | versions |");
      L.push("| --- | --- |");
      for (const d of ns.dataWrites.byModel) {
        L.push(`| ${cell(d.key)} | ${d.count} |`);
      }
      L.push("");
      L.push("<details><summary>Most recent versions</summary>");
      L.push("");
      L.push("| at | model type | data | version | bytes |");
      L.push("| --- | --- | --- | --- | --- |");
      for (const d of ns.dataWrites.items) {
        L.push(
          `| ${d.at} | ${cell(d.modelType)} | ${cell(d.dataName)} | v${d.version} | ${d.bytes} |`,
        );
      }
      if (ns.dataWrites.truncated) {
        L.push("");
        L.push(
          `_Itemized list truncated; ${ns.dataWrites.total} versions total._`,
        );
      }
      L.push("");
      L.push("</details>");
    }

    L.push("");
    L.push(
      `### Datastore footprint — ${ns.files.written} files written, ` +
        `${ns.files.deleted} deleted, ${(ns.files.bytes / 1048576).toFixed(1)} MiB`,
    );
    L.push("");
    L.push("| subdir | files | bytes |");
    L.push("| --- | --- | --- |");
    for (const s of ns.files.bySubdir) {
      L.push(`| ${s.key} | ${s.count} | ${s.bytes} |`);
    }

    L.push("");
    L.push(
      `### CLI command audit — ${ns.commands.total} ` +
        `(${ns.commands.swamp} swamp, ${ns.commands.other} other, ` +
        `${ns.commands.sessions} session(s))`,
    );
    if (ns.commands.total === 0) {
      L.push("");
      L.push(
        "_None — only hosts running the `swamp audit record` hook contribute here._",
      );
    } else {
      L.push("");
      L.push("<details><summary>Every command</summary>");
      L.push("");
      L.push("| at | command |");
      L.push("| --- | --- |");
      for (const c of ns.commands.items) {
        L.push(`| ${c.at} | \`${cell(c.command)}\` |`);
      }
      if (ns.commands.truncated) {
        L.push("");
        L.push(`_Itemized list truncated; ${ns.commands.total} commands total._`);
      }
      L.push("");
      L.push("</details>");
    }
  }

  L.push("");
  return L.join("\n");
}
