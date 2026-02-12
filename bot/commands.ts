import { Message } from "discord.js";
import { config } from "./config.ts";
import { hasRequiredRole } from "./access.ts";
import {
  pendingEmbed,
  successEmbed,
  errorEmbed,
  accessDeniedEmbed,
  vmListEmbed,
  helpEmbed,
  statusEmbed,
  workflowStepsEmbed,
  type WorkflowStep,
} from "./formatting.ts";

const VALID_ACTIONS = ["start", "stop", "reboot", "update", "status"] as const;

// Whitelist of VM names that have workflows.
// Add entries here when you create new start-<name>/stop-<name>/reboot-<name> workflows.
const ALLOWED_VMS = new Set(["allthemons", "calamity"]);

const VM_SUPPORTED_ACTIONS: Record<string, Set<string>> = {
  allthemons: new Set(["start", "stop", "reboot", "status"]),
  calamity: new Set(["start", "stop", "reboot", "update", "status"]),
};

const REPO_DIR = new URL("../swamp/", import.meta.url).pathname;

async function getWorkflowSteps(workflowName: string): Promise<WorkflowStep[] | null> {
  const cmd = new Deno.Command("swamp", {
    args: ["workflow", "get", workflowName, "--json"],
    cwd: REPO_DIR,
    stdout: "piped",
    stderr: "piped",
  });

  const result = await cmd.output();
  if (result.code !== 0) return null;

  const stdout = new TextDecoder().decode(result.stdout);
  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) return null;

  const data = JSON.parse(stdout.slice(jsonStart));
  const steps: WorkflowStep[] = [];
  for (const job of data.jobs ?? []) {
    for (const step of job.steps ?? []) {
      steps.push({
        name: step.name,
        description: step.description || step.name,
        methodName: step.task?.methodName ?? "",
        modelName: step.task?.modelIdOrName ?? "",
      });
    }
  }
  return steps.length > 0 ? steps : null;
}

interface WorkflowRunResult {
  ok: boolean;
  output: string;
  failedStep?: string;
}

// Run a workflow, updating statuses in-place and awaiting onUpdate after each
// stdout chunk that changes a status. This serializes Discord edits with IO.
async function runWorkflowStreaming(
  workflowName: string,
  stepNameToIdx: Map<string, number>,
  statuses: ("pending" | "in_progress" | "done" | "failed")[],
  onUpdate: () => Promise<void>,
): Promise<WorkflowRunResult> {
  const cmd = new Deno.Command("swamp", {
    args: ["workflow", "run", workflowName],
    cwd: REPO_DIR,
    stdout: "piped",
    stderr: "piped",
  });

  const process = cmd.spawn();

  const reader = process.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullOutput = "";
  let failedStep: string | undefined;

  const stepStarted = /·([^·\s]+)\s+Step started$/;
  const stepCompleted = /·([^·\s]+)\s+Step completed$/;
  const stepFailed = /·([^·\s]+)\s+Step failed/;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    fullOutput += chunk;
    buffer += chunk;

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

      let match = line.match(stepStarted);
      if (match) {
        const idx = stepNameToIdx.get(match[1]);
        if (idx !== undefined) { statuses[idx] = "in_progress"; await onUpdate(); }
        continue;
      }
      match = line.match(stepCompleted);
      if (match) {
        const idx = stepNameToIdx.get(match[1]);
        if (idx !== undefined) { statuses[idx] = "done"; await onUpdate(); }
        continue;
      }
      match = line.match(stepFailed);
      if (match) {
        const idx = stepNameToIdx.get(match[1]);
        if (idx !== undefined) { statuses[idx] = "failed"; await onUpdate(); }
        failedStep = match[1];
      }
    }
  }

  const stderrReader = process.stderr.getReader();
  let stderr = "";
  while (true) {
    const { done, value } = await stderrReader.read();
    if (done) break;
    stderr += new TextDecoder().decode(value, { stream: true });
  }
  const { code } = await process.status;

  return {
    ok: code === 0,
    output: stderr || fullOutput,
    failedStep,
  };
}

async function runSyncFleet(): Promise<{ ok: boolean; error?: string }> {
  const cmd = new Deno.Command("swamp", {
    args: ["workflow", "run", "sync-fleet"],
    cwd: REPO_DIR,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  if (result.code !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    const stdout = new TextDecoder().decode(result.stdout);
    return { ok: false, error: stderr || stdout };
  }
  return { ok: true };
}

async function getFleetVmData(): Promise<{ ok: boolean; vms: any[]; error?: string }> {
  const vms = [];
  for (const vmName of ALLOWED_VMS) {
    const cmd = new Deno.Command("swamp", {
      args: ["data", "get", "fleet", vmName, "--json"],
      cwd: REPO_DIR,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    if (result.code !== 0) continue;
    const stdout = new TextDecoder().decode(result.stdout);
    const jsonStart = stdout.indexOf("{");
    if (jsonStart < 0) continue;
    const data = JSON.parse(stdout.slice(jsonStart));
    const content = data.content;
    if (content) {
      vms.push({
        vmid: content.vmid,
        name: content.vmName,
        status: content.status,
      });
    }
  }
  return { ok: vms.length > 0, vms };
}

async function runSwampModelMethod(modelName: string, methodName: string): Promise<{ ok: boolean; output: string }> {
  const cmd = new Deno.Command("swamp", {
    args: ["model", "method", "run", modelName, methodName, "--json"],
    cwd: REPO_DIR,
    stdout: "piped",
    stderr: "piped",
  });

  const result = await cmd.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);

  const ok = result.code === 0;
  console.log(`[model-method] ${modelName}.${methodName}: ${ok ? "success" : `failed (exit ${result.code})`}`);
  return {
    ok,
    output: ok ? stdout : stderr || stdout,
  };
}

export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!message.content.startsWith(config.commandPrefix)) return;

  // Only respond in #clankers
  const channelName = (message.channel as any).name;
  if (channelName && channelName !== "clankers") return;

  console.log(`[cmd] ${message.author.tag} in #${message.channel.isTextBased() ? (message.channel as any).name ?? "DM" : "DM"}: ${message.content}`);

  const parts = message.content.slice(config.commandPrefix.length).trim().split(/\s+/);
  const command = parts[0]?.toLowerCase();
  const vmName = parts[1]?.toLowerCase();

  if (command === "help") {
    await message.reply({ embeds: [helpEmbed(config.commandPrefix)] });
    return;
  }

  if (command === "list") {
    if (!hasRequiredRole(message.member, config.requiredRole)) {
      await message.reply({ embeds: [accessDeniedEmbed(config.requiredRole)] });
      return;
    }

    const reply = await message.reply({ embeds: [pendingEmbed("list", "VMs")] });

    const sync = await runSyncFleet();
    if (!sync.ok) {
      await reply.edit({ embeds: [errorEmbed("list", "VMs", sync.error || "Failed to sync fleet")] });
      return;
    }

    const { ok, vms } = await getFleetVmData();
    if (ok) {
      await reply.edit({ embeds: [vmListEmbed(vms)] });
    } else {
      await reply.edit({ embeds: [errorEmbed("list", "VMs", "No fleet data found")] });
    }
    return;
  }

  if (VALID_ACTIONS.includes(command as typeof VALID_ACTIONS[number])) {
    if (!vmName) {
      await message.reply(`Usage: \`${config.commandPrefix}${command} <vm-name>\``);
      return;
    }

    if (!hasRequiredRole(message.member, config.requiredRole)) {
      await message.reply({ embeds: [accessDeniedEmbed(config.requiredRole)] });
      return;
    }

    if (!ALLOWED_VMS.has(vmName)) {
      await message.reply(`Unknown VM: **${vmName}**. Available: ${[...ALLOWED_VMS].join(", ")}`);
      return;
    }

    const supported = VM_SUPPORTED_ACTIONS[vmName];
    if (supported && !supported.has(command)) {
      await message.reply(`**${vmName}** doesn't support \`${command}\`. Available: ${[...supported].join(", ")}`);
      return;
    }

    // Status is a direct model method call — CEL resolves from cached data on disk.
    const VM_STATUS_MODEL: Record<string, string> = {
      allthemons: "allthemonsMinecraft",
      calamity: "calamityTerraria",
    };

    if (command === "status") {
      const statusModel = VM_STATUS_MODEL[vmName];
      if (!statusModel) {
        await message.reply(`No status model configured for **${vmName}**.`);
        return;
      }
      const reply = await message.reply({ embeds: [pendingEmbed("status", vmName)] });
      const result = await runSwampModelMethod(statusModel, "status");

      if (result.ok) {
        try {
          const jsonStart = result.output.lastIndexOf("\n{");
          const jsonStr = jsonStart >= 0 ? result.output.slice(jsonStart + 1) : result.output;
          const data = JSON.parse(jsonStr);
          const attrs = data?.logs?.[0]?.attributes ?? data?.data?.attributes ?? data;
          await reply.edit({ embeds: [statusEmbed(vmName, attrs)] });
        } catch {
          await reply.edit({ embeds: [errorEmbed("status", vmName, "Failed to parse status response")] });
        }
      } else {
        await reply.edit({ embeds: [errorEmbed("status", vmName, result.output)] });
      }
      return;
    }

    const workflowNames = [`${command}-${vmName}`];

    // Pre-fetch steps from all workflows
    const allSteps: WorkflowStep[] = [];
    const workflowStepRanges: { name: string; offset: number; count: number }[] = [];
    for (const wfName of workflowNames) {
      const steps = await getWorkflowSteps(wfName);
      if (steps) {
        workflowStepRanges.push({ name: wfName, offset: allSteps.length, count: steps.length });
        allSteps.push(...steps);
      }
    }

    if (allSteps.length > 0) {
      const statuses: ("pending" | "in_progress" | "done" | "failed")[] = allSteps.map(() => "pending");
      const reply = await message.reply({ embeds: [workflowStepsEmbed(command, vmName, allSteps, statuses)] });

      // Build step name -> index map (scoped per workflow to handle duplicates)
      let failed = false;

      for (const wf of workflowStepRanges) {
        const stepNameToIdx = new Map<string, number>();
        for (let i = 0; i < wf.count; i++) {
          stepNameToIdx.set(allSteps[wf.offset + i].name, wf.offset + i);
        }

        const result = await runWorkflowStreaming(
          wf.name,
          stepNameToIdx,
          statuses,
          async () => {
            await reply.edit({ embeds: [workflowStepsEmbed(command, vmName, allSteps, statuses)] }).catch(() => {});
          },
        );

        if (!result.ok) {
          const errorDetail = result.output.slice(-1000);
          await reply.edit({ embeds: [workflowStepsEmbed(command, vmName, allSteps, statuses, errorDetail)] });
          failed = true;
          break;
        }
      }

      if (!failed) {
        // Ensure all steps show as done
        for (let i = 0; i < allSteps.length; i++) {
          if (statuses[i] !== "done") statuses[i] = "done";
        }
        await reply.edit({ embeds: [workflowStepsEmbed(command, vmName, allSteps, statuses)] });
      }
    } else {
      // No workflow steps found — simple pending/success/error fallback
      const workflowName = workflowNames[0];
      const reply = await message.reply({ embeds: [pendingEmbed(command, vmName)] });

      const cmd = new Deno.Command("swamp", {
        args: ["workflow", "run", workflowName],
        cwd: REPO_DIR,
        stdout: "piped",
        stderr: "piped",
      });
      const result = await cmd.output();
      const stderr = new TextDecoder().decode(result.stderr);
      const stdout = new TextDecoder().decode(result.stdout);

      if (result.code === 0) {
        await reply.edit({ embeds: [successEmbed(command, vmName)] });
      } else {
        await reply.edit({ embeds: [errorEmbed(command, vmName, stderr || stdout)] });
      }
    }
    return;
  }
}
