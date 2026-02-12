import { Client, GatewayIntentBits } from "discord.js";
import { config } from "./config.ts";
import { handleMessage } from "./commands.ts";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`);
  console.log(`Prefix: ${config.commandPrefix}`);
  console.log(`Required role: ${config.requiredRole}`);
});

client.on("messageCreate", (message) => {
  handleMessage(message).catch((err) => {
    console.error("Error handling message:", err);
  });
});

client.login(config.discordToken);
