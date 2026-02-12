import { load } from "jsr:@std/dotenv";
await load({ export: true });

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    Deno.exit(1);
  }
  return value;
}

export const config = {
  discordToken: requireEnv("DISCORD_TOKEN"),
  requiredRole: Deno.env.get("REQUIRED_ROLE") || "proxmox-admin",
  commandPrefix: Deno.env.get("COMMAND_PREFIX") || "!",
};
