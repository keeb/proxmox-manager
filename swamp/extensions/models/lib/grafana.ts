// Grafana API helpers — all calls go through `docker exec grafana curl` on the Grafana host.
// Follows untyped-params pattern of lib/ssh.ts.

import { sshExec, sshExecRaw } from "./ssh.ts";

export async function grafanaApiGet(sshHost, sshUser, path) {
  const cmd = `docker exec grafana curl -sf 'http://localhost:3000${path}' -H 'Content-Type: application/json'`;
  const result = await sshExec(sshHost, sshUser, cmd);
  return JSON.parse(result.stdout);
}

export async function grafanaApiPost(sshHost, sshUser, path, body) {
  const escaped = JSON.stringify(JSON.stringify(body));
  const cmd = `docker exec grafana curl -sf -X POST 'http://localhost:3000${path}' -H 'Content-Type: application/json' -d ${escaped}`;
  const result = await sshExec(sshHost, sshUser, cmd);
  if (!result.stdout.trim()) return {};
  return JSON.parse(result.stdout);
}

export async function grafanaApiPut(sshHost, sshUser, path, body) {
  const escaped = JSON.stringify(JSON.stringify(body));
  const cmd = `docker exec grafana curl -sf -X PUT 'http://localhost:3000${path}' -H 'Content-Type: application/json' -d ${escaped}`;
  const result = await sshExec(sshHost, sshUser, cmd);
  if (!result.stdout.trim()) return {};
  return JSON.parse(result.stdout);
}

export async function grafanaApiDelete(sshHost, sshUser, path) {
  const cmd = `docker exec grafana curl -sf -X DELETE 'http://localhost:3000${path}' -H 'Content-Type: application/json'`;
  const result = await sshExec(sshHost, sshUser, cmd);
  if (!result.stdout.trim()) return {};
  return JSON.parse(result.stdout);
}

// For large payloads (dashboards, alert rules): SCP file to host, docker cp into container, curl from file.
export async function grafanaApiPostFile(sshHost, sshUser, path, localFilePath) {
  const tmpName = `grafana-upload-${Date.now()}.json`;
  const remoteTmp = `/tmp/${tmpName}`;
  const containerTmp = `/tmp/${tmpName}`;

  // SCP file to the Grafana host
  // @ts-ignore - Deno API
  const scp = new Deno.Command("scp", {
    args: [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=10",
      localFilePath,
      `${sshUser}@${sshHost}:${remoteTmp}`,
    ],
  });
  const scpResult = await scp.output();
  if (scpResult.code !== 0) {
    const err = new TextDecoder().decode(scpResult.stderr);
    throw new Error(`SCP to ${sshHost} failed: ${err}`);
  }

  try {
    // docker cp into the grafana container
    await sshExec(sshHost, sshUser, `docker cp ${remoteTmp} grafana:${containerTmp}`);

    // POST using the file inside the container
    const cmd = `docker exec grafana curl -sf -X POST 'http://localhost:3000${path}' -H 'Content-Type: application/json' -d @${containerTmp}`;
    const result = await sshExec(sshHost, sshUser, cmd);
    if (!result.stdout.trim()) return {};
    return JSON.parse(result.stdout);
  } finally {
    // Clean up temp files
    await sshExecRaw(sshHost, sshUser, `rm -f ${remoteTmp}; docker exec grafana rm -f ${containerTmp}`);
  }
}
