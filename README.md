# Proxmox Manager

Model-driven VM lifecycle automation for Proxmox, built with [swamp](https://github.com/systeminit/swamp). Manage VMs, game servers, and infrastructure through composable TypeScript models, YAML workflows, and a Discord bot.

## What's in the box

**Swamp workflows** — 37 workflows that compose 16 TypeScript extension models (15 from 10 published `@keeb/*` extensions, 1 local) to automate VM creation, OS installation, service deployment, monitoring, and more. A full `create-stateful-vm` run (create VM, PXE boot, install Alpine to disk, reboot) takes ~65 seconds.

**Discord bot** — Deno app that exposes VM start/stop/reboot to users via chat commands. Manages Minecraft servers (`allthemons`, `infinity`) and a Terraria server (`calamity`). Game servers are auto-discovered from swamp model definitions.

**PXE infrastructure** — Gold-image overlay system for diskless Alpine Linux VMs. TFTP serves kernel + initramfs, HTTP serves the overlay and modloop.

**Monitoring** — Prometheus + Grafana stack on hancock (10.0.0.12). node_exporter on each VM, game player metrics collected every 2 minutes, 5 Grafana dashboards, Discord alert notifications.

## Project structure

```
swamp/
  extensions/models/       # TypeScript extension models (pulled from @keeb/* + 1 local)
  extensions/models/lib/   # Shared helpers (Proxmox API, SSH, metrics, Grafana)
  extensions/workflows/    # Pulled workflow definitions (from @keeb/* extensions)
  .swamp/definitions/      # YAML model definitions (wiring via CEL expressions)
  .swamp/workflows/        # Local workflow definitions
  vaults/                  # Vault configurations for secrets
bot/                       # Discord bot (Deno + discord.js)
config/                    # Alpine setup-alpine answer files
docs/                      # Data flow diagrams
```

## Extension models

Each model does one thing. Workflows compose them. 15 models from 10 published `@keeb/*` extensions, 1 local.

| Type | Extension | Methods | What it does |
|------|-----------|---------|-------------|
| `proxmox/node` | `@keeb/proxmox` | auth | Authenticate with Proxmox API |
| `proxmox/vm` | `@keeb/proxmox` | lookup, create, start, stop, delete, setBootOrder, setConfig, sync | Fleet VM lifecycle management |
| `ssh/host` | `@keeb/ssh` | exec, upload, waitForConnection | General-purpose SSH operations |
| `docker/compose` | `@keeb/docker` | start, stop, update, status | Docker Compose over SSH |
| `docker/engine` | `@keeb/docker` | install, build, run, stop, inspect, exec | Docker Engine lifecycle over SSH |
| `alpine/install` | `@keeb/alpine` | install | Alpine disk install via setup-alpine |
| `alpine/overlay` | `@keeb/alpine` | deployApkovl | Alpine overlay packaging |
| `tailscale/node` | `@keeb/tailscale` | install | Tailscale install + auth over SSH |
| `tailscale/net` | `@keeb/tailscale` | sync, discover | Tailnet machine inventory |
| `minecraft/server` | `@keeb/minecraft` | warnShutdown, startMinecraftServer, stopMinecraftServer, status, say, op, deop, collectMetrics | Minecraft server control |
| `minecraft/installer` | `@keeb/minecraft` | installDeps, upload, extract, configure | Minecraft server pack installation |
| `terraria/server` | `@keeb/terraria` | warnShutdown, status, collectMetrics | Terraria server control via Docker tmux |
| `monitoring/agent` | `@keeb/prometheus` | install, configure, enableTextfileCollector | Monitoring agent install + config over SSH |
| `monitoring/hub` | `@keeb/prometheus` | discover, register | Prometheus target registration |
| `nginx/stream` | `@keeb/nginx` | init, configure | Nginx stream proxy config over SSH |
| `grafana/instance` | `@keeb/grafana` | discover, pushDashboard, exportDashboard, configureContactPoint, configureNotificationPolicy, pushAlertRule, createAnnotation | Grafana dashboard and alert management |
| `swamp/repo` | *(local)* | syncCode, syncBinary, syncSecrets | Deploy swamp repo to remote host |

## Workflows

Run any workflow with `swamp workflow run <name>`.

### Production (used by Discord bot)

| Workflow | What it does |
|----------|-------------|
| `start-minecraft` | Start a Minecraft VM + server (`--input vmName=X`) |
| `stop-minecraft` | Stop a Minecraft server + VM |
| `reboot-minecraft` | Stop + start a Minecraft server |
| `status-minecraft` | Query Minecraft player count |
| `start-calamity` | Start the Terraria server (Docker Compose) |
| `stop-calamity` | Stop the Terraria server |
| `reboot-calamity` | Stop + start calamity |
| `status-calamity` | Query calamity player count |
| `update-calamity` | Pull images + restart Terraria |
| `deploy-bot` | Deploy the Discord bot to the slate VM |

### Infrastructure

| Workflow | What it does |
|----------|-------------|
| `sync-fleet` | Auth + sync all VMs into fleet (named resources) |
| `start-vm` | Start any VM by name (`--input vmName=X`) |
| `stop-vm` | Stop any VM by name (`--input vmName=X`) |
| `create-vm` | Create a new VM by name |
| `delete-vm` | Delete a VM by name |
| `create-stateful-vm` | Full provisioning: create, PXE boot, install Alpine, reboot from disk |
| `setup-docker` | Install Docker Engine on a running VM |
| `setup-tailscale` | Install Tailscale and authenticate on a running VM |
| `destroy-slate` | Stop and delete the slate VM |
| `start-gold-image` | Start the gold-image VM |
| `deploy-apkovl` | Package gold-image overlay and deploy to TFTP server |
| `init-proxy` | Initialize nginx stream proxy directory on treehouse |
| `configure-proxy` | Configure nginx stream proxy on treehouse |
| `collect-game-metrics` | Collect player metrics from all game servers (runs via cron) |
| `setup-game-metrics` | Enable textfile collector on a game server VM |
| `minecraft-install` | Install a Minecraft server pack on a VM |
| `install-monitoring` | Install monitoring agents (node-exporter + promtail) on a VM |
| `setup-monitoring` | Full monitoring setup: install agents + configure wiring + register with Prometheus |
| `configure-monitoring` | Configure monitoring wiring (promtail, Prometheus targets) |
| `sync-tailnet` | Sync Tailscale machine inventory |
| `fleet-report` | Sync fleet, collect telemetry, generate snapshot for reporting |
| `setup-fleet-report` | Install fleet-report cron job on slate |
| `deploy-dashboards` | Push all Grafana dashboards from repo |
| `deploy-alerts` | Configure Discord contact point + notification policy + alert rules |
| `deploy-grafana` | Full Grafana deploy: dashboards then alerting |

### Testing

| Workflow | What it does |
|----------|-------------|
| `vm-lifecycle-test` | Full create/start/stop/delete cycle |
| `guest-agent-test` | Create, start, validate IP via guest agent, cleanup |

## How it works

### Fleet pattern

All VMs are managed through a single `fleet` definition using named resources. Every method writes a per-VM artifact:

```typescript
context.writeResource("vm", vmName, { vmid, vmName, status, ip });
```

Other models reference fleet data via CEL expressions:

```yaml
# Known VM
sshHost: '${{ model.fleet.resource.vm["allthemons"].attributes.ip }}'

# Dynamic VM (from workflow input)
sshHost: '${{ model.fleet.resource.vm[inputs.vmName].attributes.ip }}'
```

### Auth pattern

Every workflow starts with `keebDev02.auth` (the single `proxmox/node` instance). Downstream models receive the auth ticket via CEL:

```yaml
ticket: '${{ model.keebDev02.resource.node.node.attributes.ticket }}'
```

### Composability

Adding a new capability is: write a small TypeScript model, create a YAML definition with CEL wiring, add a workflow that sequences the steps. `setup-docker` is three workflow steps. `setup-tailscale` is three steps and a 50-line model.

## Discord bot

Deno app in `bot/`. Runs in the `#clankers` channel and requires the `homie` role.

```
!start <vm>    !stop <vm>    !reboot <vm>    !update <vm>    !status <vm>
!op <vm> <player>    !deop <vm> <player>    !list    !help
```

Game servers are auto-discovered at startup from swamp model definitions (types `@user/minecraft/server` and `@user/terraria/server`). Currently manages: `allthemons` (Minecraft), `infinity` (Minecraft), `calamity` (Terraria).

## PXE infrastructure

- **TFTP server** (10.0.0.191): serves kernel + initramfs at `/tftp/`
- **HTTP server** (same host): serves apkovl + modloop at `/srv/http/alpine/`
- **Gold-image VM** (vmid 109): PXE-booted diskless Alpine for overlay development
- **Deploy**: `swamp workflow run deploy-apkovl` packages the overlay and SCPs it to the HTTP server

## Game metrics and monitoring

Player metrics are collected every 2 minutes via cron on slate. The `collect-game-metrics` workflow queries each game server for live player counts and writes `.prom` files for node_exporter's textfile collector.

Prometheus on hancock (10.0.0.12) scrapes node_exporter on each game VM at `:9100`. Grafana dashboards visualize node health, game player counts, and system metrics. Alert rules notify via Discord webhook.

Setup for a new game server VM:
1. `swamp workflow run setup-monitoring --input vmName=X` — install agents + configure wiring + register with Prometheus
2. Add the VM's `collectMetrics` call to the `collect-game-metrics` workflow
3. Deploy bot to pick up the new server: `swamp workflow run deploy-bot`

## License

MIT
