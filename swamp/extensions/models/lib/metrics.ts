// Shared helpers for game server metrics collection.
// Formats Prometheus textfile metrics and JSON log lines, writes via SSH.

import { sshExec } from "./ssh.ts";

// PlayerData shape: { online, max, players, serverRunning }

export function formatPromMetrics(gameType, serverName, data) {
  const labels = `game="${gameType}",server="${serverName}"`;
  const running = data.serverRunning ? 1 : 0;
  const lines = [
    `# HELP game_server_running Whether the game server process is running`,
    `# TYPE game_server_running gauge`,
    `game_server_running{${labels}} ${running}`,
    `# HELP game_players_online Current number of players online`,
    `# TYPE game_players_online gauge`,
    `game_players_online{${labels}} ${data.online}`,
  ];
  if (data.max !== null) {
    lines.push(
      `# HELP game_players_max Maximum player slots`,
      `# TYPE game_players_max gauge`,
      `game_players_max{${labels}} ${data.max}`,
    );
  }
  lines.push(
    `# HELP game_metrics_collected_at Unix timestamp of last successful collection`,
    `# TYPE game_metrics_collected_at gauge`,
    `game_metrics_collected_at{${labels}} ${Math.floor(Date.now() / 1000)}`,
  );
  return lines.join("\n") + "\n";
}

export function formatLogLine(gameType, serverName, data) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    game: gameType,
    server: serverName,
    running: data.serverRunning,
    online: data.online,
    max: data.max,
    players: data.players,
  });
}

export async function writeMetricsFiles(sshHost, sshUser, gameType, serverName, data) {
  const promContent = formatPromMetrics(gameType, serverName, data);
  const logLine = formatLogLine(gameType, serverName, data);

  const promDir = "/var/lib/node_exporter/textfile_collector";
  const promFile = `${promDir}/game_${gameType}.prom`;
  const logFile = "/var/log/game-players.log";

  // Atomic write: tmp → mv (prevents partial reads by node-exporter)
  await sshExec(sshHost, sshUser,
    `mkdir -p ${promDir} && cat > ${promFile}.tmp << 'PROMEOF'\n${promContent}PROMEOF\nmv ${promFile}.tmp ${promFile}`);

  // Append JSON log line (promtail picks it up)
  await sshExec(sshHost, sshUser,
    `echo '${logLine.replace(/'/g, "'\\''")}' >> ${logFile}`);
}
