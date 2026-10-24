/**
 * Extends `@keeb/proxmox/vm` with `sendKeys` — types a Packer-style boot
 * command into a VM's console via the Proxmox `sendkey` API. Used to drive an
 * installer ISO's boot menu (e.g. Debian's `auto url=…` preseed boot) without
 * a human at the console.
 */
import { z } from "npm:zod@4";

const SendKeysArgs = z.object({
  vmName: z.string().describe("VM name to type into"),
  keys: z.string().describe(
    "Boot command. Literal text is typed as-is; special tokens: <esc> <enter> <tab> <spacebar> <bs> <up> <down> <left> <right> <home> <end> <f10> <ctrlx> <wait> (1s) <waitN> (N seconds)",
  ),
  initialDelay: z.number().default(10).describe(
    "Seconds to wait before typing (lets the boot menu appear)",
  ),
  keyDelayMs: z.number().default(30).describe("Delay between keystrokes in ms"),
});

const SPECIAL_KEYS: Record<string, string> = {
  esc: "esc",
  enter: "ret",
  tab: "tab",
  spacebar: "spc",
  bs: "backspace",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  home: "home",
  end: "end",
  f10: "f10",
  ctrlx: "ctrl-x",
};

// Unshifted punctuation → qemu key name; shifted punctuation maps to
// "shift-<base>".
const PUNCT: Record<string, string> = {
  " ": "spc",
  ".": "dot",
  "/": "slash",
  "-": "minus",
  "=": "equal",
  ",": "comma",
  ";": "semicolon",
  "'": "apostrophe",
  "\\": "backslash",
  "[": "bracket_left",
  "]": "bracket_right",
  "`": "grave_accent",
};
const SHIFTED: Record<string, string> = {
  ":": "shift-semicolon",
  "_": "shift-minus",
  "+": "shift-equal",
  "?": "shift-slash",
  '"': "shift-apostrophe",
  "~": "shift-grave_accent",
  "!": "shift-1",
  "@": "shift-2",
  "#": "shift-3",
  "$": "shift-4",
  "%": "shift-5",
  "^": "shift-6",
  "&": "shift-7",
  "*": "shift-8",
  "(": "shift-9",
  ")": "shift-0",
  "<": "shift-comma",
  ">": "shift-dot",
  "|": "shift-backslash",
  "{": "shift-bracket_left",
  "}": "shift-bracket_right",
};

type Action = { key: string } | { waitSeconds: number };

/** Parse a boot command into keystrokes and waits. Pure. */
export function parseKeys(keys: string): Action[] {
  const actions: Action[] = [];
  const re = /<(\w+)>/y;
  let i = 0;
  while (i < keys.length) {
    re.lastIndex = i;
    const m = re.exec(keys);
    if (m) {
      const token = m[1];
      const wait = token.match(/^wait(\d*)$/);
      if (wait) {
        actions.push({ waitSeconds: wait[1] ? parseInt(wait[1], 10) : 1 });
        i = re.lastIndex;
        continue;
      }
      if (SPECIAL_KEYS[token]) {
        actions.push({ key: SPECIAL_KEYS[token] });
        i = re.lastIndex;
        continue;
      }
    }
    const ch = keys[i];
    if (/[a-z0-9]/.test(ch)) actions.push({ key: ch });
    else if (/[A-Z]/.test(ch)) actions.push({ key: `shift-${ch.toLowerCase()}` });
    else if (PUNCT[ch]) actions.push({ key: PUNCT[ch] });
    else if (SHIFTED[ch]) actions.push({ key: SHIFTED[ch] });
    else throw new Error(`No qemu key mapping for character ${JSON.stringify(ch)}`);
    i++;
  }
  return actions;
}

async function curl(
  url: string,
  method: string,
  ticket: string,
  csrfToken: string,
  body?: string,
) {
  const args = [
    "-s",
    "-S",
    "-k",
    "-X",
    method,
    "-H",
    `Cookie: PVEAuthCookie=${ticket}`,
    "-H",
    `CSRFPreventionToken: ${csrfToken}`,
    "-w",
    "\n%{http_code}",
  ];
  if (body) args.push("-d", body);
  args.push(url);
  // @ts-ignore - Deno API
  const { code, stdout, stderr } = await new Deno.Command("curl", { args })
    .output();
  if (code !== 0) {
    throw new Error(`curl failed: ${new TextDecoder().decode(stderr)}`);
  }
  const out = new TextDecoder().decode(stdout);
  const idx = out.lastIndexOf("\n");
  const status = parseInt(out.slice(idx + 1), 10);
  return { ok: status >= 200 && status < 300, status, body: out.slice(0, idx) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// deno-lint-ignore no-explicit-any
async function resolveVm(globalArgs: any, vmName: string) {
  const { apiUrl, node, ticket, csrfToken } = globalArgs;
  if (!ticket || !csrfToken) {
    throw new Error("No Proxmox ticket — run keebDev02.auth first");
  }
  const list = await curl(
    `${apiUrl}/api2/json/nodes/${node}/qemu`,
    "GET",
    ticket,
    csrfToken,
  );
  if (!list.ok) {
    throw new Error(`Failed to list VMs: ${list.status} ${list.body}`);
  }
  // deno-lint-ignore no-explicit-any
  const vm = JSON.parse(list.body).data.find((v: any) => v.name === vmName);
  if (!vm) throw new Error(`VM "${vmName}" not found`);
  return vm;
}

// Console/inspection results get their own spec: writing partial `vm`
// records (no ip) would shadow data.latest("fleet", vm).attributes.ip.
const VmConsoleSchema = z.object({
  vmid: z.number(),
  vmName: z.string(),
  status: z.string().optional(),
  success: z.boolean().optional(),
  config: z.record(z.string(), z.string()).optional(),
  logs: z.string().optional(),
  timestamp: z.string(),
});

export const extension = {
  type: "@keeb/proxmox/vm",
  resources: {
    "vmconsole": {
      description: "Console / monitor / config inspection result for a VM",
      schema: VmConsoleSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: [
    {
      monitor: {
        description:
          "Run a QEMU human-monitor command on the VM (e.g. 'info blockstats', 'info status') and record its output",
        arguments: z.object({
          vmName: z.string().describe("VM name"),
          command: z.string().describe("HMP command, e.g. 'info blockstats'"),
        }),
        // deno-lint-ignore no-explicit-any
        execute: async (args: any, context: any) => {
          const { apiUrl, node, ticket, csrfToken } = context.globalArgs;
          const vm = await resolveVm(context.globalArgs, args.vmName);
          const res = await curl(
            `${apiUrl}/api2/json/nodes/${node}/qemu/${vm.vmid}/monitor`,
            "POST",
            ticket,
            csrfToken,
            new URLSearchParams({ command: args.command }).toString(),
          );
          if (!res.ok) {
            throw new Error(`monitor failed: ${res.status} ${res.body}`);
          }
          const output = String(JSON.parse(res.body).data ?? "");
          console.log(output);
          const handle = await context.writeResource("vmconsole", vm.name, {
            vmid: vm.vmid,
            vmName: vm.name,
            status: vm.status,
            logs: `$ ${args.command}\n${output}`,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        },
      },
    },
    {
      getConfig: {
        description:
          "Read the VM's current Proxmox config (boot order, disks, cdrom, …) into the vm resource",
        arguments: z.object({
          vmName: z.string().describe("VM name to read"),
        }),
        // deno-lint-ignore no-explicit-any
        execute: async (args: any, context: any) => {
          const { apiUrl, node, ticket, csrfToken } = context.globalArgs;
          const vm = await resolveVm(context.globalArgs, args.vmName);
          const res = await curl(
            `${apiUrl}/api2/json/nodes/${node}/qemu/${vm.vmid}/config`,
            "GET",
            ticket,
            csrfToken,
          );
          if (!res.ok) {
            throw new Error(`Failed to read config: ${res.status} ${res.body}`);
          }
          const config = Object.fromEntries(
            Object.entries(JSON.parse(res.body).data).map((
              [k, v],
            ) => [k, String(v)]),
          );
          console.log(JSON.stringify(config, null, 2));
          const handle = await context.writeResource("vmconsole", vm.name, {
            vmid: vm.vmid,
            vmName: vm.name,
            status: vm.status,
            config,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        },
      },
    },
    {
      sendKeys: {
        description:
          "Type a boot command into the VM console via the Proxmox sendkey API (Packer-style <esc>/<enter>/<waitN> tokens)",
        arguments: SendKeysArgs,
        // deno-lint-ignore no-explicit-any
        execute: async (args: any, context: any) => {
          const { vmName, keys, initialDelay = 10, keyDelayMs = 30 } = args;
          const { apiUrl, node, ticket, csrfToken } = context.globalArgs;
          if (!ticket || !csrfToken) {
            throw new Error("No Proxmox ticket — run keebDev02.auth first");
          }
          const logs: string[] = [];
          const log = (msg: string) => {
            logs.push(msg);
            console.log(msg);
          };

          const actions = parseKeys(keys);

          const list = await curl(
            `${apiUrl}/api2/json/nodes/${node}/qemu`,
            "GET",
            ticket,
            csrfToken,
          );
          if (!list.ok) {
            throw new Error(`Failed to list VMs: ${list.status} ${list.body}`);
          }
          // deno-lint-ignore no-explicit-any
          const vm = JSON.parse(list.body).data.find((v: any) =>
            v.name === vmName
          );
          if (!vm) throw new Error(`VM "${vmName}" not found`);
          if (vm.status !== "running") {
            throw new Error(`VM "${vmName}" (vmid ${vm.vmid}) is ${vm.status}`);
          }
          log(`Found VM "${vmName}" → vmid ${vm.vmid}`);

          log(`Waiting ${initialDelay}s for the boot menu`);
          await sleep(initialDelay * 1000);

          let sent = 0;
          for (const action of actions) {
            if ("waitSeconds" in action) {
              await sleep(action.waitSeconds * 1000);
              continue;
            }
            const res = await curl(
              `${apiUrl}/api2/json/nodes/${node}/qemu/${vm.vmid}/sendkey`,
              "PUT",
              ticket,
              csrfToken,
              new URLSearchParams({ key: action.key }).toString(),
            );
            if (!res.ok) {
              throw new Error(
                `sendkey ${action.key} failed: ${res.status} ${res.body}`,
              );
            }
            sent++;
            await sleep(keyDelayMs);
          }
          log(`Sent ${sent} keystrokes to vmid ${vm.vmid}`);

          const handle = await context.writeResource("vmconsole", vmName, {
            vmid: vm.vmid,
            vmName,
            status: vm.status,
            success: true,
            logs: logs.join("\n"),
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
