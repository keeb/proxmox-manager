import { EmbedBuilder } from "discord.js";

const COLOR_PENDING = 0xffcc00; // yellow
const COLOR_SUCCESS = 0x00cc66; // green
const COLOR_ERROR = 0xcc0000; // red

export interface WorkflowStep {
  name: string;
  description: string;
  methodName: string;
  modelName: string;
}

type StepStatus = "pending" | "in_progress" | "done" | "failed";

function actionVerb(action: string, tense: "past" | "present"): string {
  const verbs: Record<string, [string, string]> = {
    reboot: ["Rebooted", "Rebooting"],
    start: ["Started", "Starting"],
    stop: ["Stopped", "Stopping"],
    update: ["Updated", "Updating"],
    status: ["Checked", "Checking"],
  };
  const [past, present] = verbs[action] ?? [action, action];
  return tense === "past" ? past : present;
}

export function workflowStepsEmbed(
  action: string,
  vmName: string,
  steps: WorkflowStep[],
  statuses: StepStatus[],
  errorDetail?: string,
): EmbedBuilder {
  const allDone = statuses.every(s => s === "done");
  const hasFailed = statuses.some(s => s === "failed");

  const title = allDone ? `${actionVerb(action, "past")} ${vmName}` :
                hasFailed ? `Failed to ${action} ${vmName}` :
                `${actionVerb(action, "present")} ${vmName}...`;

  const color = allDone ? COLOR_SUCCESS :
                hasFailed ? COLOR_ERROR :
                COLOR_PENDING;

  const icons: Record<StepStatus, string> = {
    pending: "\u2b1c",
    in_progress: "\ud83d\udd04",
    done: "\u2705",
    failed: "\u274c",
  };

  const lines = steps.map((step, i) => {
    const icon = icons[statuses[i]];
    const suffix = statuses[i] === "in_progress" ? "..." : "";
    return `${icon} ${step.description}${suffix}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines.join("\n"))
    .setColor(color)
    .setTimestamp();

  if (hasFailed && errorDetail) {
    embed.addFields({ name: "Error", value: `\`\`\`\n${errorDetail.slice(0, 1000)}\n\`\`\`` });
  }

  return embed;
}

export function pendingEmbed(action: string, vmName: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${actionVerb(action, "present")} ${vmName}...`)
    .setColor(COLOR_PENDING)
    .setTimestamp();
}

export function successEmbed(action: string, vmName: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${actionVerb(action, "past")} ${vmName}`)
    .setColor(COLOR_SUCCESS)
    .setTimestamp();
}

export function errorEmbed(action: string, vmName: string, error: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`Failed to ${action} ${vmName}`)
    .setDescription(`\`\`\`\n${error.slice(0, 1000)}\n\`\`\``)
    .setColor(COLOR_ERROR)
    .setTimestamp();
}

export function accessDeniedEmbed(roleName: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Access Denied")
    .setDescription(`You need the **${roleName}** role to use this command.`)
    .setColor(COLOR_ERROR)
    .setTimestamp();
}

interface VmInfo {
  vmid: number;
  name?: string;
  status: string;
}

export function vmListEmbed(vms: VmInfo[]): EmbedBuilder {
  const sorted = [...vms].sort((a, b) => a.vmid - b.vmid);
  const lines = sorted.map((vm) => {
    const name = vm.name || "(unnamed)";
    return `\`${vm.vmid}\` **${name}** — ${vm.status}`;
  });

  return new EmbedBuilder()
    .setTitle("Proxmox VMs")
    .setDescription(lines.join("\n") || "No VMs found")
    .setColor(0x3366cc)
    .setTimestamp();
}

export function statusEmbed(vmName: string, data: { serverRunning: boolean; online?: number | null; max?: number | null; players?: string[] }): EmbedBuilder {
  if (!data.serverRunning) {
    return new EmbedBuilder()
      .setTitle(`${vmName} — Offline`)
      .setDescription("Server is not running.")
      .setColor(COLOR_ERROR)
      .setTimestamp();
  }

  if (data.online == null) {
    return new EmbedBuilder()
      .setTitle(`${vmName} — Online`)
      .setDescription("Server is running but could not retrieve player info.")
      .setColor(COLOR_PENDING)
      .setTimestamp();
  }

  const playerList = data.players && data.players.length > 0
    ? data.players.join(", ")
    : "No players online";

  return new EmbedBuilder()
    .setTitle(`${vmName} — Online`)
    .setDescription(`**Players:** ${data.online} / ${data.max}\n${playerList}`)
    .setColor(COLOR_SUCCESS)
    .setTimestamp();
}

export function helpEmbed(prefix: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Proxmox Bot Commands")
    .setDescription([
      `\`${prefix}start <vm>\` — Start a VM`,
      `\`${prefix}stop <vm>\` — Stop a VM`,
      `\`${prefix}reboot <vm>\` — Reboot a VM (stop + start)`,
      `\`${prefix}update <vm>\` — Update a service (pull + restart)`,
      `\`${prefix}status <vm>\` — Show server status and players`,
      `\`${prefix}list\` — List all VMs`,
      `\`${prefix}help\` — Show this message`,
    ].join("\n"))
    .setColor(0x3366cc)
    .setTimestamp();
}
