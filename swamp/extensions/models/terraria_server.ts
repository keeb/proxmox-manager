import { z } from "npm:zod@4";
import { isValidSshHost, sshExecRaw } from "./lib/ssh.ts";

const GlobalArgs = z.object({
  sshHost: z.string().nullable().describe("SSH hostname/IP (set via CEL from lookup model)"),
  sshUser: z.string().default("root").describe("SSH user (default 'root')"),
  containerName: z.string().default("tmodloader").describe("Docker container name running tModLoader"),
});

const ServerSchema = z.object({
  success: z.boolean().optional(),
  skipped: z.boolean().optional(),
  serverRunning: z.boolean().optional(),
  online: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  players: z.array(z.string()).optional(),
  timestamp: z.string().optional(),
});

export const model = {
  type: "@user/terraria/server",
  version: "2026.02.11.1",
  resources: {
    "server": {
      description: "Terraria server operation result",
      schema: ServerSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
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
          const handle = await context.writeResource("server", "server", { success: true, skipped: true });
          return { dataHandles: [handle] };
        }

        // Check container is running
        const containerCheck = await sshExecRaw(sshHost, sshUser, `docker inspect --format '{{.State.Running}}' ${containerName} 2>/dev/null`);
        if (containerCheck.code !== 0 || containerCheck.stdout.trim() !== "true") {
          console.log(`[warnShutdown] Container ${containerName} not running - skipping warning`);
          const handle = await context.writeResource("server", "server", { success: true, skipped: true });
          return { dataHandles: [handle] };
        }

        // Check tmux session exists inside container
        const tmuxCheck = await sshExecRaw(sshHost, sshUser, `docker exec ${containerName} tmux has-session 2>/dev/null && echo exists || echo missing`);
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[warnShutdown] No tmux session in container - skipping warning`);
          const handle = await context.writeResource("server", "server", { success: true, skipped: true });
          return { dataHandles: [handle] };
        }

        // Broadcast warning 3 times
        console.log(`[warnShutdown] Broadcasting shutdown warning...`);
        for (let i = 0; i < 3; i++) {
          await sshExecRaw(sshHost, sshUser, `docker exec ${containerName} tmux send-keys "say == SERVER SHUTTING DOWN IN 30 SECONDS ==" Enter`);
        }

        // Wait 30 seconds
        console.log(`[warnShutdown] Waiting 30s...`);
        await new Promise(r => setTimeout(r, 30000));

        console.log(`[warnShutdown] Done`);
        const handle = await context.writeResource("server", "server", { success: true, skipped: false });
        return { dataHandles: [handle] };
      },
    },

    status: {
      description: "Query Terraria server status: player count and names",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { sshHost, sshUser = "root", containerName = "tmodloader" } = context.globalArgs;

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

        // Check container is running
        const containerCheck = await sshExecRaw(sshHost, sshUser, `docker inspect --format '{{.State.Running}}' ${containerName} 2>/dev/null`);
        if (containerCheck.code !== 0 || containerCheck.stdout.trim() !== "true") {
          console.log(`[status] Container ${containerName} not running`);
          const handle = await context.writeResource("server", "server", { serverRunning: false, timestamp: new Date().toISOString() });
          return { dataHandles: [handle] };
        }

        // Check tmux session exists inside container
        const tmuxCheck = await sshExecRaw(sshHost, sshUser, `docker exec ${containerName} tmux has-session 2>/dev/null && echo exists || echo missing`);
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[status] No tmux session in container - server not running`);
          const handle = await context.writeResource("server", "server", { serverRunning: false, timestamp: new Date().toISOString() });
          return { dataHandles: [handle] };
        }

        // Send 'playing' command to Terraria console
        await sshExecRaw(sshHost, sshUser, `docker exec ${containerName} tmux send-keys "playing" Enter`);

        // Wait for server to process the command
        await new Promise(r => setTimeout(r, 2000));

        // Capture tmux pane output
        const paneResult = await sshExecRaw(sshHost, sshUser, `docker exec ${containerName} tmux capture-pane -p`);
        const paneOutput = paneResult.stdout;

        // Parse the last "playing" response block from the pane.
        // tModLoader format:
        //   ": No players connected."
        // or:
        //   ": player1 (ip:port)"
        //   ": player2 (ip:port)"
        //   "N player(s) connected."
        const lines = paneOutput.split("\n");

        // Find the last count line (works backwards to get most recent)
        let countLineIdx = -1;
        let online = 0;
        for (let i = lines.length - 1; i >= 0; i--) {
          const noMatch = lines[i].match(/:\s*No players connected\./);
          if (noMatch) { countLineIdx = i; online = 0; break; }
          const numMatch = lines[i].match(/(\d+)\s+players?\s+connected\./);
          if (numMatch) { countLineIdx = i; online = parseInt(numMatch[1], 10); break; }
        }

        if (countLineIdx >= 0) {
          // Player names appear on lines ABOVE the count line, prefixed with ": "
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
          const handle = await context.writeResource("server", "server", { serverRunning: true, online, max: null, players, timestamp: new Date().toISOString() });
          return { dataHandles: [handle] };
        }

        console.log(`[status] Could not parse player list from pane output`);
        const handle = await context.writeResource("server", "server", { serverRunning: true, online: null, max: null, players: [], timestamp: new Date().toISOString() });
        return { dataHandles: [handle] };
      },
    },
  },
};
