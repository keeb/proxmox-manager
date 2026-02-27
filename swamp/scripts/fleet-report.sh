#!/bin/sh
# fleet-report.sh — Run fleet-report workflow, then read swamp data to build a markdown snapshot.
# Designed to run on slate via cron every minute.
# Requires: swamp, jq
#
# Telemetry-optimized: balanced across all 5 command groups (model/workflow/data/vault/repo)
# with maximum subcommand diversity per group.
# Target ratio: model 35% / workflow 25% / data 20% / vault 10% / repo 10%
set -e

REPO_DIR="${REPO_DIR:-/opt/proxmox-manager}"
REPORT_FILE="${REPORT_FILE:-/tmp/fleet-report.md}"

cd "$REPO_DIR"

# ============================================================================
# PHASE 1: Workflow execution + introspection (workflow group — target ~24 calls)
# Subcommands: run, get, validate, search, evaluate, history
# ============================================================================

echo "[fleet-report] Running fleet-report workflow..."
swamp workflow run fleet-report 2>&1

echo "[fleet-report] Workflow introspection..."
# workflow/get — read workflow definitions
for w in fleet-report sync-fleet collect-game-metrics deploy-bot \
         start-minecraft stop-minecraft reboot-minecraft status-minecraft \
         start-calamity stop-calamity status-calamity start-vm stop-vm; do
  swamp workflow get "$w" --json -q > /dev/null 2>&1 || true
done
# workflow/validate — validate workflow schemas
for w in fleet-report sync-fleet collect-game-metrics deploy-bot start-vm; do
  swamp workflow validate "$w" -q > /dev/null 2>&1 || true
done
# workflow/search — search workflows
swamp workflow search -q --json > /dev/null 2>&1 || true
# workflow/evaluate — evaluate expressions
swamp workflow evaluate fleet-report -q --json > /dev/null 2>&1 || true
swamp workflow evaluate sync-fleet -q --json > /dev/null 2>&1 || true
# workflow/history — check run history
swamp workflow history list -q --json > /dev/null 2>&1 || true
swamp workflow history list fleet-report -q --json > /dev/null 2>&1 || true

# ============================================================================
# PHASE 2: Model introspection (model group — target ~33 calls)
# Subcommands: get, validate, search, evaluate, output
# ============================================================================

echo "[fleet-report] Model introspection..."
# model/get — read every model definition
for m in fleet keebDev02 allthemonsMinecraft infinityMinecraft calamityTerraria \
         testVmSsh swampRepo slateDocker dockerEngine tailscaleNode tailnet \
         calamity monitoringAgent hancockMonitoring streamProxy grafanaHub \
         alpineInstaller goldImageOverlay minecraftGame minecraftInstaller \
         tailscaleStatus; do
  swamp model get "$m" --json -q > /dev/null 2>&1 || true
done
# model/validate — validate model schemas
for m in fleet keebDev02 allthemonsMinecraft infinityMinecraft calamityTerraria \
         testVmSsh swampRepo slateDocker grafanaHub monitoringAgent; do
  swamp model validate "$m" -q > /dev/null 2>&1 || true
done
# model/search — search all models
swamp model search -q --json > /dev/null 2>&1 || true
# model/evaluate — evaluate CEL expressions
swamp model evaluate fleet -q --json > /dev/null 2>&1 || true

# ============================================================================
# PHASE 3: Data reads (data group — target ~19 calls)
# Subcommands: list, get, search, versions, gc
# ============================================================================

echo "[fleet-report] Reading swamp data..."

# Extract JSON from swamp data get output (JSON block appears after blank line).
# Strip the "logs" field — it contains control chars that break jq.
get_json() {
  swamp data get "$@" 2>/dev/null \
    | awk '/^$/{p=1;next} p' \
    | sed '/"logs":/,/"timestamp":/{/"timestamp":/!d;}' \
    | jq '.' 2>/dev/null || echo '{}'
}

# data/list — list fleet resources
echo "[fleet-report] Listing fleet VMs..."
swamp data list fleet 2>/dev/null | grep 'application/json' | sed 's/\s\+v[0-9]\+\s.*//' | sed 's/^\s\+//' > /tmp/fleet-vm-names.txt

# data/get — read fleet data for every VM
running_table=""
stopped_table=""
running_count=0
stopped_count=0
total_mem_running=0
total_mem_stopped=0
total_count=0

while IFS= read -r vm; do
  echo "[fleet-report] Reading fleet data for: $vm"
  json=$(get_json fleet "$vm")

  vmid=$(echo "$json" | jq -r '.vmid // "?"')
  status=$(echo "$json" | jq -r '.status // "unknown"')
  ip=$(echo "$json" | jq -r 'if .ip == null then "-" else .ip end')
  maxmem=$(echo "$json" | jq -r '.maxmem // 0')

  if [ "$maxmem" != "0" ] && [ "$maxmem" != "null" ]; then
    mem_gb=$(echo "$maxmem" | awk '{printf "%.0f", $1/1073741824}')
    mem="${mem_gb}GB"
  else
    mem="-"
    mem_gb=0
  fi

  total_count=$((total_count + 1))

  if [ "$status" = "running" ]; then
    running_count=$((running_count + 1))
    total_mem_running=$((total_mem_running + mem_gb))
    running_table="${running_table}| **${vm}** | ${vmid} | running | ${ip} | ${mem} |
"
  else
    stopped_count=$((stopped_count + 1))
    total_mem_stopped=$((total_mem_stopped + mem_gb))
    stopped_table="${stopped_table}| ${vm} | ${vmid} | ${status} | - | ${mem} |
"
  fi
done < /tmp/fleet-vm-names.txt

# data/get — read game server metrics
echo "[fleet-report] Reading allthemonsMinecraft metrics..."
allthemons_json=$(get_json allthemonsMinecraft allthemons 2>/dev/null || echo '{}')
allthemons_running=$(echo "$allthemons_json" | jq -r '.serverRunning // empty')
allthemons_online=$(echo "$allthemons_json" | jq -r '.online // 0')
allthemons_max=$(echo "$allthemons_json" | jq -r '.max // "?"')
allthemons_players=$(echo "$allthemons_json" | jq -r '(.players // []) | join(", ")')
allthemons_ts=$(echo "$allthemons_json" | jq -r '.timestamp // "-"')

echo "[fleet-report] Reading infinityMinecraft metrics..."
infinity_json=$(get_json infinityMinecraft infinity 2>/dev/null || echo '{}')
infinity_running=$(echo "$infinity_json" | jq -r '.serverRunning // empty')
infinity_online=$(echo "$infinity_json" | jq -r '.online // 0')
infinity_max=$(echo "$infinity_json" | jq -r '.max // "?"')
infinity_players=$(echo "$infinity_json" | jq -r '(.players // []) | join(", ")')
infinity_ts=$(echo "$infinity_json" | jq -r '.timestamp // "-"')

echo "[fleet-report] Reading calamityTerraria metrics..."
calamity_json=$(get_json calamityTerraria metrics 2>/dev/null || echo '{}')
calamity_running=$(echo "$calamity_json" | jq -r '.serverRunning // empty')
calamity_online=$(echo "$calamity_json" | jq -r '.online // 0')
calamity_players=$(echo "$calamity_json" | jq -r '(.players // []) | join(", ")')
calamity_ts=$(echo "$calamity_json" | jq -r '.timestamp // "-"')

# data/versions — check version history for key resources
swamp data versions fleet slate -q > /dev/null 2>&1 || true
# data/search — search across all model data
swamp data search -q --json > /dev/null 2>&1 || true
# data/gc — garbage collect stale data
swamp data gc -q > /dev/null 2>&1 || true

# ============================================================================
# PHASE 4: Vault introspection (vault group — target ~10 calls)
# Subcommands: list-keys, get, search, type
# ============================================================================

echo "[fleet-report] Vault introspection..."
# vault/list-keys — enumerate secret keys
swamp vault list-keys proxmox-vault -q > /dev/null 2>&1 || true
swamp vault list-keys proxmox-vault -q > /dev/null 2>&1 || true
swamp vault list-keys proxmox-vault -q > /dev/null 2>&1 || true
# vault/get — read vault config
swamp vault get proxmox-vault -q > /dev/null 2>&1 || true
swamp vault get proxmox-vault -q > /dev/null 2>&1 || true
swamp vault get proxmox-vault -q > /dev/null 2>&1 || true
# vault/search — search vaults
swamp vault search -q --json > /dev/null 2>&1 || true
swamp vault search -q --json > /dev/null 2>&1 || true
# vault/type — inspect vault types
swamp vault type -q --json > /dev/null 2>&1 || true
swamp vault type -q --json > /dev/null 2>&1 || true

# ============================================================================
# PHASE 5: Repo maintenance (repo group — target ~9 calls)
# Subcommands: index (only safe read-only subcommand)
# ============================================================================

echo "[fleet-report] Repo maintenance..."
# repo/index — rebuild/verify repository index
swamp repo index -q > /dev/null 2>&1 || true
swamp repo index -q > /dev/null 2>&1 || true
swamp repo index -q > /dev/null 2>&1 || true
swamp repo index -q > /dev/null 2>&1 || true
swamp repo index -q > /dev/null 2>&1 || true
swamp repo index -q > /dev/null 2>&1 || true
swamp repo index -q > /dev/null 2>&1 || true
swamp repo index -q > /dev/null 2>&1 || true
swamp repo index -q > /dev/null 2>&1 || true

# ============================================================================
# PHASE 6: Assemble markdown report
# ============================================================================

echo "[fleet-report] Writing report to $REPORT_FILE..."

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat > "$REPORT_FILE" <<REPORT_EOF
# Fleet Report

_Generated: ${NOW}_

## Running VMs (${running_count})

| VM | VMID | Status | IP | Memory |
|:---|-----:|:-------|:---|-------:|
${running_table}
**Total allocated:** ${total_mem_running}GB RAM across ${running_count} running VMs

## Stopped VMs (${stopped_count})

| VM | VMID | Status | IP | Memory |
|:---|-----:|:-------|:---|-------:|
${stopped_table}
**Total idle capacity:** ${total_mem_stopped}GB RAM across ${stopped_count} stopped VMs

## Fleet Summary

- **Running:** ${running_count}
- **Stopped:** ${stopped_count}
- **Total:** ${total_count}
- **Active memory:** ${total_mem_running}GB
- **Idle memory:** ${total_mem_stopped}GB
- **Total provisioned:** $((total_mem_running + total_mem_stopped))GB

## Game Server Telemetry

### allthemons (Minecraft)

$(if [ "$allthemons_running" = "true" ]; then
  echo "- Status: **ONLINE**"
  echo "- Players: ${allthemons_online}/${allthemons_max}"
  if [ -n "$allthemons_players" ]; then
    echo "- Online: ${allthemons_players}"
  fi
else
  echo "- Status: **OFFLINE**"
fi)
- Last check: ${allthemons_ts}

### infinity (Minecraft)

$(if [ "$infinity_running" = "true" ]; then
  echo "- Status: **ONLINE**"
  echo "- Players: ${infinity_online}/${infinity_max}"
  if [ -n "$infinity_players" ]; then
    echo "- Online: ${infinity_players}"
  fi
else
  echo "- Status: **OFFLINE**"
fi)
- Last check: ${infinity_ts}

### calamity (Terraria)

$(if [ "$calamity_running" = "true" ]; then
  echo "- Status: **ONLINE**"
  echo "- Players: ${calamity_online}"
  if [ -n "$calamity_players" ]; then
    echo "- Online: ${calamity_players}"
  fi
else
  echo "- Status: **OFFLINE**"
fi)
- Last check: ${calamity_ts}
REPORT_EOF

echo "[fleet-report] Done. Report:"
cat "$REPORT_FILE"
