// extensions/models/minecraft_server.ts
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

// extensions/models/minecraft_server.ts
var GlobalArgs = z.object({
  sshHost: z.string().nullable().describe("SSH hostname/IP (set via CEL from lookup model)"),
  sshUser: z.string().default("root").describe("SSH user (default 'root')"),
  tmuxSession: z.string().default("mons").describe("tmux session name"),
  serverDir: z.string().default("~/mons").describe("Server directory path"),
  startScript: z.string().default("./startserver.sh").describe("Start script relative to serverDir"),
  logPath: z.string().default("~/mons/logs/latest.log").describe("Path to latest.log"),
  serverName: z.string().default("server").describe("Resource instance name for writeResource")
});
var ServerSchema = z.object({
  success: z.boolean().optional(),
  skipped: z.boolean().optional(),
  alreadyStopped: z.boolean().optional(),
  timedOut: z.boolean().optional(),
  ip: z.string().optional(),
  serverRunning: z.boolean().optional(),
  serverReady: z.boolean().optional(),
  online: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  players: z.array(z.string()).optional(),
  timestamp: z.string().optional()
});
var model = {
  type: "@user/minecraft/server",
  version: "2026.02.18.2",
  resources: {
    "server": {
      description: "Minecraft server operation result",
      schema: ServerSchema,
      lifetime: "infinite",
      garbageCollection: 10
    },
    "metrics": {
      description: "Minecraft player metrics collection result",
      schema: ServerSchema,
      lifetime: "infinite",
      garbageCollection: 10
    }
  },
  globalArguments: GlobalArgs,
  methods: {
    say: {
      description: "Broadcast a message to Minecraft players via the server console",
      arguments: z.object({
        message: z.string().default("").describe("Message to broadcast")
      }),
      execute: async (args, context) => {
        if (!args.message) throw new Error("message is required");
        const { message } = args;
        const { sshHost, sshUser = "root", tmuxSession, serverName } = context.globalArgs;
        if (!isValidSshHost(sshHost)) {
          console.log(`[say] No sshHost - skipping`);
          const handle2 = await context.writeResource("server", serverName, {
            success: true,
            skipped: true
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        const tmuxCheck = await sshExecRaw(sshHost, sshUser, `tmux has-session -t ${tmuxSession} 2>/dev/null && echo exists || echo missing`);
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[say] No tmux session - server not running`);
          const handle2 = await context.writeResource("server", serverName, {
            success: true,
            skipped: true
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        console.log(`[say] Broadcasting: ${message}`);
        await sshExecRaw(sshHost, sshUser, `tmux send-keys -t ${tmuxSession} 'say ${message}' Enter`);
        const handle = await context.writeResource("server", serverName, {
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
    op: {
      description: "Grant operator status to a Minecraft player",
      arguments: z.object({
        playerName: z.string().default("").describe("Player name to op")
      }),
      execute: async (args, context) => {
        if (!args.playerName) throw new Error("playerName is required");
        const sanitized = args.playerName.replace(/[^a-zA-Z0-9_]/g, "");
        const { sshHost, sshUser = "root", tmuxSession, serverName } = context.globalArgs;
        if (!isValidSshHost(sshHost)) {
          console.log(`[op] No sshHost - skipping`);
          const handle2 = await context.writeResource("server", serverName, {
            success: true,
            skipped: true
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        const tmuxCheck = await sshExecRaw(sshHost, sshUser, `tmux has-session -t ${tmuxSession} 2>/dev/null && echo exists || echo missing`);
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[op] No tmux session - server not running`);
          const handle2 = await context.writeResource("server", serverName, {
            success: true,
            skipped: true
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        console.log(`[op] Granting op to: ${sanitized}`);
        await sshExecRaw(sshHost, sshUser, `tmux send-keys -t ${tmuxSession} 'op ${sanitized}' Enter`);
        const handle = await context.writeResource("server", serverName, {
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
    deop: {
      description: "Revoke operator status from a Minecraft player",
      arguments: z.object({
        playerName: z.string().default("").describe("Player name to deop")
      }),
      execute: async (args, context) => {
        if (!args.playerName) throw new Error("playerName is required");
        const sanitized = args.playerName.replace(/[^a-zA-Z0-9_]/g, "");
        const { sshHost, sshUser = "root", tmuxSession, serverName } = context.globalArgs;
        if (!isValidSshHost(sshHost)) {
          console.log(`[deop] No sshHost - skipping`);
          const handle2 = await context.writeResource("server", serverName, {
            success: true,
            skipped: true
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        const tmuxCheck = await sshExecRaw(sshHost, sshUser, `tmux has-session -t ${tmuxSession} 2>/dev/null && echo exists || echo missing`);
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[deop] No tmux session - server not running`);
          const handle2 = await context.writeResource("server", serverName, {
            success: true,
            skipped: true
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        console.log(`[deop] Revoking op from: ${sanitized}`);
        await sshExecRaw(sshHost, sshUser, `tmux send-keys -t ${tmuxSession} 'deop ${sanitized}' Enter`);
        const handle = await context.writeResource("server", serverName, {
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
    warnShutdown: {
      description: "Broadcast a shutdown warning to Minecraft players and wait 30 seconds",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", tmuxSession, serverName } = context.globalArgs;
        if (!isValidSshHost(sshHost)) {
          console.log(`[warnShutdown] No sshHost - skipping warning`);
          const handle2 = await context.writeResource("server", serverName, {
            success: true,
            skipped: true
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        const tmuxCheck = await sshExecRaw(sshHost, sshUser, `tmux has-session -t ${tmuxSession} 2>/dev/null && echo exists || echo missing`);
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[warnShutdown] No tmux session - skipping warning`);
          const handle2 = await context.writeResource("server", serverName, {
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
          await sshExecRaw(sshHost, sshUser, `tmux send-keys -t ${tmuxSession} 'say == SERVER SHUTTING DOWN IN 30 SECONDS ==' Enter`);
        }
        console.log(`[warnShutdown] Waiting 30s...`);
        await new Promise((r) => setTimeout(r, 3e4));
        console.log(`[warnShutdown] Done`);
        const handle = await context.writeResource("server", serverName, {
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
    stopMinecraftServer: {
      description: "Gracefully stop a Minecraft server running in a tmux session via SSH, then wait for java to exit",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", tmuxSession, serverName } = context.globalArgs;
        if (!isValidSshHost(sshHost)) {
          console.log(`[stopMinecraftServer] No sshHost - VM may be stopped already`);
          const handle2 = await context.writeResource("server", serverName, {
            success: true,
            alreadyStopped: true,
            timedOut: false,
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
          console.log(`[stopMinecraftServer] SSH unreachable at ${sshHost} - VM may be stopped already`);
          const handle2 = await context.writeResource("server", serverName, {
            success: true,
            alreadyStopped: true,
            timedOut: false,
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        const tmuxCheck = await sshExecRaw(sshHost, sshUser, `tmux has-session -t ${tmuxSession} 2>/dev/null && echo exists || echo missing`);
        const javaCheck = await sshExecRaw(sshHost, sshUser, "pgrep -f java > /dev/null 2>&1 && echo running || echo stopped");
        const tmuxExists = tmuxCheck.stdout.trim() === "exists";
        const javaRunning = javaCheck.stdout.trim() === "running";
        if (!tmuxExists && !javaRunning) {
          console.log(`[stopMinecraftServer] No tmux session and no java process - server already stopped`);
          const handle2 = await context.writeResource("server", serverName, {
            success: true,
            alreadyStopped: true,
            timedOut: false,
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        if (tmuxExists) {
          console.log(`[stopMinecraftServer] Sending 'stop' command to tmux session '${tmuxSession}'...`);
          await sshExecRaw(sshHost, sshUser, `tmux send-keys -t ${tmuxSession} 'stop' Enter`);
        }
        const javaPid = await sshExecRaw(sshHost, sshUser, "pgrep -f 'java.*neoforge' || pgrep -f java");
        const originalPid = javaPid.stdout.trim().split("\n")[0];
        console.log(`[stopMinecraftServer] Tracking java PID ${originalPid}, waiting for exit (up to 90s)...`);
        const pollTimeout = 90;
        const pollStart = Date.now();
        const pollDeadline = pollStart + pollTimeout * 1e3;
        let timedOut = false;
        while (Date.now() < pollDeadline) {
          await new Promise((r) => setTimeout(r, 3e3));
          const check = await sshExecRaw(sshHost, sshUser, `kill -0 ${originalPid} 2>/dev/null && echo running || echo stopped`);
          if (check.stdout.trim() === "stopped") {
            const elapsed = Math.round((Date.now() - pollStart) / 1e3);
            console.log(`[stopMinecraftServer] Java PID ${originalPid} exited after ${elapsed}s`);
            break;
          }
        }
        if (Date.now() >= pollDeadline) {
          timedOut = true;
          console.log(`[stopMinecraftServer] Timed out waiting for java to exit`);
        }
        console.log(`[stopMinecraftServer] Killing tmux session to prevent restart loop...`);
        await sshExecRaw(sshHost, sshUser, `tmux kill-session -t ${tmuxSession} 2>/dev/null || true`);
        console.log(`[stopMinecraftServer] Done (timedOut=${timedOut})`);
        const handle = await context.writeResource("server", serverName, {
          success: true,
          alreadyStopped: false,
          timedOut,
          ip: sshHost,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    },
    status: {
      description: "Query Minecraft server status: player count and names",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", tmuxSession, logPath, serverName } = context.globalArgs;
        if (!isValidSshHost(sshHost)) {
          console.log(`[status] No sshHost - VM may be stopped`);
          const handle2 = await context.writeResource("server", serverName, {
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
          const handle2 = await context.writeResource("server", serverName, {
            serverRunning: false,
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        const tmuxCheck = await sshExecRaw(sshHost, sshUser, `tmux has-session -t ${tmuxSession} 2>/dev/null && echo exists || echo missing`);
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[status] No tmux session - server not running`);
          const handle2 = await context.writeResource("server", serverName, {
            serverRunning: false,
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        const wcResult = await sshExecRaw(sshHost, sshUser, `wc -l < ${logPath}`);
        const lineCount = parseInt(wcResult.stdout.trim(), 10) || 0;
        console.log(`[status] Log has ${lineCount} lines, sending 'list' command...`);
        await sshExecRaw(sshHost, sshUser, `tmux send-keys -t ${tmuxSession} 'list' Enter`);
        await new Promise((r) => setTimeout(r, 2e3));
        const tailResult = await sshExecRaw(sshHost, sshUser, `tail -n +${lineCount + 1} ${logPath}`);
        const newLines = tailResult.stdout;
        const match = newLines.match(/There are (\d+) of a max of (\d+) players online:(.*)/);
        if (match) {
          const online = parseInt(match[1], 10);
          const max = parseInt(match[2], 10);
          const playerStr = match[3].trim();
          const players = playerStr ? playerStr.split(",").map((p) => p.trim()).filter(Boolean) : [];
          console.log(`[status] ${online}/${max} players online: ${players.join(", ") || "(none)"}`);
          const handle2 = await context.writeResource("server", serverName, {
            serverRunning: true,
            online,
            max,
            players,
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        console.log(`[status] Could not parse player list from log`);
        const handle = await context.writeResource("server", serverName, {
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
    startMinecraftServer: {
      description: "Start a Minecraft server in a tmux session via SSH on a running VM",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", tmuxSession, serverDir, startScript, logPath, serverName } = context.globalArgs;
        if (!isValidSshHost(sshHost)) {
          throw new Error("sshHost is required - is the VM running?");
        }
        console.log(`[startMinecraftServer] Waiting for SSH on ${sshHost}...`);
        const sshReady = await waitForSsh(sshHost, sshUser);
        if (!sshReady) {
          throw new Error(`SSH not reachable on ${sshHost} after 60s`);
        }
        const startLog = `/tmp/mc-start-${tmuxSession}.log`;
        console.log(`[startMinecraftServer] Cleaning up stale tmux session...`);
        await sshExecRaw(sshHost, sshUser, `tmux kill-session -t ${tmuxSession} 2>/dev/null || true`);
        await sshExecRaw(sshHost, sshUser, `truncate -s 0 ${logPath} 2>/dev/null || true`);
        await sshExecRaw(sshHost, sshUser, `truncate -s 0 ${startLog} 2>/dev/null || true`);
        console.log(`[startMinecraftServer] Starting Minecraft server in tmux session '${tmuxSession}', output \u2192 ${startLog}...`);
        const startResult = await sshExecRaw(sshHost, sshUser, `tmux new-session -d -s ${tmuxSession} -c ${serverDir} 'bash ${startScript} 2>&1 | tee ${startLog}'`);
        if (startResult.code !== 0) {
          throw new Error(`Failed to start tmux session: ${startResult.stderr}`);
        }
        const readyTimeout = 900;
        const readyPoll = 5;
        const readyStart = Date.now();
        const readyDeadline = readyStart + readyTimeout * 1e3;
        console.log(`[startMinecraftServer] Waiting up to ${readyTimeout}s for server to be ready...`);
        let serverReady = false;
        while (Date.now() < readyDeadline) {
          const logCheck = await sshExecRaw(sshHost, sshUser, `grep -q '\\]: Done (' ${logPath} 2>/dev/null && echo READY || echo WAITING`);
          if (logCheck.stdout.trim() === "READY") {
            const elapsed2 = Math.round((Date.now() - readyStart) / 1e3);
            console.log(`[startMinecraftServer] Server is ready! (${elapsed2}s)`);
            serverReady = true;
            break;
          }
          const tmuxAlive = await sshExecRaw(sshHost, sshUser, `tmux has-session -t ${tmuxSession} 2>/dev/null && echo alive || echo dead`);
          if (tmuxAlive.stdout.trim() === "dead") {
            const startOutput = await sshExecRaw(sshHost, sshUser, `cat ${startLog} 2>/dev/null || echo "(no output)"`);
            throw new Error(`Server process exited before becoming ready. start.sh output:
${startOutput.stdout}`);
          }
          const elapsed = Math.round((Date.now() - readyStart) / 1e3);
          console.log(`[startMinecraftServer] Server not ready yet (${elapsed}s elapsed), polling in ${readyPoll}s...`);
          await new Promise((r) => setTimeout(r, readyPoll * 1e3));
        }
        if (!serverReady) {
          const startOutput = await sshExecRaw(sshHost, sshUser, `cat ${startLog} 2>/dev/null || echo "(no output)"`);
          throw new Error(`Minecraft server did not become ready within ${readyTimeout}s. start.sh output:
${startOutput.stdout}`);
        }
        const handle = await context.writeResource("server", serverName, {
          success: true,
          ip: sshHost,
          serverReady: true,
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
        const { sshHost, sshUser = "root", tmuxSession, logPath, serverName } = context.globalArgs;
        if (!isValidSshHost(sshHost)) {
          console.log(`[collectMetrics] No sshHost - VM may be stopped`);
          const handle2 = await context.writeResource("metrics", serverName, {
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
          const handle2 = await context.writeResource("metrics", serverName, {
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
        const tmuxCheck = await sshExecRaw(sshHost, sshUser, `tmux has-session -t ${tmuxSession} 2>/dev/null && echo exists || echo missing`);
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[collectMetrics] No tmux session - server not running`);
          const data2 = {
            serverRunning: false,
            online: 0,
            max: null,
            players: []
          };
          await writeMetricsFiles(sshHost, sshUser, "minecraft", serverName, {
            ...data2
          });
          const handle2 = await context.writeResource("metrics", serverName, {
            ...data2,
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          });
          return {
            dataHandles: [
              handle2
            ]
          };
        }
        const wcResult = await sshExecRaw(sshHost, sshUser, `wc -l < ${logPath}`);
        const lineCount = parseInt(wcResult.stdout.trim(), 10) || 0;
        await sshExecRaw(sshHost, sshUser, `tmux send-keys -t ${tmuxSession} 'list' Enter`);
        await new Promise((r) => setTimeout(r, 2e3));
        const tailResult = await sshExecRaw(sshHost, sshUser, `tail -n +${lineCount + 1} ${logPath}`);
        const match = tailResult.stdout.match(/There are (\d+) of a max of (\d+) players online:(.*)/);
        const online = match ? parseInt(match[1], 10) : 0;
        const max = match ? parseInt(match[2], 10) : null;
        const playerStr = match ? match[3].trim() : "";
        const players = playerStr ? playerStr.split(",").map((p) => p.trim()).filter(Boolean) : [];
        console.log(`[collectMetrics] ${online}/${max ?? "?"} players: ${players.join(", ") || "(none)"}`);
        const data = {
          serverRunning: true,
          online,
          max,
          players
        };
        await writeMetricsFiles(sshHost, sshUser, "minecraft", serverName, data);
        const handle = await context.writeResource("metrics", serverName, {
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
