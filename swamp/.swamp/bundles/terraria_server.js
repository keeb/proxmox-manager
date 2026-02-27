// extensions/models/terraria_server.ts
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

// extensions/models/lib/metrics.ts
function formatPromMetrics(gameType, serverName, data) {
  const labels = `game="${gameType}",server="${serverName}"`;
  const running = data.serverRunning ? 1 : 0;
  const lines = [
    `# HELP game_server_running Whether the game server process is running`,
    `# TYPE game_server_running gauge`,
    `game_server_running{${labels}} ${running}`,
    `# HELP game_players_online Current number of players online`,
    `# TYPE game_players_online gauge`,
    `game_players_online{${labels}} ${data.online}`
  ];
  if (data.max !== null) {
    lines.push(`# HELP game_players_max Maximum player slots`, `# TYPE game_players_max gauge`, `game_players_max{${labels}} ${data.max}`);
  }
  lines.push(`# HELP game_metrics_collected_at Unix timestamp of last successful collection`, `# TYPE game_metrics_collected_at gauge`, `game_metrics_collected_at{${labels}} ${Math.floor(Date.now() / 1e3)}`);
  return lines.join("\n") + "\n";
}
function formatLogLine(gameType, serverName, data) {
  return JSON.stringify({
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    game: gameType,
    server: serverName,
    running: data.serverRunning,
    online: data.online,
    max: data.max,
    players: data.players
  });
}
async function writeMetricsFiles(sshHost, sshUser, gameType, serverName, data) {
  const promContent = formatPromMetrics(gameType, serverName, data);
  const logLine = formatLogLine(gameType, serverName, data);
  const promDir = "/var/lib/node_exporter/textfile_collector";
  const promFile = `${promDir}/game_${gameType}.prom`;
  const logFile = "/var/log/game-players.log";
  await sshExec(sshHost, sshUser, `mkdir -p ${promDir} && cat > ${promFile}.tmp << 'PROMEOF'
${promContent}PROMEOF
mv ${promFile}.tmp ${promFile}`);
  await sshExec(sshHost, sshUser, `echo '${logLine.replace(/'/g, "'\\''")}' >> ${logFile}`);
}

// extensions/models/terraria_server.ts
var GlobalArgs = z.object({
  sshHost: z.string().nullable().describe("SSH hostname/IP (set via CEL from lookup model)"),
  sshUser: z.string().default("root").describe("SSH user (default 'root')"),
  containerName: z.string().default("tmodloader").describe("Docker container name running tModLoader"),
  serverName: z.string().default("server").describe("Resource instance name for writeResource")
});
var ServerSchema = z.object({
  success: z.boolean().optional(),
  skipped: z.boolean().optional(),
  serverRunning: z.boolean().optional(),
  online: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  players: z.array(z.string()).optional(),
  timestamp: z.string().optional()
});
var model = {
  type: "@user/terraria/server",
  version: "2026.02.14.1",
  resources: {
    "server": {
      description: "Terraria server operation result",
      schema: ServerSchema,
      lifetime: "infinite",
      garbageCollection: 10
    },
    "metrics": {
      description: "Terraria player metrics collection result",
      schema: ServerSchema,
      lifetime: "infinite",
      garbageCollection: 10
    }
  },
  globalArguments: GlobalArgs,
  methods: {
    warnShutdown: {
      description: "Broadcast a shutdown warning to Terraria players and wait 30 seconds",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", containerName = "tmodloader" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) {
          console.log(`[warnShutdown] No sshHost - skipping warning`);
          const handle2 = await context.writeResource("server", "server", {
            success: true,
            skipped: true
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        const containerCheck = await sshExecRaw(sshHost, sshUser, `docker inspect --format '{{.State.Running}}' ${containerName} 2>/dev/null`);
        if (containerCheck.code !== 0 || containerCheck.stdout.trim() !== "true") {
          console.log(`[warnShutdown] Container ${containerName} not running - skipping warning`);
          const handle2 = await context.writeResource("server", "server", {
            success: true,
            skipped: true
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        const tmuxCheck = await sshExecRaw(sshHost, sshUser, `docker exec ${containerName} tmux has-session 2>/dev/null && echo exists || echo missing`);
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[warnShutdown] No tmux session in container - skipping warning`);
          const handle2 = await context.writeResource("server", "server", {
            success: true,
            skipped: true
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        console.log(`[warnShutdown] Broadcasting shutdown warning...`);
        for (let i = 0; i < 3; i++) {
          await sshExecRaw(sshHost, sshUser, `docker exec ${containerName} tmux send-keys "say == SERVER SHUTTING DOWN IN 30 SECONDS ==" Enter`);
        }
        console.log(`[warnShutdown] Waiting 30s...`);
        await new Promise((r) => setTimeout(r, 3e4));
        console.log(`[warnShutdown] Done`);
        const handle = await context.writeResource("server", "server", {
          success: true,
          skipped: false
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    status: {
      description: "Query Terraria server status: player count and names",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", containerName = "tmodloader" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) {
          console.log(`[status] No sshHost - VM may be stopped`);
          const handle2 = await context.writeResource("server", "server", {
            serverRunning: false,
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        const reachable = await sshExecRaw(sshHost, sshUser, "echo ok");
        if (reachable.code !== 0) {
          console.log(`[status] SSH unreachable at ${sshHost} - VM may be stopped`);
          const handle2 = await context.writeResource("server", "server", {
            serverRunning: false,
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        const containerCheck = await sshExecRaw(sshHost, sshUser, `docker inspect --format '{{.State.Running}}' ${containerName} 2>/dev/null`);
        if (containerCheck.code !== 0 || containerCheck.stdout.trim() !== "true") {
          console.log(`[status] Container ${containerName} not running`);
          const handle2 = await context.writeResource("server", "server", {
            serverRunning: false,
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        const tmuxCheck = await sshExecRaw(sshHost, sshUser, `docker exec ${containerName} tmux has-session 2>/dev/null && echo exists || echo missing`);
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[status] No tmux session in container - server not running`);
          const handle2 = await context.writeResource("server", "server", {
            serverRunning: false,
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        await sshExecRaw(sshHost, sshUser, `docker exec ${containerName} tmux send-keys "playing" Enter`);
        await new Promise((r) => setTimeout(r, 2e3));
        const paneResult = await sshExecRaw(sshHost, sshUser, `docker exec ${containerName} tmux capture-pane -p`);
        const paneOutput = paneResult.stdout;
        const lines = paneOutput.split("\n");
        let countLineIdx = -1;
        let online = 0;
        for (let i = lines.length - 1; i >= 0; i--) {
          const noMatch = lines[i].match(/:\s*No players connected\./);
          if (noMatch) {
            countLineIdx = i;
            online = 0;
            break;
          }
          const numMatch = lines[i].match(/(\d+)\s+players?\s+connected\./);
          if (numMatch) {
            countLineIdx = i;
            online = parseInt(numMatch[1], 10);
            break;
          }
        }
        if (countLineIdx >= 0) {
          const players = [];
          for (let i = countLineIdx - 1; i >= 0 && players.length < online; i--) {
            const line = lines[i].trim();
            const nameMatch = line.match(/^:\s*(\S+)\s+\(/);
            if (nameMatch) {
              players.unshift(nameMatch[1]);
            } else {
              break;
            }
          }
          console.log(`[status] ${online} player(s) connected: ${players.join(", ") || "(none)"}`);
          const handle2 = await context.writeResource("server", "server", {
            serverRunning: true,
            online,
            max: null,
            players,
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        console.log(`[status] Could not parse player list from pane output`);
        const handle = await context.writeResource("server", "server", {
          serverRunning: true,
          online: null,
          max: null,
          players: [],
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    collectMetrics: {
      description: "Collect player metrics and write Prometheus textfile + JSON log",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", containerName = "tmodloader", serverName } = context.globalArgs;
        if (!isValidSshHost(sshHost)) {
          console.log(`[collectMetrics] No sshHost - VM may be stopped`);
          const handle2 = await context.writeResource("metrics", "metrics", {
            serverRunning: false,
            online: 0,
            max: null,
            players: [],
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        const reachable = await sshExecRaw(sshHost, sshUser, "echo ok");
        if (reachable.code !== 0) {
          console.log(`[collectMetrics] SSH unreachable at ${sshHost}`);
          const handle2 = await context.writeResource("metrics", "metrics", {
            serverRunning: false,
            online: 0,
            max: null,
            players: [],
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        const containerCheck = await sshExecRaw(sshHost, sshUser, `docker inspect --format '{{.State.Running}}' ${containerName} 2>/dev/null`);
        if (containerCheck.code !== 0 || containerCheck.stdout.trim() !== "true") {
          console.log(`[collectMetrics] Container ${containerName} not running`);
          const data2 = {
            serverRunning: false,
            online: 0,
            max: null,
            players: []
          };
          await writeMetricsFiles(sshHost, sshUser, "terraria", serverName, data2);
          const handle2 = await context.writeResource("metrics", "metrics", {
            ...data2,
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        const tmuxCheck = await sshExecRaw(sshHost, sshUser, `docker exec ${containerName} tmux has-session 2>/dev/null && echo exists || echo missing`);
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[collectMetrics] No tmux session in container`);
          const data2 = {
            serverRunning: false,
            online: 0,
            max: null,
            players: []
          };
          await writeMetricsFiles(sshHost, sshUser, "terraria", serverName, data2);
          const handle2 = await context.writeResource("metrics", "metrics", {
            ...data2,
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        await sshExecRaw(sshHost, sshUser, `docker exec ${containerName} tmux send-keys "playing" Enter`);
        await new Promise((r) => setTimeout(r, 2e3));
        const paneResult = await sshExecRaw(sshHost, sshUser, `docker exec ${containerName} tmux capture-pane -p`);
        const lines = paneResult.stdout.split("\n");
        let online = 0;
        let countLineIdx = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
          const noMatch = lines[i].match(/:\s*No players connected\./);
          if (noMatch) {
            countLineIdx = i;
            online = 0;
            break;
          }
          const numMatch = lines[i].match(/(\d+)\s+players?\s+connected\./);
          if (numMatch) {
            countLineIdx = i;
            online = parseInt(numMatch[1], 10);
            break;
          }
        }
        const players = [];
        if (countLineIdx >= 0) {
          for (let i = countLineIdx - 1; i >= 0 && players.length < online; i--) {
            const line = lines[i].trim();
            const nameMatch = line.match(/^:\s*(\S+)\s+\(/);
            if (nameMatch) {
              players.unshift(nameMatch[1]);
            } else {
              break;
            }
          }
        }
        console.log(`[collectMetrics] ${online} player(s): ${players.join(", ") || "(none)"}`);
        const data = {
          serverRunning: true,
          online,
          max: null,
          players
        };
        await writeMetricsFiles(sshHost, sshUser, "terraria", serverName, data);
        const handle = await context.writeResource("metrics", "metrics", {
          ...data,
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
