#!/bin/sh
# post-fleet-report.sh — Post fleet report to Discord #clankers using the bot token.
# Runs hourly via cron on slate in the discord-bot Docker container.
# Requires: curl, jq
set -e

REPORT_FILE="${REPORT_FILE:-/tmp/fleet-report.md}"
ENV_FILE="${ENV_FILE:-/opt/proxmox-manager/bot/.env}"

# Read bot token from .env
TOKEN=$(grep '^DISCORD_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
if [ -z "$TOKEN" ]; then
  echo "[post-fleet-report] DISCORD_TOKEN not found in $ENV_FILE"
  exit 1
fi

if [ ! -f "$REPORT_FILE" ]; then
  echo "[post-fleet-report] Report not found at $REPORT_FILE"
  exit 1
fi

# Discover guild ID (first guild the bot is in)
echo "[post-fleet-report] Discovering guild..."
GUILD_ID=$(curl -sf -H "Authorization: Bot $TOKEN" "https://discord.com/api/v10/users/@me/guilds" | jq -r '.[0].id')
if [ -z "$GUILD_ID" ] || [ "$GUILD_ID" = "null" ]; then
  echo "[post-fleet-report] Failed to discover guild ID"
  exit 1
fi
echo "[post-fleet-report] Guild: $GUILD_ID"

# Find #clankers channel
echo "[post-fleet-report] Finding #clankers channel..."
CHANNEL_ID=$(curl -sf -H "Authorization: Bot $TOKEN" "https://discord.com/api/v10/guilds/$GUILD_ID/channels" | jq -r '.[] | select(.name == "clankers") | .id')
if [ -z "$CHANNEL_ID" ] || [ "$CHANNEL_ID" = "null" ]; then
  echo "[post-fleet-report] #clankers channel not found in guild $GUILD_ID"
  exit 1
fi
echo "[post-fleet-report] Channel: $CHANNEL_ID"

# Post the report as a file attachment
echo "[post-fleet-report] Posting fleet report to #clankers..."
RESPONSE=$(curl -sf -X POST "https://discord.com/api/v10/channels/$CHANNEL_ID/messages" \
  -H "Authorization: Bot $TOKEN" \
  -F "payload_json={\"content\":\"**Hourly Fleet Report**\"}" \
  -F "files[0]=@$REPORT_FILE")

MSG_ID=$(echo "$RESPONSE" | jq -r '.id // empty')
if [ -n "$MSG_ID" ]; then
  echo "[post-fleet-report] Posted message $MSG_ID"
else
  echo "[post-fleet-report] Failed to post: $RESPONSE"
  exit 1
fi
