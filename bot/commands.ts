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

const VALID_ACTIONS = ["start", "stop", "reboot", "update", "status", "op", "deop"] as const;

const GAME_TYPE_ACTIONS: Record<string, string[]> = {
  minecraft: ["start", "stop", "reboot", "status", "op", "deop"],
  terraria: ["start", "stop", "reboot", "update", "status"],
};

const MODEL_TYPE_TO_GAME: Record<string, string> = {
  "@user/minecraft/server": "minecraft",
  "@user/terraria/server": "terraria",
};

interface DiscoveredVm {
  vmName: string;
  gameType: string;
  modelName: string;
  supportedActions: Set<string>;
  serverConfig: Record<string, string>;
}

const vmRegistry = new Map<string, DiscoveredVm>();

const PLAYER_NAME_ACTIONS = new Set(["op", "deop"]);

const REPO_DIR = Deno.env.get("SWAMP_REPO_DIR") || new URL("../swamp/", import.meta.url).pathname;

async function discoverGameServers(): Promise<void> {
  vmRegistry.clear();
  const cmd = new Deno.Command("swamp", {
    args: ["model", "search", "server", "--json"],
    cwd: REPO_DIR,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  if (result.code !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    console.error(`[discovery] Failed to search models: ${stderr}`);
    return;
  }

  const stdout = new TextDecoder().decode(result.stdout);
  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) {
    console.error("[discovery] No JSON in model search output");
    return;
  }

  const parsed = JSON.parse(stdout.slice(jsonStart));
  const models = parsed.results ?? parsed;

  for (const m of models) {
    const gameType = MODEL_TYPE_TO_GAME[m.type];
    if (!gameType) continue;

    // Get full definition to read globalArguments.serverName
    const getCmd = new Deno.Command("swamp", {
      args: ["model", "get", m.name, "--json"],
      cwd: REPO_DIR,
      stdout: "piped",
      stderr: "piped",
    });
    const getResult = await getCmd.output();
    if (getResult.code !== 0) continue;

    const getStdout = new TextDecoder().decode(getResult.stdout);
    const getJsonStart = getStdout.indexOf("{");
    if (getJsonStart < 0) continue;

    const def = JSON.parse(getStdout.slice(getJsonStart));
    const serverName = def.globalArguments?.serverName;
    if (!serverName || serverName.includes("${{")) continue;

    const actions = GAME_TYPE_ACTIONS[gameType];
    if (!actions) continue;

    const ga = def.globalArguments || {};
    const serverConfig: Record<string, string> = {};
    for (const key of ["tmuxSession", "serverDir", "startScript", "logPath"]) {
      const val = ga[key];
      if (val && !String(val).includes("${{")) {
        serverConfig[key] = String(val);
      }
    }

    vmRegistry.set(serverName, {
      vmName: serverName,
      gameType,
      modelName: m.name,
      supportedActions: new Set(actions),
      serverConfig,
    });
  }

  console.log(`[discovery] Found ${vmRegistry.size} server(s): ${[...vmRegistry.keys()].join(", ")}`);
}

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
  inputs?: Record<string, string>,
): Promise<WorkflowRunResult> {
  const inputArgs = inputs
    ? Object.entries(inputs).flatMap(([k, v]) => ["--input", `${k}=${v}`])
    : [];
  const cmd = new Deno.Command("swamp", {
    args: ["workflow", "run", workflowName, ...inputArgs],
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
  for (const vmName of vmRegistry.keys()) {
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

async function runSwampModelMethod(modelName: string, methodName: string, inputs?: Record<string, string>): Promise<{ ok: boolean; output: string }> {
  const inputArgs = inputs
    ? ["--input", JSON.stringify(inputs)]
    : [];
  const cmd = new Deno.Command("swamp", {
    args: ["model", "method", "run", modelName, methodName, "--json", ...inputArgs],
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

  await discoverGameServers();

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

    const vm = vmRegistry.get(vmName);
    if (!vm) {
      await message.reply(`Unknown VM: **${vmName}**. Available: ${[...vmRegistry.keys()].join(", ")}`);
      return;
    }

    if (!vm.supportedActions.has(command)) {
      await message.reply(`**${vmName}** doesn't support \`${command}\`. Available: ${[...vm.supportedActions].join(", ")}`);
      return;
    }

    if (command === "status") {
      const reply = await message.reply({ embeds: [pendingEmbed("status", vmName)] });
      const result = await runSwampModelMethod(vm.modelName, "status");

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

    if (PLAYER_NAME_ACTIONS.has(command)) {
      const playerName = parts[2];
      if (!playerName) {
        await message.reply(`Usage: \`${config.commandPrefix}${command} <vm-name> <player-name>\``);
        return;
      }

      const sanitized = playerName.replace(/[^a-zA-Z0-9_]/g, "");
      if (!sanitized) {
        await message.reply(`Invalid player name. Only letters, numbers, and underscores are allowed.`);
        return;
      }

      const reply = await message.reply({ embeds: [pendingEmbed(command, `${vmName} ${sanitized}`)] });
      const result = await runSwampModelMethod(vm.modelName, command, { playerName: sanitized });

      if (result.ok) {
        await reply.edit({ embeds: [successEmbed(command, `${vmName} — ${sanitized}`)] });
      } else {
        await reply.edit({ embeds: [errorEmbed(command, `${vmName} ${sanitized}`, result.output)] });
      }
      return;
    }

    // Minecraft uses generic workflows with vmName input; others use per-server workflows
    let workflowName: string;
    let workflowInputs: Record<string, string> | undefined;
    if (vm.gameType === "minecraft") {
      workflowName = `${command}-minecraft`;
      workflowInputs = { vmName, ...vm.serverConfig };
    } else {
      workflowName = `${command}-${vmName}`;
    }

    // Pre-fetch steps from the workflow
    const allSteps: WorkflowStep[] = [];
    const workflowStepRanges: { name: string; offset: number; count: number }[] = [];
    const steps = await getWorkflowSteps(workflowName);
    if (steps) {
      workflowStepRanges.push({ name: workflowName, offset: 0, count: steps.length });
      allSteps.push(...steps);
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
          workflowInputs,
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
      const reply = await message.reply({ embeds: [pendingEmbed(command, vmName)] });

      const inputArgs = workflowInputs
        ? Object.entries(workflowInputs).flatMap(([k, v]) => ["--input", `${k}=${v}`])
        : [];
      const cmd = new Deno.Command("swamp", {
        args: ["workflow", "run", workflowName, ...inputArgs],
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
