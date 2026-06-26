import { z } from "npm:zod@4";

const GlobalArgs = z.object({});

const BatchSchema = z.object({
  items: z.array(z.string()),
  count: z.number(),
  timestamp: z.string(),
});

export const model = {
  type: "@keeb/telemetry/burst",
  version: "2026.06.12.1",
  resources: {
    "batch": {
      description: "Seeded iteration list consumed by the event-burst-fanout forEach",
      schema: BatchSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  globalArguments: GlobalArgs,
  methods: {
    seed: {
      description: "Write a batch resource with `count` iteration items for the fanout forEach",
      arguments: z.object({
        count: z.union([z.number(), z.string()]).default("").describe("Number of items to seed (positive integer, from workflow inputs)"),
      }),
      execute: async (args, context) => {
        const count = typeof args.count === "number" ? args.count : parseInt(args.count, 10);
        if (!Number.isFinite(count) || count < 1) throw new Error("count is required — pass a positive integer");
        const items = Array.from({ length: count }, (_, i) => String(i + 1));
        const handle = await context.writeResource("batch", "current", {
          items,
          count,
          timestamp: new Date().toISOString(),
        });
        console.log(`[telemetry/burst] seeded ${count} items`);
        return { dataHandles: [handle] };
      },
    },
    tick: {
      description: "No-op. Exists so each forEach iteration is one model-method invocation (one telemetry entry) with zero work",
      arguments: z.object({}),
      execute: async () => {
        return { dataHandles: [] };
      },
    },
  },
};
