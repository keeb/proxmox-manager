// SSH helpers shared across extension models.

export function isValidSshHost(host) {
  if (!host) return false;
  if (typeof host !== "string") return false;
  if (host === "null" || host === "undefined") return false;
  return true;
}

export async function sshExec(ip, user, command) {
  // @ts-ignore - Deno API
  const proc = new Deno.Command("ssh", {
    args: [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=10",
      `${user}@${ip}`,
      command,
    ],
  });
  const result = await proc.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.code !== 0) {
    throw new Error(`SSH command failed (exit ${result.code}): ${stderr.slice(-500)}`);
  }
  return { code: result.code, stdout, stderr };
}

export async function sshExecRaw(ip, user, command) {
  // @ts-ignore - Deno API
  const proc = new Deno.Command("ssh", {
    args: [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=10",
      `${user}@${ip}`,
      command,
    ],
  });
  const result = await proc.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  return { code: result.code, stdout, stderr };
}

export async function waitForSsh(ip, user, timeoutSeconds = 60, pollInterval = 3) {
  const deadline = Date.now() + (timeoutSeconds * 1000);

  while (Date.now() < deadline) {
    const result = await sshExecRaw(ip, user, "echo ready");
    if (result.code === 0 && result.stdout.trim() === "ready") {
      return true;
    }
    await new Promise(r => setTimeout(r, pollInterval * 1000));
  }

  return false;
}
