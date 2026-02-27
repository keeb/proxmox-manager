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
async function grafanaApiDelete(sshHost, sshUser, path) {
  const cmd = `docker exec grafana curl -sf -X DELETE 'http://localhost:3000${path}' -H 'Content-Type: application/json'`;
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
export {
  grafanaApiDelete,
  grafanaApiGet,
  grafanaApiPost,
  grafanaApiPostFile,
  grafanaApiPut
};
