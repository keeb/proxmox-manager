import { z } from "npm:zod@4";
import {
  fetchWithCurl, waitForTask, resolveAuth,
  getVmIpWithRetry,
} from "./lib/proxmox.ts";

// Global arguments — Proxmox connection params shared by every method
const ProxmoxConnectionArgs = z.object({
  apiUrl: z.string().describe("Proxmox API base URL (e.g., https://10.0.0.4:8006)"),
  ticket: z.string().optional().describe("Auth ticket from keebDev02"),
  csrfToken: z.string().optional().describe("CSRF token from keebDev02"),
  node: z.string().describe("Proxmox node name"),
  skipTlsVerify: z.boolean().default(true).describe("Skip TLS certificate verification"),
});

// Per-method argument schemas (method-specific fields only)
const LookupArgs = z.object({
  vmName: z.string().describe("VM name to manage"),
});

const StartArgs = z.object({
  vmName: z.string().describe("VM name to manage"),
  waitSeconds: z.number().default(120).describe("Max seconds to wait for VM IP"),
  pollInterval: z.number().default(5).describe("Seconds between IP poll attempts"),
});

const StopArgs = z.object({
  vmName: z.string().describe("VM name to manage"),
});

const DeleteArgs = z.object({
  vmName: z.string().describe("VM name to manage"),
});

const CreateArgs = z.object({
  vmName: z.string().describe("VM name to manage"),
  memory: z.number().optional().describe("Memory in MB (default 2048)"),
  cores: z.number().optional().describe("CPU cores (default 2)"),
  sockets: z.number().optional().describe("CPU sockets (default 1)"),
  diskSize: z.number().optional().describe("Disk size in GB (default 32, 0 for PXE-only)"),
  diskStorage: z.string().optional().describe("Storage pool (default 'local-lvm')"),
  networkBridge: z.string().optional().describe("Network bridge (default 'vmbr0')"),
  osType: z.string().optional().describe("OS type (default 'l26')"),
});

const SetBootOrderArgs = z.object({
  vmName: z.string().describe("VM name to manage"),
  boot: z.string().describe("Boot order string (e.g. 'order=scsi0;net0')"),
});

const SetConfigArgs = z.object({
  vmName: z.string().describe("VM name to manage"),
  config: z.record(z.string(), z.string()).describe("Arbitrary VM config key/values for setConfig method"),
});

const SyncArgs = z.object({});

const VmDataSchema = z.object({
  vmid: z.number(),
  vmName: z.string(),
  status: z.string().optional(),
  ip: z.string().nullable().optional(),
  maxmem: z.number().optional().describe("Allocated memory in bytes"),
  maxcpu: z.number().optional().describe("Allocated CPU count"),
  success: z.boolean().optional(),
  wasStarted: z.boolean().optional(),
  boot: z.string().optional(),
  config: z.record(z.string(), z.string()).optional(),
  logs: z.string().optional(),
  timestamp: z.string(),
});

async function resolveVm(apiUrl, node, vmName, ticket, csrfToken, skipTlsVerify) {
  const listUrl = `${apiUrl}/api2/json/nodes/${node}/qemu`;
  const listResponse = await fetchWithCurl(listUrl, {
    method: "GET",
    headers: {
      "Cookie": `PVEAuthCookie=${ticket}`,
      "CSRFPreventionToken": csrfToken,
    },
    skipTlsVerify: skipTlsVerify ?? true,
  });

  if (!listResponse.ok) {
    throw new Error(`Failed to list VMs: ${listResponse.status} ${await listResponse.text()}`);
  }

  const vms = (await listResponse.json()).data;
  const vm = vms.find((v) => v.name === vmName);
  if (!vm) {
    const names = vms.map((v) => v.name).filter(Boolean).join(", ");
    throw new Error(`VM "${vmName}" not found. Available: ${names}`);
  }

  return { vmid: vm.vmid, name: vm.name, status: vm.status };
}

function authOpts() {
  return { modelType: "@user/proxmox/vm" };
}

export const model = {
  type: "@user/proxmox/vm",
  version: "2026.02.18.1",
  resources: {
    "vm": {
      description: "VM operation result",
      schema: VmDataSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  globalArguments: ProxmoxConnectionArgs,
  methods: {
    lookup: {
      description: "Look up VM by name, return vmid and IP if running",
      arguments: LookupArgs,
      execute: async (args, context) => {
        const { vmName } = args;
        const { apiUrl, node, skipTlsVerify } = context.globalArgs;
        const logs = [];
        const log = (msg) => logs.push(msg);

        log(`Looking up VM "${vmName}" on node ${node}`);

        const auth = await resolveAuth(context.globalArgs, context, authOpts());
        const vm = await resolveVm(apiUrl, node, vmName, auth.ticket, auth.csrfToken, skipTlsVerify);

        log(`Found VM "${vmName}" → vmid ${vm.vmid} [${vm.status}]`);

        let ip = null;
        if (vm.status === "running") {
          log(`VM is running, fetching IP from guest agent`);
          ip = await getVmIpWithRetry(apiUrl, node, vm.vmid, auth.ticket, auth.csrfToken, skipTlsVerify, 15, 3);
          if (ip) {
            log(`Got IP: ${ip}`);
          } else {
            log(`Could not get IP from guest agent`);
          }
        }

        const handle = await context.writeResource("vm", vm.name, {
          vmid: vm.vmid, vmName: vm.name, status: vm.status, ip,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    start: {
      description: "Start VM if stopped (idempotent), wait for IP. Replaces ensureVmRunning.",
      arguments: StartArgs,
      execute: async (args, context) => {
        const { vmName, waitSeconds = 120, pollInterval = 5 } = args;
        const { apiUrl, node, skipTlsVerify } = context.globalArgs;
        const logs = [];
        const log = (msg) => logs.push(msg);

        log(`Ensuring VM "${vmName}" is running on node ${node}`);

        const auth = await resolveAuth(context.globalArgs, context, authOpts());
        const { ticket, csrfToken } = auth;

        const vm = await resolveVm(apiUrl, node, vmName, ticket, csrfToken, skipTlsVerify);
        log(`Found VM "${vmName}" → vmid ${vm.vmid} [${vm.status}]`);

        let wasStarted = false;
        if (vm.status === "stopped") {
          log(`VM is stopped, starting`);
          const startResponse = await fetchWithCurl(`${apiUrl}/api2/json/nodes/${node}/qemu/${vm.vmid}/status/start`, {
            method: "POST",
            headers: {
              "Cookie": `PVEAuthCookie=${ticket}`,
              "Content-Type": "application/x-www-form-urlencoded",
              "CSRFPreventionToken": csrfToken,
            },
            skipTlsVerify: skipTlsVerify ?? true,
          });

          if (!startResponse.ok) {
            throw new Error(`Failed to start VM: ${startResponse.status} ${await startResponse.text()}`);
          }

          const upid = (await startResponse.json()).data;
          const taskResult = await waitForTask(apiUrl, node, upid, ticket, csrfToken, skipTlsVerify ?? true);
          if (!taskResult.success) {
            throw new Error(`VM start failed: ${taskResult.exitstatus}`);
          }
          wasStarted = true;
          log(`VM ${vm.vmid} started successfully (${taskResult.pollCount} polls)`);
        } else {
          log(`VM is already running`);
        }

        log(`Waiting for guest agent IP (up to ${waitSeconds}s)`);
        const ip = await getVmIpWithRetry(apiUrl, node, vm.vmid, ticket, csrfToken, skipTlsVerify, waitSeconds, pollInterval);
        if (ip) {
          log(`Got IP: ${ip}`);
        } else {
          throw new Error(`VM "${vmName}" (vmid ${vm.vmid}) is running but guest agent did not return an IP within ${waitSeconds}s. Is qemu-guest-agent installed and agent enabled in VM config?`);
        }

        const handle = await context.writeResource("vm", vm.name, {
          vmid: vm.vmid, vmName: vm.name, status: "running", ip, wasStarted,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    stop: {
      description: "Stop a VM by name",
      arguments: StopArgs,
      execute: async (args, context) => {
        const { vmName } = args;
        const { apiUrl, node, skipTlsVerify } = context.globalArgs;
        const logs = [];
        const log = (msg) => logs.push(msg);

        log(`Stopping VM "${vmName}" on node ${node}`);

        const auth = await resolveAuth(context.globalArgs, context, authOpts());
        const vm = await resolveVm(apiUrl, node, vmName, auth.ticket, auth.csrfToken, skipTlsVerify);
        log(`Found VM "${vmName}" → vmid ${vm.vmid} [${vm.status}]`);

        if (vm.status === "stopped") {
          log(`VM is already stopped`);
          const handle = await context.writeResource("vm", vm.name, {
            vmid: vm.vmid, vmName: vm.name, status: "stopped", ip: null, success: true,
            logs: logs.join("\n"),
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }

        log(`Sending stop command for VM ${vm.vmid}`);
        const response = await fetchWithCurl(`${apiUrl}/api2/json/nodes/${node}/qemu/${vm.vmid}/status/stop`, {
          method: "POST",
          headers: {
            "Cookie": `PVEAuthCookie=${auth.ticket}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "CSRFPreventionToken": auth.csrfToken,
          },
          skipTlsVerify: skipTlsVerify ?? true,
        });

        if (!response.ok) {
          throw new Error(`Failed to stop VM: ${response.status} ${await response.text()}`);
        }

        const upid = (await response.json()).data;
        log(`Stop task initiated, waiting for completion`);
        const taskResult = await waitForTask(apiUrl, node, upid, auth.ticket, auth.csrfToken, skipTlsVerify ?? true);

        if (taskResult.success) {
          log(`VM ${vm.vmid} stopped successfully (${taskResult.pollCount} polls)`);
        } else {
          log(`VM ${vm.vmid} stop failed: ${taskResult.exitstatus}`);
        }

        const handle = await context.writeResource("vm", vm.name, {
          vmid: vm.vmid, vmName: vm.name, status: "stopped", ip: null, success: taskResult.success,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    create: {
      description: "Create a new VM with PXE boot enabled, auto-allocating vmid",
      arguments: CreateArgs,
      execute: async (args, context) => {
        const { vmName, memory, cores, sockets, diskSize, diskStorage, networkBridge, osType } = args;
        const { apiUrl, node, skipTlsVerify } = context.globalArgs;
        const logs = [];
        const log = (msg) => logs.push(msg);

        log(`Creating VM "${vmName}" on node ${node}`);

        const auth = await resolveAuth(context.globalArgs, context, authOpts());
        const { ticket, csrfToken } = auth;
        const headers = {
          "Cookie": `PVEAuthCookie=${ticket}`,
          "CSRFPreventionToken": csrfToken,
        };

        // Get next available VM ID
        log(`Fetching next available VM ID`);
        const nextIdResponse = await fetchWithCurl(`${apiUrl}/api2/json/cluster/nextid`, {
          method: "GET", headers, skipTlsVerify: skipTlsVerify ?? true,
        });
        if (!nextIdResponse.ok) {
          throw new Error(`Failed to get next VM ID: ${await nextIdResponse.text()}`);
        }
        const vmid = parseInt((await nextIdResponse.json()).data, 10);
        log(`Got next VM ID: ${vmid}`);

        const hasDisk = diskSize !== 0;
        log(`Specs: ${memory ?? 2048}MB RAM, ${cores ?? 2} cores, ${hasDisk ? `${diskSize ?? 32}GB disk` : "no disk (PXE)"}`);

        const params = new URLSearchParams({
          vmid: String(vmid),
          name: vmName,
          memory: String(memory ?? 2048),
          cores: String(cores ?? 2),
          sockets: String(sockets ?? 1),
          ostype: osType ?? "l26",
          agent: "1",
          boot: hasDisk ? "order=net0;scsi0" : "order=net0",
          net0: `virtio,bridge=${networkBridge ?? "vmbr0"}`,
          scsihw: "virtio-scsi-single",
          smbios1: `base64=1,serial=${btoa(vmName)}`,
        });
        if (hasDisk) {
          params.set("scsi0", `${diskStorage ?? "local-lvm"}:${diskSize ?? 32},format=raw`);
        }

        const response = await fetchWithCurl(`${apiUrl}/api2/json/nodes/${node}/qemu`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
          skipTlsVerify: skipTlsVerify ?? true,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to create VM: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const upid = (await response.json()).data;
        log(`VM creation task started, waiting for completion`);
        const taskResult = await waitForTask(apiUrl, node, upid, ticket, csrfToken, skipTlsVerify ?? true);

        if (!taskResult.success) {
          throw new Error(`VM creation failed: ${taskResult.exitstatus}`);
        }

        log(`VM ${vmid} ("${vmName}") created successfully (${taskResult.pollCount} polls)`);

        const handle = await context.writeResource("vm", vmName, {
          vmid, vmName, status: "stopped", ip: null, success: true,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Stop (if running) and delete a VM by name",
      arguments: DeleteArgs,
      execute: async (args, context) => {
        const { vmName } = args;
        const { apiUrl, node, skipTlsVerify } = context.globalArgs;
        const logs = [];
        const log = (msg) => logs.push(msg);

        log(`Deleting VM "${vmName}" on node ${node}`);

        const auth = await resolveAuth(context.globalArgs, context, authOpts());
        const { ticket, csrfToken } = auth;

        const vm = await resolveVm(apiUrl, node, vmName, ticket, csrfToken, skipTlsVerify);
        log(`Found VM "${vmName}" → vmid ${vm.vmid} [${vm.status}]`);

        // Stop if running
        if (vm.status !== "stopped") {
          log(`VM is ${vm.status}, stopping first`);
          try {
            const stopResponse = await fetchWithCurl(`${apiUrl}/api2/json/nodes/${node}/qemu/${vm.vmid}/status/stop`, {
              method: "POST",
              headers: {
                "Cookie": `PVEAuthCookie=${ticket}`,
                "Content-Type": "application/x-www-form-urlencoded",
                "CSRFPreventionToken": csrfToken,
              },
              skipTlsVerify: skipTlsVerify ?? true,
            });
            if (stopResponse.ok) {
              const stopUpid = (await stopResponse.json()).data;
              const stopResult = await waitForTask(apiUrl, node, stopUpid, ticket, csrfToken, skipTlsVerify ?? true);
              log(`VM ${vm.vmid} stop: ${stopResult.exitstatus}`);
            } else {
              log(`VM may already be stopped, continuing to delete`);
            }
          } catch (_e) {
            log(`Stop failed (VM may already be stopped), continuing`);
          }
        }

        // Delete
        log(`Sending delete command for VM ${vm.vmid}`);
        const response = await fetchWithCurl(`${apiUrl}/api2/json/nodes/${node}/qemu/${vm.vmid}`, {
          method: "DELETE",
          headers: {
            "Cookie": `PVEAuthCookie=${ticket}`,
            "CSRFPreventionToken": csrfToken,
          },
          skipTlsVerify: skipTlsVerify ?? true,
        });

        if (!response.ok) {
          throw new Error(`Failed to delete VM: ${response.status} ${await response.text()}`);
        }

        const upid = (await response.json()).data;
        log(`Delete task initiated, waiting for completion`);
        const taskResult = await waitForTask(apiUrl, node, upid, ticket, csrfToken, skipTlsVerify ?? true);

        if (taskResult.success) {
          log(`VM ${vm.vmid} deleted successfully (${taskResult.pollCount} polls)`);
        } else {
          log(`VM ${vm.vmid} deletion failed: ${taskResult.exitstatus}`);
        }

        const handle = await context.writeResource("vm", vm.name, {
          vmid: vm.vmid, vmName: vm.name, status: "deleted", ip: null, success: taskResult.success,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    setBootOrder: {
      description: "Set VM boot order via Proxmox API",
      arguments: SetBootOrderArgs,
      execute: async (args, context) => {
        const { vmName, boot } = args;
        const { apiUrl, node, skipTlsVerify } = context.globalArgs;
        const logs = [];
        const log = (msg) => logs.push(msg);

        log(`Setting boot order for VM "${vmName}" to: ${boot}`);

        const auth = await resolveAuth(context.globalArgs, context, authOpts());
        const { ticket, csrfToken } = auth;

        const vm = await resolveVm(apiUrl, node, vmName, ticket, csrfToken, skipTlsVerify);
        log(`Found VM "${vmName}" → vmid ${vm.vmid}`);

        const params = new URLSearchParams({ boot });
        const response = await fetchWithCurl(`${apiUrl}/api2/json/nodes/${node}/qemu/${vm.vmid}/config`, {
          method: "PUT",
          headers: {
            "Cookie": `PVEAuthCookie=${ticket}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "CSRFPreventionToken": csrfToken,
          },
          body: params.toString(),
          skipTlsVerify: skipTlsVerify ?? true,
        });

        if (!response.ok) {
          throw new Error(`Failed to set boot order: ${response.status} ${await response.text()}`);
        }

        log(`Boot order updated for VM ${vm.vmid}: ${boot}`);

        const handle = await context.writeResource("vm", vm.name, {
          vmid: vm.vmid, vmName: vm.name, boot, success: true,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    setConfig: {
      description: "Set arbitrary VM config options via Proxmox API (e.g. agent, memory, cores)",
      arguments: SetConfigArgs,
      execute: async (args, context) => {
        const { vmName, config } = args;
        const { apiUrl, node, skipTlsVerify } = context.globalArgs;
        const logs = [];
        const log = (msg) => logs.push(msg);

        const auth = await resolveAuth(context.globalArgs, context, authOpts());
        const { ticket, csrfToken } = auth;

        const vm = await resolveVm(apiUrl, node, vmName, ticket, csrfToken, skipTlsVerify);
        log(`Found VM "${vmName}" → vmid ${vm.vmid}`);

        const configParams = new URLSearchParams();
        for (const [key, value] of Object.entries(config)) {
          configParams.set(key, String(value));
        }

        if ([...configParams].length === 0) {
          throw new Error("No config params provided. Pass config options via workflow step inputs, e.g. inputs: { config: { agent: '1' } }");
        }

        log(`Setting config: ${configParams.toString()}`);
        const response = await fetchWithCurl(`${apiUrl}/api2/json/nodes/${node}/qemu/${vm.vmid}/config`, {
          method: "PUT",
          headers: {
            "Cookie": `PVEAuthCookie=${ticket}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "CSRFPreventionToken": csrfToken,
          },
          body: configParams.toString(),
          skipTlsVerify: skipTlsVerify ?? true,
        });

        if (!response.ok) {
          throw new Error(`Failed to set config: ${response.status} ${await response.text()}`);
        }

        log(`Config updated for VM ${vm.vmid}`);

        const handle = await context.writeResource("vm", vm.name, {
          vmid: vm.vmid, vmName: vm.name, config: Object.fromEntries(configParams), success: true,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    sync: {
      description: "Sync all VMs from Proxmox — writes a named resource per VM",
      arguments: SyncArgs,
      execute: async (args, context) => {
        const { apiUrl, node, skipTlsVerify } = context.globalArgs;
        const logs = [];
        const log = (msg) => logs.push(msg);

        log(`Syncing all VMs from node ${node}`);

        const auth = await resolveAuth(context.globalArgs, context, authOpts());
        const { ticket, csrfToken } = auth;

        const listUrl = `${apiUrl}/api2/json/nodes/${node}/qemu`;
        const listResponse = await fetchWithCurl(listUrl, {
          method: "GET",
          headers: {
            "Cookie": `PVEAuthCookie=${ticket}`,
            "CSRFPreventionToken": csrfToken,
          },
          skipTlsVerify: skipTlsVerify ?? true,
        });

        if (!listResponse.ok) {
          throw new Error(`Failed to list VMs: ${listResponse.status} ${await listResponse.text()}`);
        }

        const rawVms = (await listResponse.json()).data;
        log(`Found ${rawVms.length} VMs, resolving IPs for running VMs`);

        const handles = [];
        for (const rv of rawVms) {
          let ip = null;
          if (rv.status === "running") {
            ip = await getVmIpWithRetry(apiUrl, node, rv.vmid, ticket, csrfToken, skipTlsVerify, 5, 2);
          }
          const vmName = rv.name || `vm-${rv.vmid}`;
          log(`  ${vmName} (vmid ${rv.vmid}) [${rv.status}]${ip ? ` ip=${ip}` : ""}${rv.maxmem ? ` mem=${Math.round(rv.maxmem/1024**3)}GB` : ""}`);
          const handle = await context.writeResource("vm", vmName, {
            vmid: rv.vmid, vmName, status: rv.status, ip,
            maxmem: rv.maxmem,
            maxcpu: rv.maxcpu,
            logs: logs.join("\n"),
            timestamp: new Date().toISOString(),
          });
          handles.push(handle);
        }

        log(`Complete: ${handles.length} VMs synced`);
        return { dataHandles: handles };
      },
    },

  },
};
