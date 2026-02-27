// extensions/models/lib/proxmox.ts
async function fetchWithCurl(url, options) {
  const { method = "GET", headers = {}, body, skipTlsVerify } = options;
  const args = [
    "-s",
    "-S"
  ];
  if (skipTlsVerify) {
    args.push("-k");
  }
  args.push("-X", method);
  for (const [key, value] of Object.entries(headers)) {
    args.push("-H", `${key}: ${value}`);
  }
  if (body) {
    args.push("-d", body);
  }
  args.push("-i");
  args.push(url);
  const command = new Deno.Command("curl", {
    args
  });
  const { code, stdout, stderr } = await command.output();
  if (code !== 0) {
    const errorText = new TextDecoder().decode(stderr);
    throw new Error(`curl failed with code ${code}: ${errorText}`);
  }
  const output = new TextDecoder().decode(stdout);
  const headerEndIndex = output.indexOf("\r\n\r\n");
  const headersText = output.substring(0, headerEndIndex);
  const bodyText = output.substring(headerEndIndex + 4);
  const statusLine = headersText.split("\r\n")[0];
  const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1]) : 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: statusLine,
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText)
  };
}
async function waitForTask(apiUrl, node, upid, ticket, csrfToken, skipTlsVerify) {
  const encodedUpid = encodeURIComponent(upid);
  const url = `${apiUrl}/api2/json/nodes/${node}/tasks/${encodedUpid}/status`;
  let pollCount = 0;
  while (true) {
    pollCount++;
    const response = await fetchWithCurl(url, {
      method: "GET",
      headers: {
        "Cookie": `PVEAuthCookie=${ticket}`,
        ...csrfToken && {
          "CSRFPreventionToken": csrfToken
        }
      },
      skipTlsVerify
    });
    if (!response.ok) {
      throw new Error(`Task status check failed: ${response.status}`);
    }
    const result = await response.json();
    const status = result.data?.status;
    if (status === "stopped") {
      const exitstatus = result.data?.exitstatus;
      return {
        success: exitstatus === "OK",
        exitstatus,
        pollCount
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1e3));
  }
}
var AUTH_TTL_MS = 2 * 60 * 60 * 1e3;
async function resolveAuth(globalArgs, context, opts = {}) {
  const { apiUrl, skipTlsVerify } = globalArgs;
  const { ticket: explicitTicket, csrfToken: explicitCsrf } = globalArgs;
  if (explicitTicket && explicitCsrf) {
    return {
      ticket: explicitTicket,
      csrfToken: explicitCsrf,
      source: "explicit",
      freshAuth: false
    };
  }
  if (!opts.skipCache) {
    try {
      const modelType = opts.modelType || "@user/proxmox/api";
      const defId = context.definition.id;
      const authDir = `${context.repoDir}/.swamp/data/${modelType}/${defId}/auth`;
      const entries = [];
      for await (const entry of Deno.readDir(authDir)) {
        if (entry.isDirectory) entries.push(entry);
      }
      if (entries.length > 0) {
        const versions = entries.map((e) => parseInt(e.name, 10)).filter((n) => !isNaN(n));
        const latest = Math.max(...versions);
        const rawPath = `${authDir}/${latest}/raw`;
        const metaPath = `${authDir}/${latest}/metadata.yaml`;
        const metaText = await Deno.readTextFile(metaPath);
        const createdAtMatch = metaText.match(/createdAt:\s*'([^']+)'/);
        if (createdAtMatch) {
          const createdAt = new Date(createdAtMatch[1]);
          const ageMs = Date.now() - createdAt.getTime();
          if (ageMs < AUTH_TTL_MS) {
            const rawText = await Deno.readTextFile(rawPath);
            const cached = JSON.parse(rawText);
            return {
              ticket: cached.ticket,
              csrfToken: cached.csrfToken,
              source: "cache",
              freshAuth: false
            };
          }
        }
      }
    } catch (_e) {
    }
  }
  const { username, password, realm } = globalArgs;
  if (!username || !password) {
    throw new Error("No auth available: no explicit ticket, no valid cached auth, and no username/password. Run 'swamp workflow run sync-proxmox-vms --json' to authenticate via vault.");
  }
  const authUrl = `${apiUrl}/api2/json/access/ticket`;
  const formData = new URLSearchParams();
  formData.append("username", `${username}@${realm || "pam"}`);
  formData.append("password", password);
  const response = await fetchWithCurl(authUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: formData.toString(),
    skipTlsVerify: skipTlsVerify ?? true
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Authentication failed: ${response.status} ${response.statusText} - ${errorText}`);
  }
  const result = await response.json();
  const { ticket, CSRFPreventionToken } = result.data;
  return {
    ticket,
    csrfToken: CSRFPreventionToken,
    username: `${username}@${realm || "pam"}`,
    source: "password",
    freshAuth: true
  };
}
function is401(e) {
  return e instanceof Error && (e.message.includes("401") || e.message.includes("authentication"));
}
async function getVmIpWithRetry(apiUrl, node, vmid, ticket, csrfToken, skipTlsVerify, waitSeconds = 120, pollInterval = 5) {
  const deadline = Date.now() + waitSeconds * 1e3;
  while (Date.now() < deadline) {
    try {
      const netResponse = await fetchWithCurl(`${apiUrl}/api2/json/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`, {
        method: "GET",
        headers: {
          "Cookie": `PVEAuthCookie=${ticket}`,
          "CSRFPreventionToken": csrfToken
        },
        skipTlsVerify: skipTlsVerify ?? true
      });
      if (netResponse.ok) {
        const netResult = await netResponse.json();
        const interfaces = netResult.data?.result || [];
        for (const iface of interfaces) {
          if (iface.name === "lo") continue;
          const ips = iface["ip-addresses"] || [];
          for (const ip of ips) {
            if (ip["ip-address-type"] === "ipv4" && !ip["ip-address"].startsWith("127.")) {
              return ip["ip-address"];
            }
          }
        }
      }
    } catch (_e) {
    }
    await new Promise((r) => setTimeout(r, pollInterval * 1e3));
  }
  return null;
}
export {
  AUTH_TTL_MS,
  fetchWithCurl,
  getVmIpWithRetry,
  is401,
  resolveAuth,
  waitForTask
};
