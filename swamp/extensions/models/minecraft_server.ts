import { z } from "npm:zod@4";
import { isValidSshHost, sshExecRaw, waitForSsh } from "./lib/ssh.ts";

const GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname/IP (set via CEL from lookup model)"),
  sshUser: z.string().default("root").describe("SSH user (default 'root')"),
});

const ServerSchema = z.object({
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
  timestamp: z.string().optional(),
});

export const model = {
  type: "@user/minecraft/server",
  version: "2026.02.11.1",
  resources: {
    "server": {
      description: "Minecraft server operation result",
      schema: ServerSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  globalArguments: GlobalArgs,
  methods: {
    say: {
      description: "Broadcast a message to Minecraft players via the server console",
      arguments: z.object({
        message: z.string().describe("Message to broadcast"),
      }),
      execute: async (args, context) => {
        const { message } = args;
        const { sshHost, sshUser = "root" } = context.globalArgs;

        if (!isValidSshHost(sshHost)) {
          console.log(`[say] No sshHost - skipping`);
          const handle = await context.writeResource("server", "server", { success: true, skipped: true });
          return { dataHandles: [handle] };
        }

        const tmuxCheck = await sshExecRaw(sshHost, sshUser, "tmux has-session -t mons 2>/dev/null && echo exists || echo missing");
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[say] No tmux session - server not running`);
          const handle = await context.writeResource("server", "server", { success: true, skipped: true });
          return { dataHandles: [handle] };
        }

        console.log(`[say] Broadcasting: ${message}`);
        await sshExecRaw(sshHost, sshUser, `tmux send-keys -t mons 'say ${message}' Enter`);

        const handle = await context.writeResource("server", "server", { success: true, skipped: false });
        return { dataHandles: [handle] };
      },
    },

    warnShutdown: {
      description: "Broadcast a shutdown warning to Minecraft players and wait 30 seconds",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root" } = context.globalArgs;

        if (!isValidSshHost(sshHost)) {
          console.log(`[warnShutdown] No sshHost - skipping warning`);
          const handle = await context.writeResource("server", "server", { success: true, skipped: true });
          return { dataHandles: [handle] };
        }

        // Check tmux session exists
        const tmuxCheck = await sshExecRaw(sshHost, sshUser, "tmux has-session -t mons 2>/dev/null && echo exists || echo missing");
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[warnShutdown] No tmux session - skipping warning`);
          const handle = await context.writeResource("server", "server", { success: true, skipped: true });
          return { dataHandles: [handle] };
        }

        // Broadcast warning 3 times
        console.log(`[warnShutdown] Broadcasting shutdown warning...`);
        for (let i = 0; i < 3; i++) {
          await sshExecRaw(sshHost, sshUser, "tmux send-keys -t mons 'say == SERVER SHUTTING DOWN IN 30 SECONDS ==' Enter");
        }

        // Wait 30 seconds
        console.log(`[warnShutdown] Waiting 30s...`);
        await new Promise(r => setTimeout(r, 30000));

        console.log(`[warnShutdown] Done`);
        const handle = await context.writeResource("server", "server", { success: true, skipped: false });
        return { dataHandles: [handle] };
      },
    },

    stopMinecraftServer: {
      description: "Gracefully stop a Minecraft server running in a tmux session via SSH, then wait for java to exit",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root" } = context.globalArgs;

        if (!isValidSshHost(sshHost)) {
          console.log(`[stopMinecraftServer] No sshHost - VM may be stopped already`);
          const handle = await context.writeResource("server", "server", { success: true, alreadyStopped: true, timedOut: false, timestamp: new Date().toISOString() });
          return { dataHandles: [handle] };
        }

        // Quick SSH reachability check
        const reachable = await sshExecRaw(sshHost, sshUser, "echo ok");
        if (reachable.code !== 0) {
          console.log(`[stopMinecraftServer] SSH unreachable at ${sshHost} - VM may be stopped already`);
          const handle = await context.writeResource("server", "server", { success: true, alreadyStopped: true, timedOut: false, timestamp: new Date().toISOString() });
          return { dataHandles: [handle] };
        }

        // Check if tmux session 'mons' exists and java is running
        const tmuxCheck = await sshExecRaw(sshHost, sshUser, "tmux has-session -t mons 2>/dev/null && echo exists || echo missing");
        const javaCheck = await sshExecRaw(sshHost, sshUser, "pgrep -f java > /dev/null 2>&1 && echo running || echo stopped");

        const tmuxExists = tmuxCheck.stdout.trim() === "exists";
        const javaRunning = javaCheck.stdout.trim() === "running";

        if (!tmuxExists && !javaRunning) {
          console.log(`[stopMinecraftServer] No tmux session and no java process - server already stopped`);
          const handle = await context.writeResource("server", "server", { success: true, alreadyStopped: true, timedOut: false, timestamp: new Date().toISOString() });
          return { dataHandles: [handle] };
        }

        // Send 'stop' command to MC console
        if (tmuxExists) {
          console.log(`[stopMinecraftServer] Sending 'stop' command to tmux session 'mons'...`);
          await sshExecRaw(sshHost, sshUser, "tmux send-keys -t mons 'stop' Enter");
        }

        // Wait for java to exit
        const javaPid = await sshExecRaw(sshHost, sshUser, "pgrep -f 'java.*neoforge' || pgrep -f java");
        const originalPid = javaPid.stdout.trim().split('\n')[0];
        console.log(`[stopMinecraftServer] Tracking java PID ${originalPid}, waiting for exit (up to 90s)...`);

        const pollTimeout = 90;
        const pollStart = Date.now();
        const pollDeadline = pollStart + (pollTimeout * 1000);
        let timedOut = false;

        while (Date.now() < pollDeadline) {
          await new Promise(r => setTimeout(r, 3000));
          const check = await sshExecRaw(sshHost, sshUser, `kill -0 ${originalPid} 2>/dev/null && echo running || echo stopped`);
          if (check.stdout.trim() === "stopped") {
            const elapsed = Math.round((Date.now() - pollStart) / 1000);
            console.log(`[stopMinecraftServer] Java PID ${originalPid} exited after ${elapsed}s`);
            break;
          }
        }

        if (Date.now() >= pollDeadline) {
          timedOut = true;
          console.log(`[stopMinecraftServer] Timed out waiting for java to exit`);
        }

        // Kill tmux session to prevent the restart loop from respawning
        console.log(`[stopMinecraftServer] Killing tmux session to prevent restart loop...`);
        await sshExecRaw(sshHost, sshUser, "tmux kill-session -t mons 2>/dev/null || true");

        console.log(`[stopMinecraftServer] Done (timedOut=${timedOut})`);
        const handle = await context.writeResource("server", "server", { success: true, alreadyStopped: false, timedOut, ip: sshHost, timestamp: new Date().toISOString() });
        return { dataHandles: [handle] };
      },
    },

    status: {
      description: "Query Minecraft server status: player count and names",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root" } = context.globalArgs;

        if (!isValidSshHost(sshHost)) {
          console.log(`[status] No sshHost - VM may be stopped`);
          const handle = await context.writeResource("server", "server", { serverRunning: false, timestamp: new Date().toISOString() });
          return { dataHandles: [handle] };
        }

        // Quick SSH reachability check
        const reachable = await sshExecRaw(sshHost, sshUser, "echo ok");
        if (reachable.code !== 0) {
          console.log(`[status] SSH unreachable at ${sshHost} - VM may be stopped`);
          const handle = await context.writeResource("server", "server", { serverRunning: false, timestamp: new Date().toISOString() });
          return { dataHandles: [handle] };
        }

        // Check tmux session exists
        const tmuxCheck = await sshExecRaw(sshHost, sshUser, "tmux has-session -t mons 2>/dev/null && echo exists || echo missing");
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[status] No tmux session - server not running`);
          const handle = await context.writeResource("server", "server", { serverRunning: false, timestamp: new Date().toISOString() });
          return { dataHandles: [handle] };
        }

        // Record current log line count
        const wcResult = await sshExecRaw(sshHost, sshUser, "wc -l < ~/mons/logs/latest.log");
        const lineCount = parseInt(wcResult.stdout.trim(), 10) || 0;
        console.log(`[status] Log has ${lineCount} lines, sending 'list' command...`);

        // Send 'list' command to MC console
        await sshExecRaw(sshHost, sshUser, "tmux send-keys -t mons 'list' Enter");

        // Wait for server to process the command
        await new Promise(r => setTimeout(r, 2000));

        // Read new log lines
        const tailResult = await sshExecRaw(sshHost, sshUser, `tail -n +${lineCount + 1} ~/mons/logs/latest.log`);
        const newLines = tailResult.stdout;

        // Parse for player list response
        const match = newLines.match(/There are (\d+) of a max of (\d+) players online:(.*)/);
        if (match) {
          const online = parseInt(match[1], 10);
          const max = parseInt(match[2], 10);
          const playerStr = match[3].trim();
          const players = playerStr ? playerStr.split(",").map(p => p.trim()).filter(Boolean) : [];
          console.log(`[status] ${online}/${max} players online: ${players.join(", ") || "(none)"}`);
          const handle = await context.writeResource("server", "server", { serverRunning: true, online, max, players, timestamp: new Date().toISOString() });
          return { dataHandles: [handle] };
        }

        console.log(`[status] Could not parse player list from log`);
        const handle = await context.writeResource("server", "server", { serverRunning: true, online: null, max: null, players: [], timestamp: new Date().toISOString() });
        return { dataHandles: [handle] };
      },
    },

    startMinecraftServer: {
      description: "Start a Minecraft server in a tmux session via SSH on a running VM",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root" } = context.globalArgs;

        if (!isValidSshHost(sshHost)) {
          throw new Error("sshHost is required - is the VM running?");
        }

        // Wait for SSH to be ready
        console.log(`[startMinecraftServer] Waiting for SSH on ${sshHost}...`);
        const sshReady = await waitForSsh(sshHost, sshUser);
        if (!sshReady) {
          throw new Error(`SSH not reachable on ${sshHost} after 60s`);
        }

        // Kill stale tmux session (ignore errors)
        console.log(`[startMinecraftServer] Cleaning up stale tmux session...`);
        await sshExecRaw(sshHost, sshUser, "tmux kill-session -t mons 2>/dev/null || true");

        // Truncate old log so we only detect the new "Done" line
        await sshExecRaw(sshHost, sshUser, "truncate -s 0 ~/mons/logs/latest.log 2>/dev/null || true");

        // Start new tmux session with startserver.sh
        console.log(`[startMinecraftServer] Starting Minecraft server in tmux session 'mons'...`);
        const startResult = await sshExecRaw(sshHost, sshUser, "tmux new-session -d -s mons -c ~/mons './startserver.sh'");
        if (startResult.code !== 0) {
          throw new Error(`Failed to start tmux session: ${startResult.stderr}`);
        }

        // Wait for server to be ready (poll logs for "Done" message)
        const readyTimeout = 180; // 3 minutes
        const readyPoll = 5; // seconds
        const readyStart = Date.now();
        const readyDeadline = readyStart + (readyTimeout * 1000);
        console.log(`[startMinecraftServer] Waiting up to ${readyTimeout}s for server to be ready...`);

        let serverReady = false;
        while (Date.now() < readyDeadline) {
          const logCheck = await sshExecRaw(sshHost, sshUser, "grep -q 'DedicatedServer/\\]: Done' ~/mons/logs/latest.log 2>/dev/null && echo READY || echo WAITING");
          if (logCheck.stdout.trim() === "READY") {
            const elapsed = Math.round((Date.now() - readyStart) / 1000);
            console.log(`[startMinecraftServer] Server is ready! (${elapsed}s)`);
            serverReady = true;
            break;
          }
          const elapsed = Math.round((Date.now() - readyStart) / 1000);
          console.log(`[startMinecraftServer] Server not ready yet (${elapsed}s elapsed), polling in ${readyPoll}s...`);
          await new Promise(r => setTimeout(r, readyPoll * 1000));
        }

        if (!serverReady) {
          throw new Error(`Minecraft server did not become ready within ${readyTimeout}s`);
        }

        const handle = await context.writeResource("server", "server", { success: true, ip: sshHost, serverReady: true, timestamp: new Date().toISOString() });
        return { dataHandles: [handle] };
      },
    },
  },
};
