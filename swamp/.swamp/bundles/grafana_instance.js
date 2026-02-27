// extensions/models/grafana_instance.ts
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

// extensions/models/lib/grafana.ts
async function grafanaApiGet(sshHost, sshUser, path) {
  const cmd = `docker exec grafana curl -sf 'http://localhost:3000${path}' -H 'Content-Type: application/json'`;
  const result = await sshExec(sshHost, sshUser, cmd);
  return JSON.parse(result.stdout);
}
async function grafanaApiPost(sshHost, sshUser, path, body) {
  const escaped = JSON.stringify(JSON.stringify(body));
  const cmd = `docker exec grafana curl -sf -X POST 'http://localhost:3000${path}' -H 'Content-Type: application/json' -d ${escaped}`;
  const result = await sshExec(sshHost, sshUser, cmd);
  if (!result.stdout.trim()) return {};
  return JSON.parse(result.stdout);
}
async function grafanaApiPut(sshHost, sshUser, path, body) {
  const escaped = JSON.stringify(JSON.stringify(body));
  const cmd = `docker exec grafana curl -sf -X PUT 'http://localhost:3000${path}' -H 'Content-Type: application/json' -d ${escaped}`;
  const result = await sshExec(sshHost, sshUser, cmd);
  if (!result.stdout.trim()) return {};
  return JSON.parse(result.stdout);
}
async function grafanaApiPostFile(sshHost, sshUser, path, localFilePath) {
  const tmpName = `grafana-upload-${Date.now()}.json`;
  const remoteTmp = `/tmp/${tmpName}`;
  const containerTmp = `/tmp/${tmpName}`;
  const scp = new Deno.Command("scp", {
    args: [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "ConnectTimeout=10",
      localFilePath,
      `${sshUser}@${sshHost}:${remoteTmp}`
    ]
  });
  const scpResult = await scp.output();
  if (scpResult.code !== 0) {
    const err = new TextDecoder().decode(scpResult.stderr);
    throw new Error(`SCP to ${sshHost} failed: ${err}`);
  }
  try {
    await sshExec(sshHost, sshUser, `docker cp ${remoteTmp} grafana:${containerTmp}`);
    const cmd = `docker exec grafana curl -sf -X POST 'http://localhost:3000${path}' -H 'Content-Type: application/json' -d @${containerTmp}`;
    const result = await sshExec(sshHost, sshUser, cmd);
    if (!result.stdout.trim()) return {};
    return JSON.parse(result.stdout);
  } finally {
    await sshExecRaw(sshHost, sshUser, `rm -f ${remoteTmp}; docker exec grafana rm -f ${containerTmp}`);
  }
}

// extensions/models/grafana_instance.ts
var GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname/IP of the Grafana host"),
  sshUser: z.string().default("keeb").describe("SSH user")
});
var DiscoverArgs = z.object({});
var PushDashboardArgs = z.object({
  dashboardFile: z.string().default("").describe("Path to dashboard JSON relative to repo root")
});
var ExportDashboardArgs = z.object({
  dashboardUid: z.string().default("").describe("UID of the dashboard to export"),
  outputFile: z.string().default("").describe("Output file path relative to repo root")
});
var ConfigureContactPointArgs = z.object({
  webhookUrl: z.string().default("").describe("Discord webhook URL"),
  name: z.string().default("discord-alerts").describe("Contact point name")
});
var ConfigureNotificationPolicyArgs = z.object({
  contactPointName: z.string().default("discord-alerts").describe("Contact point receiver name")
});
var PushAlertRuleArgs = z.object({
  ruleFile: z.string().default("").describe("Path to alert rule JSON relative to repo root")
});
var CreateAnnotationArgs = z.object({
  tags: z.string().default("").describe("JSON array of annotation tags"),
  text: z.string().default("").describe("Annotation text"),
  dashboardUid: z.string().default("").describe("Optional dashboard UID to scope annotation")
});
var QueryMetricsArgs = z.object({
  query: z.string().default("").describe("PromQL query string"),
  start: z.string().default("").describe("Range start time (ISO8601 or relative like '24h')"),
  end: z.string().default("").describe("Range end time (ISO8601, defaults to now)"),
  step: z.string().default("2m").describe("Query step interval")
});
var InstanceSchema = z.object({
  grafanaVersion: z.string(),
  dashboards: z.string(),
  datasources: z.string(),
  timestamp: z.string()
});
var DashboardSchema = z.object({
  uid: z.string(),
  title: z.string(),
  action: z.string(),
  timestamp: z.string()
});
var AlertSchema = z.object({
  title: z.string(),
  uid: z.string().optional(),
  timestamp: z.string()
});
var AnnotationSchema = z.object({
  id: z.number().optional(),
  tags: z.string(),
  text: z.string(),
  timestamp: z.string()
});
var QueryResultSchema = z.object({
  query: z.string(),
  resultType: z.string(),
  results: z.string(),
  seriesCount: z.number(),
  timestamp: z.string()
});
var model = {
  type: "@user/grafana/instance",
  version: "2026.02.20.1",
  resources: {
    "instance": {
      description: "Grafana instance discovery result",
      schema: InstanceSchema,
      lifetime: "infinite",
      garbageCollection: 10
    },
    "dashboard": {
      description: "Dashboard push/export result",
      schema: DashboardSchema,
      lifetime: "infinite",
      garbageCollection: 10
    },
    "alert": {
      description: "Alert rule push result",
      schema: AlertSchema,
      lifetime: "infinite",
      garbageCollection: 10
    },
    "annotation": {
      description: "Grafana annotation",
      schema: AnnotationSchema,
      lifetime: "1h",
      garbageCollection: 50
    },
    "queryResult": {
      description: "Prometheus query result",
      schema: QueryResultSchema,
      lifetime: "1h",
      garbageCollection: 20
    }
  },
  globalArguments: GlobalArgs,
  methods: {
    discover: {
      description: "Validate Grafana is running, list dashboards and datasources",
      arguments: DiscoverArgs,
      execute: async (_args, context) => {
        const { sshHost, sshUser = "keeb" } = context.globalArgs;
        console.log(`[discover] Checking Grafana on ${sshHost}`);
        const health = await grafanaApiGet(sshHost, sshUser, "/api/health");
        console.log(`[discover] Grafana version: ${health.version}, database: ${health.database}`);
        const dashboards = await grafanaApiGet(sshHost, sshUser, "/api/search?type=dash-db");
        console.log(`[discover] Found ${dashboards.length} dashboards:`);
        for (const d of dashboards) {
          console.log(`  - ${d.title} (uid: ${d.uid})`);
        }
        const datasources = await grafanaApiGet(sshHost, sshUser, "/api/datasources");
        console.log(`[discover] Found ${datasources.length} datasources:`);
        for (const ds of datasources) {
          console.log(`  - ${ds.name} (type: ${ds.type})`);
        }
        const handle = await context.writeResource("instance", "instance", {
          grafanaVersion: health.version || "unknown",
          dashboards: JSON.stringify(dashboards.map((d) => ({
            uid: d.uid,
            title: d.title
          }))),
          datasources: JSON.stringify(datasources.map((ds) => ({
            name: ds.name,
            type: ds.type
          }))),
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    pushDashboard: {
      description: "Read dashboard JSON from repo and push to Grafana",
      arguments: PushDashboardArgs,
      execute: async (args, context) => {
        const { dashboardFile } = args;
        if (!dashboardFile) throw new Error("dashboardFile is required");
        const { sshHost, sshUser = "keeb" } = context.globalArgs;
        const filePath = `${context.repoDir}/${dashboardFile}`;
        console.log(`[pushDashboard] Reading ${filePath}`);
        const raw = await Deno.readTextFile(filePath);
        const dashboardJson = JSON.parse(raw);
        dashboardJson.id = null;
        const payload = JSON.stringify({
          dashboard: dashboardJson,
          overwrite: true
        });
        const tmpPath = `/tmp/grafana-dash-${Date.now()}.json`;
        await Deno.writeTextFile(tmpPath, payload);
        try {
          console.log(`[pushDashboard] Pushing '${dashboardJson.title}' (uid: ${dashboardJson.uid})`);
          const result = await grafanaApiPostFile(sshHost, sshUser, "/api/dashboards/db", tmpPath);
          console.log(`[pushDashboard] Result: status=${result.status}, uid=${result.uid}`);
          const handle = await context.writeResource("dashboard", dashboardJson.uid || "unknown", {
            uid: result.uid || dashboardJson.uid || "unknown",
            title: dashboardJson.title || "unknown",
            action: result.status || "pushed",
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          return {
            dataHandles: [
              handle
            ]
          };
        } finally {
          await Deno.remove(tmpPath).catch(() => {
          });
        }
      }
    },
    exportDashboard: {
      description: "Export a dashboard from Grafana to a local JSON file",
      arguments: ExportDashboardArgs,
      execute: async (args, context) => {
        const { dashboardUid, outputFile } = args;
        if (!dashboardUid) throw new Error("dashboardUid is required");
        if (!outputFile) throw new Error("outputFile is required");
        const { sshHost, sshUser = "keeb" } = context.globalArgs;
        console.log(`[exportDashboard] Exporting uid=${dashboardUid}`);
        const result = await grafanaApiGet(sshHost, sshUser, `/api/dashboards/uid/${dashboardUid}`);
        const dashboard = result.dashboard;
        if (!dashboard) throw new Error(`Dashboard ${dashboardUid} not found`);
        const outPath = `${context.repoDir}/${outputFile}`;
        console.log(`[exportDashboard] Writing to ${outPath}`);
        await Deno.writeTextFile(outPath, JSON.stringify(dashboard, null, 2) + "\n");
        console.log(`[exportDashboard] Exported '${dashboard.title}' (${Object.keys(dashboard).length} top-level keys)`);
        const handle = await context.writeResource("dashboard", dashboardUid, {
          uid: dashboardUid,
          title: dashboard.title || "unknown",
          action: "exported",
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    configureContactPoint: {
      description: "Create or update a Discord webhook contact point in Grafana",
      arguments: ConfigureContactPointArgs,
      execute: async (args, context) => {
        const { webhookUrl, name = "discord-alerts" } = args;
        if (!webhookUrl) throw new Error("webhookUrl is required");
        const { sshHost, sshUser = "keeb" } = context.globalArgs;
        console.log(`[configureContactPoint] Setting up '${name}' contact point`);
        const contactPoint = {
          name,
          type: "discord",
          settings: {
            url: webhookUrl,
            use_discord_username: true
          },
          disableResolveMessage: false
        };
        const result = await grafanaApiPost(sshHost, sshUser, "/api/v1/provisioning/contact-points", contactPoint);
        console.log(`[configureContactPoint] Contact point '${name}' configured (uid: ${result.uid || "ok"})`);
        const handle = await context.writeResource("alert", `cp-${name}`, {
          title: name,
          uid: result.uid,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    configureNotificationPolicy: {
      description: "Set the default notification policy to route to a contact point",
      arguments: ConfigureNotificationPolicyArgs,
      execute: async (args, context) => {
        const { contactPointName = "discord-alerts" } = args;
        const { sshHost, sshUser = "keeb" } = context.globalArgs;
        console.log(`[configureNotificationPolicy] Setting default receiver to '${contactPointName}'`);
        const policy = {
          receiver: contactPointName,
          group_by: [
            "alertname",
            "instance"
          ],
          group_wait: "30s",
          group_interval: "5m",
          repeat_interval: "4h"
        };
        await grafanaApiPut(sshHost, sshUser, "/api/v1/provisioning/policies", policy);
        console.log(`[configureNotificationPolicy] Notification policy updated`);
        const handle = await context.writeResource("alert", "notification-policy", {
          title: `policy -> ${contactPointName}`,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    pushAlertRule: {
      description: "Read alert rule JSON from repo and push to Grafana",
      arguments: PushAlertRuleArgs,
      execute: async (args, context) => {
        const { ruleFile } = args;
        if (!ruleFile) throw new Error("ruleFile is required");
        const { sshHost, sshUser = "keeb" } = context.globalArgs;
        const filePath = `${context.repoDir}/${ruleFile}`;
        console.log(`[pushAlertRule] Reading ${filePath}`);
        const raw = await Deno.readTextFile(filePath);
        const rule = JSON.parse(raw);
        const tmpFile = `${context.repoDir}/.tmp-alert-${Date.now()}.json`;
        await Deno.writeTextFile(tmpFile, raw);
        console.log(`[pushAlertRule] Pushing alert rule '${rule.title}'`);
        const result = await grafanaApiPostFile(sshHost, sshUser, "/api/v1/provisioning/alert-rules", tmpFile);
        try {
          await Deno.remove(tmpFile);
        } catch (_e) {
        }
        console.log(`[pushAlertRule] Alert rule pushed (uid: ${result.uid || "ok"})`);
        const handle = await context.writeResource("alert", rule.title || "unknown", {
          title: rule.title || "unknown",
          uid: result.uid,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    createAnnotation: {
      description: "Create a Grafana annotation (global or scoped to a dashboard)",
      arguments: CreateAnnotationArgs,
      execute: async (args, context) => {
        const { tags: tagsStr, text, dashboardUid } = args;
        if (!text) throw new Error("text is required");
        const { sshHost, sshUser = "keeb" } = context.globalArgs;
        const tags = tagsStr ? JSON.parse(tagsStr) : [];
        const annotation = {
          text,
          tags,
          time: Date.now()
        };
        if (dashboardUid) {
          const dashResult = await grafanaApiGet(sshHost, sshUser, `/api/dashboards/uid/${dashboardUid}`);
          if (dashResult.dashboard) {
            annotation.dashboardId = dashResult.dashboard.id;
          }
        }
        console.log(`[createAnnotation] Creating annotation: "${text}" tags=${JSON.stringify(tags)}`);
        const result = await grafanaApiPost(sshHost, sshUser, "/api/annotations", annotation);
        console.log(`[createAnnotation] Annotation created (id: ${result.id})`);
        const handle = await context.writeResource("annotation", `ann-${Date.now()}`, {
          id: result.id,
          tags: JSON.stringify(tags),
          text,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    queryMetrics: {
      description: "Query Prometheus metrics via Grafana datasource proxy",
      arguments: QueryMetricsArgs,
      execute: async (args, context) => {
        const { query, start, end, step = "2m" } = args;
        if (!query) throw new Error("query is required");
        if (!start) throw new Error("start is required");
        const { sshHost, sshUser = "keeb" } = context.globalArgs;
        console.log(`[queryMetrics] Discovering Prometheus datasource...`);
        const datasources = await grafanaApiGet(sshHost, sshUser, "/api/datasources");
        const promDs = datasources.find((ds) => ds.type === "prometheus");
        if (!promDs) throw new Error("No Prometheus datasource found in Grafana");
        console.log(`[queryMetrics] Using datasource '${promDs.name}' (id: ${promDs.id})`);
        const nowSec = Math.floor(Date.now() / 1e3);
        var startSec;
        var endSec;
        const relMatch = start.match(/^(\d+)([smhd])$/);
        if (relMatch) {
          const num = parseInt(relMatch[1]);
          const unit = relMatch[2];
          const multipliers = {
            s: 1,
            m: 60,
            h: 3600,
            d: 86400
          };
          startSec = nowSec - num * multipliers[unit];
        } else {
          startSec = Math.floor(new Date(start).getTime() / 1e3);
        }
        if (end) {
          const relEnd = end.match(/^(\d+)([smhd])$/);
          if (relEnd) {
            const num = parseInt(relEnd[1]);
            const unit = relEnd[2];
            const multipliers = {
              s: 1,
              m: 60,
              h: 3600,
              d: 86400
            };
            endSec = nowSec - num * multipliers[unit];
          } else {
            endSec = Math.floor(new Date(end).getTime() / 1e3);
          }
        } else {
          endSec = nowSec;
        }
        console.log(`[queryMetrics] Query: ${query}`);
        console.log(`[queryMetrics] Range: ${new Date(startSec * 1e3).toISOString()} \u2192 ${new Date(endSec * 1e3).toISOString()} step=${step}`);
        const encodedQuery = encodeURIComponent(query);
        const path = `/api/datasources/proxy/${promDs.id}/api/v1/query_range?query=${encodedQuery}&start=${startSec}&end=${endSec}&step=${step}`;
        const response = await grafanaApiGet(sshHost, sshUser, path);
        if (response.status !== "success") {
          throw new Error(`Prometheus query failed: ${response.error || JSON.stringify(response)}`);
        }
        const resultType = response.data.resultType || "unknown";
        const series = response.data.result || [];
        console.log(`[queryMetrics] Result type: ${resultType}, series count: ${series.length}`);
        for (const s of series) {
          const labels = s.metric || {};
          const labelStr = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(", ");
          const values = s.values || [];
          const nonZero = values.filter((v) => parseFloat(v[1]) > 0);
          console.log(`
  Series: {${labelStr}} (${values.length} samples, ${nonZero.length} non-zero)`);
          if (nonZero.length > 0 && nonZero.length <= 50) {
            for (const v of nonZero) {
              const ts = new Date(v[0] * 1e3).toISOString();
              console.log(`    ${ts}  ${v[1]}`);
            }
          } else if (nonZero.length > 50) {
            for (const v of nonZero.slice(0, 5)) {
              const ts = new Date(v[0] * 1e3).toISOString();
              console.log(`    ${ts}  ${v[1]}`);
            }
            console.log(`    ... (${nonZero.length - 10} more non-zero samples)`);
            for (const v of nonZero.slice(-5)) {
              const ts = new Date(v[0] * 1e3).toISOString();
              console.log(`    ${ts}  ${v[1]}`);
            }
          }
        }
        console.log(`
[queryMetrics] Done \u2014 ${series.length} series returned`);
        const handle = await context.writeResource("queryResult", `query-${Date.now()}`, {
          query,
          resultType,
          results: JSON.stringify(series),
          seriesCount: series.length,
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
