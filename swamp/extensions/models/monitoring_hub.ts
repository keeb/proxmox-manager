import { z } from "npm:zod@4";
import { sshExec, sshExecRaw } from "./lib/ssh.ts";

const GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname/IP of the monitoring hub (hancock)"),
  sshUser: z.string().default("keeb").describe("SSH user (default 'keeb')"),
  targetsDir: z.string().describe("Path to Prometheus file_sd_configs targets directory"),
});

const DiscoverArgs = z.object({});

const RegisterArgs = z.object({
  vmName: z.string().describe("VM name to register as a Prometheus scrape target"),
  targetIp: z.string().describe("IP address of the target VM"),
});

const HubSchema = z.object({
  lokiPushUrl: z.string(),
  prometheusUrl: z.string(),
  sshHost: z.string(),
  targetsDir: z.string(),
  lokiReady: z.boolean(),
  prometheusReady: z.boolean(),
  timestamp: z.string(),
});

const TargetSchema = z.object({
  success: z.boolean(),
  targetFile: z.string(),
  targetIp: z.string(),
  timestamp: z.string(),
});

export const model = {
  type: "@user/monitoring/hub",
  version: "2026.02.17.1",
  resources: {
    "hub": {
      description: "Observability stack endpoints on hancock",
      schema: HubSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "target": {
      description: "Prometheus scrape target registration",
      schema: TargetSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  globalArguments: GlobalArgs,
  methods: {
    discover: {
      description: "Validate observability stack and write endpoint data",
      arguments: DiscoverArgs,
      execute: async (_args, context) => {
        const { sshHost, sshUser = "keeb", targetsDir } = context.globalArgs;

        console.log(`[discover] Checking observability stack on ${sshHost}`);

        // Check Loki readiness (exposed on host port 3100)
        console.log(`[discover] Checking Loki...`);
        const lokiResult = await sshExecRaw(sshHost, sshUser, `curl -sf http://localhost:3100/ready`);
        const lokiReady = lokiResult.stdout.trim().toLowerCase() === "ready";
        console.log(`[discover] Loki ready: ${lokiReady}`);

        // Check Prometheus readiness (not exposed on host, use docker exec)
        console.log(`[discover] Checking Prometheus...`);
        const promResult = await sshExecRaw(sshHost, sshUser, `docker exec prometheus wget -qO- http://localhost:9090/-/ready`);
        const prometheusReady = promResult.stdout.trim().includes("Ready");
        console.log(`[discover] Prometheus ready: ${prometheusReady}`);

        const lokiPushUrl = `http://${sshHost}:3100/loki/api/v1/push`;
        const prometheusUrl = `http://${sshHost}:9090`;

        console.log(`[discover] Loki push URL: ${lokiPushUrl}`);
        console.log(`[discover] Prometheus URL: ${prometheusUrl}`);

        const handle = await context.writeResource("hub", "hub", {
          lokiPushUrl,
          prometheusUrl,
          sshHost,
          targetsDir,
          lokiReady,
          prometheusReady,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    register: {
      description: "Register a VM as a Prometheus scrape target via file_sd_configs",
      arguments: RegisterArgs,
      execute: async (args, context) => {
        const { vmName, targetIp } = args;
        const { sshHost, sshUser = "keeb", targetsDir } = context.globalArgs;

        console.log(`[register] Registering ${vmName} (${targetIp}) as Prometheus target`);

        // Write file_sd_configs JSON target file
        const targetFile = `${targetsDir}/${vmName}.json`;
        const targetConfig = JSON.stringify([
          {
            targets: [`${targetIp}:9100`],
            labels: {
              instance: vmName,
              job: "node",
            },
          },
        ], null, 2);

        await sshExec(sshHost, sshUser, `cat > ${targetFile} << 'EOF'\n${targetConfig}\nEOF`);
        console.log(`[register] Wrote target file: ${targetFile}`);
        console.log(`[register] Prometheus will auto-discover within 15s`);

        const handle = await context.writeResource("target", vmName, {
          success: true,
          targetFile,
          targetIp,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
