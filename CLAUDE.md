# Proxmox Manager

Three interrelated projects managed with [swamp](https://github.com/systeminit/swamp):

1. **Swamp workflows** — model-driven VM lifecycle automation on Proxmox
2. **Discord bot** — exposes VM start/stop/reboot to users via chat
3. **PXE infrastructure** — gold-image overlay and TFTP server for diskless Alpine VMs

## Design Principles

1. **Fleet-centric, not instance-centric.** Models manage classes of resources, not individuals. The `fleet` definition manages all VMs on the node. Individual VMs are tracked as named resource artifacts within the fleet. Don't create a definition per VM — create a fleet that knows about all of them.

2. **Named resources are identity.** Each managed resource gets its own named artifact: `writeResource("vm", vmName, data)`. This gives per-resource version history, CEL addressability (`model.fleet.resource.vm["allthemons"].attributes.ip`), and independent lifecycle. The name IS the identity within the fleet.

3. **Workflows compose, never duplicate.** Generic workflows handle common operations (start-vm, stop-vm). Service-specific workflows compose generic pieces with service logic. If two workflows look the same except for model names, consolidate.

4. **Services are independent concerns.** A game server model knows about games, not VMs. SSH is an implementation detail. The connection comes from a definition attribute wired by CEL. The service model is portable — it works on any host with an SSH endpoint.

5. **Data tells the story.** Every operation writes versioned, immutable data. The system is an audit trail of what happened to every resource. Data accumulates; it never replaces.

6. **Built for agents.** Swamp is the agent's API to infrastructure. Discoverability (model types, data, CEL), safety (verify before destroy), and composability (workflow inputs, CEL wiring) are first-class.

7. **Extend the model, not the workflow.** Missing capability? Add a method to the extension model. Don't add workflow steps that shell out. One method, one purpose, typed input, typed output.

## The Commandments

1. **Models over shell commands.** Never drop to `curl`, `ssh`, or raw API calls. If the model doesn't have the method you need, add it to the extension.
2. **Extend, don't be clever.** Don't work around a missing capability with shell scripts or multi-step hacks. Add a method to the extension model. One method, one purpose.
3. **Use the data model.** Once data exists in a model (via `lookup`, `start`, `sync`, etc.), reference it with CEL expressions. Don't re-fetch data that's already available.
4. **CEL expressions everywhere.** Wire models together with CEL. Known VMs: `${{ model.fleet.resource.vm["allthemons"].attributes.ip }}`. Dynamic VMs: `${{ model.fleet.resource.vm[inputs.vmName].attributes.ip }}`. Secrets: `${{ vault.get("vault-name", "key") }}`.
5. **One fleet per concern.** The `fleet` definition manages all VMs. A `docker/compose` model manages Docker services. Don't mix concerns.
6. **Verify vmid before ANY destructive operation.** Always `swamp model get <name> --json` and check vmid before running delete/stop/destroy methods. Never assume based on name alone.

## Workflows

Run any workflow: `swamp workflow run <name>` (default log output is preferred — compact and readable). Use `--json` only when piping into scripts or the bot.

### Production (used by Discord bot)

| Workflow | What it does |
|----------|-------------|
| `start-minecraft` | Start a Minecraft VM + server (`--input vmName=X tmuxSession=Y serverDir=Z startScript=S logPath=L`) |
| `stop-minecraft` | Stop a Minecraft server + VM (same inputs) |
| `reboot-minecraft` | Stop + start a Minecraft server (same inputs) |
| `status-minecraft` | Query Minecraft player count (same inputs) |
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
| `create-vm` | Create a new VM by name (`--input vmName=X`) |
| `delete-vm` | Delete a VM by name (`--input vmName=X`) |
| `create-stateful-vm` | Full provisioning: create VM, PXE boot, install Alpine to disk, reboot from disk |
| `setup-docker` | Install Docker Engine on a running VM by name |
| `setup-tailscale` | Install Tailscale and authenticate on a running VM by name |
| `destroy-slate` | Stop and delete the slate VM |
| `start-gold-image` | Start the gold-image VM |
| `deploy-apkovl` | Package gold-image overlay and deploy to TFTP server |
| `init-proxy` | Initialize nginx stream proxy directory on treehouse |
| `configure-proxy` | Configure nginx stream proxy on treehouse for a backend service |
| `collect-game-metrics` | Collect player metrics from all game servers — allthemons, calamity, infinity (runs on slate via cron every 2 min) |
| `setup-game-metrics` | One-time: enable textfile collector on a game server VM (`--input vmName=X`) |
| `minecraft-install` | Install a Minecraft server pack on a VM (`--input vmName=X`) |
| `setup-monitoring` | Install monitoring agent on a VM (`--input vmName=X`) |
| `configure-monitoring` | Configure monitoring agent + register with Prometheus hub (`--input vmName=X`) |
| `sync-tailnet` | Sync Tailscale machine inventory |
| `deploy-dashboards` | Push all 5 Grafana dashboard JSONs to Grafana |
| `deploy-alerts` | Configure Discord contact point + notification policy + push all alert rules |
| `deploy-grafana` | Full Grafana deploy: dashboards then alerting |

### Testing

| Workflow | What it does |
|----------|-------------|
| `vm-lifecycle-test` | Full create/start/stop/delete cycle via fleet |
| `guest-agent-test` | Create, start, validate IP via guest agent, cleanup |

## Extension Models

Source code in `extensions/models/`. Shared helpers in `lib/`:
- `lib/proxmox.ts` — Proxmox API helpers (`fetchWithCurl`, `waitForTask`, `resolveAuth`, `getVmIpWithRetry`, `is401`)
- `lib/ssh.ts` — SSH helpers (`sshExec`, `sshExecRaw`, `waitForSsh`)
- `lib/metrics.ts` — Game server metrics helpers (`formatPromMetrics`, `formatLogLine`, `writeMetricsFiles`)
- `lib/grafana.ts` — Grafana API helpers (`grafanaApiGet`, `grafanaApiPost`, `grafanaApiPut`, `grafanaApiDelete`, `grafanaApiPostFile`)

| Type | File | Purpose |
|------|------|---------|
| `proxmox/node` | `proxmox_node.ts` | Auth root. Methods: `auth` |
| `proxmox/vm` | `proxmox_vm.ts` | Fleet VM lifecycle. Methods: `lookup`, `create`, `start`, `stop`, `delete`, `setBootOrder`, `setConfig`, `sync` |
| `swamp/repo` | `swamp_repo.ts` | Deploy swamp repo to remote host. Methods: `syncCode`, `syncBinary`, `syncSecrets` |
| `ssh/host` | `ssh_host.ts` | General-purpose SSH operations. Methods: `exec`, `upload`, `waitForConnection` |
| `docker/compose` | `docker_compose.ts` | Docker Compose over SSH. Methods: `start`, `stop`, `update`, `status` |
| `alpine/install` | `alpine_install.ts` | Alpine disk install via setup-alpine + chroot post-install. Method: `install` |
| `alpine/overlay` | `alpine_overlay.ts` | Alpine overlay packaging. Method: `deployApkovl` |
| `docker/engine` | `docker_engine.ts` | Docker Engine lifecycle over SSH. Methods: `install`, `build`, `run`, `stop`, `inspect`, `exec` |
| `tailscale/node` | `tailscale_node.ts` | Tailscale install + auth over SSH. Method: `install` |
| `tailscale/net` | `tailscale_net.ts` | Tailnet machine inventory. Methods: `sync`, `discover` |
| `minecraft/server` | `minecraft_server.ts` | Minecraft server control. Methods: `warnShutdown`, `startMinecraftServer`, `stopMinecraftServer`, `status`, `say`, `op`, `deop`, `collectMetrics` |
| `minecraft/installer` | `minecraft_installer.ts` | Minecraft server pack installation. Methods: `installDeps`, `upload`, `extract`, `configure` |
| `terraria/server` | `terraria_server.ts` | Terraria server control via Docker tmux. Methods: `warnShutdown`, `status`, `collectMetrics` |
| `monitoring/agent` | `monitoring_agent.ts` | Monitoring agent install + config over SSH. Methods: `install`, `configure`, `enableTextfileCollector` |
| `monitoring/hub` | `monitoring_hub.ts` | Prometheus target registration. Methods: `discover`, `register` |
| `nginx/stream` | `nginx_stream.ts` | Nginx stream proxy config over SSH. Methods: `init`, `configure` |
| `grafana/instance` | `grafana_instance.ts` | Grafana dashboard and alert management via API. Methods: `discover`, `pushDashboard`, `exportDashboard`, `configureContactPoint`, `configureNotificationPolicy`, `pushAlertRule`, `createAnnotation` |

### Auth pattern

Every workflow starts with `keebDev02.auth` (the single `proxmox/node` instance). The `fleet` model receives the ticket via CEL:
```yaml
ticket: '${{ model.keebDev02.resource.node.node.attributes.ticket }}'
csrfToken: '${{ model.keebDev02.resource.node.node.attributes.csrfToken }}'
```

### Fleet pattern

All VMs go through the single `fleet` definition (`proxmox/vm`). Every method writes a named resource per VM:
```typescript
context.writeResource("vm", vmName, { vmid, vmName, status, ip, ... });
```

CEL references use `resource.<specName>.<instanceName>` format:
- **Known VMs** (hardcoded in definitions): `${{ model.fleet.resource.vm["allthemons"].attributes.ip }}`
- **Dynamic VMs** (from workflow inputs): `${{ model.fleet.resource.vm[inputs.vmName].attributes.ip }}`

The `sync` method populates the fleet with all VMs from Proxmox in one call.

### Annotation pattern

Workflows that perform significant actions (deploys, game server start/stop/reboot) should end with a Grafana annotation step. This makes events visible on dashboards as vertical markers.

Add an `annotate` step as the last step in the workflow, depending on the final "real" step:
```yaml
- name: annotate
  description: Create Grafana annotation
  task:
    type: model_method
    modelIdOrName: grafanaHub
    methodName: createAnnotation
    inputs:
      tags: '["game", "start", "allthemons"]'
      text: 'allthemons started'
  dependsOn:
    - step: <last-real-step>
      condition:
        type: succeeded
  weight: 0
```

Tag conventions: `["deploy", "<target>"]` for deploys, `["game", "<action>", "<server>"]` for game server operations. Dashboards filter annotations by tag (e.g. Game Servers shows `["game"]`, Node Exporter shows `["deploy"]`).

### Model instances

- **keebDev02** (`proxmox/node`) — auth root for all Proxmox calls
- **fleet** (`proxmox/vm`) — fleet manager for all VMs (named resources per VM)
- **calamity** (`docker/compose`) — Terraria Docker services, SSH host from fleet calamity IP
- **allthemonsMinecraft** (`minecraft/server`) — Minecraft server control, SSH host from fleet allthemons IP
- **infinityMinecraft** (`minecraft/server`) — Minecraft server control, SSH host from fleet infinity IP
- **minecraftGame** (`minecraft/server`) — generic Minecraft server, SSH host from fleet (dynamic vmName), paths from workflow inputs
- **minecraftInstaller** (`minecraft/installer`) — Minecraft server pack installer, SSH host from fleet (dynamic vmName)
- **calamityTerraria** (`terraria/server`) — Terraria server control, SSH host from fleet calamity IP
- **alpineInstaller** (`alpine/install`) — Alpine disk installer, SSH host from fleet (dynamic vmName)
- **goldImageOverlay** (`alpine/overlay`) — overlay builder, SSH host from fleet gold-image IP
- **dockerEngine** (`docker/engine`) — Docker installer, SSH host from fleet (dynamic vmName)
- **slateDocker** (`docker/engine`) — Docker operations on slate, SSH host from fleet slate IP
- **tailscaleNode** (`tailscale/node`) — Tailscale installer, SSH host from fleet (dynamic vmName), authKey from vault
- **tailnet** (`tailscale/net`) — Tailnet machine inventory
- **swampRepo** (`swamp/repo`) — Swamp repo deployment to slate, SSH host from fleet slate IP
- **testVmSsh** (`ssh/host`) — ad-hoc SSH operations, host from fleet (dynamic vmName)
- **monitoringAgent** (`monitoring/agent`) — monitoring agent install/config, SSH host from fleet (dynamic vmName)
- **hancockMonitoring** (`monitoring/hub`) — Prometheus target registration on hancock (10.0.0.12)
- **streamProxy** (`nginx/stream`) — nginx stream proxy on treehouse (vmName/targetIp/portMap via workflow inputs)
- **grafanaHub** (`grafana/instance`) — Grafana dashboard/alert management on hancock (10.0.0.12)

## Discord Bot

Deno app in `bot/`. Runs swamp workflows via chat commands in `#clankers` (requires `homie` role).

```
!start <vm>    !stop <vm>    !reboot <vm>    !update <vm>    !status <vm>
!op <vm> <player>    !deop <vm> <player>    !list    !help
```

Game server VMs are auto-discovered at startup from swamp model definitions (types `@user/minecraft/server` and `@user/terraria/server`). The `serverName` globalArgument in each definition determines the VM name. Supported actions are type-inherent (minecraft: start/stop/reboot/status/op/deop; terraria: start/stop/reboot/update/status).

For minecraft servers, the bot calls generic workflows (`start-minecraft`, `stop-minecraft`, etc.) passing `vmName` and server config (tmuxSession, serverDir, startScript, logPath) extracted from the model definition's globalArguments. For terraria servers, the bot calls per-server workflows (`start-calamity`, etc.).

## PXE Infrastructure

- **TFTP server**: 10.0.0.191 (vmid 103) — serves kernel + initramfs via TFTP at `/tftp/`
- **HTTP server**: same box (lighttpd) — serves apkovl + modloop at `/srv/http/alpine/`
- **Gold-image VM**: vmid 109, name `gold-image` — PXE-booted diskless Alpine
- **Overlay file**: `/srv/http/alpine/alpine.apkovl.tar.gz`
- **Deploy workflow**: `swamp workflow run deploy-apkovl` (start gold-image → `lbu package` → SCP to HTTP server)
- **Slate setup**: `config/slate-setup-alpine.conf` — Alpine `setup-alpine` answer file

## Game Metrics

Player metrics are collected every 2 minutes via cron on slate:
```
*/2 * * * * docker run --rm ... discord-bot sh -c "cd /opt/proxmox-manager && swamp workflow run collect-game-metrics"
```

The `collect-game-metrics` workflow: auth → sync-fleet → collectMetrics on all game servers in parallel.

Each game server's `collectMetrics` method:
1. SSHes to the game VM to query live player count (tmux `list` for Minecraft, `playing` for Terraria)
2. Writes a `.prom` file to `/var/lib/node_exporter/textfile_collector/game_<type>.prom` on the game VM via SSH
3. Appends a JSON line to `/var/log/game-players.log` on the game VM
4. Writes a `metrics` swamp resource with the result

node_exporter runs on each game VM with `--collector.textfile.directory=/var/lib/node_exporter/textfile_collector`. Prometheus on hancock (10.0.0.12) scrapes each game VM's node_exporter at `:9100`.

**Setup checklist for a new game server VM:**
1. `swamp workflow run setup-game-metrics --input '{"vmName":"X"}'` — installs node_exporter + textfile collector
2. `swamp workflow run configure-monitoring --input '{"vmName":"X"}'` — registers VM with Prometheus hub
3. Add VM's `collectMetrics` call to `collect-game-metrics` workflow

**Key gotcha:** `sshHost` in minecraft/server GlobalArgs must be `z.string().nullable()` — when a VM is stopped, the fleet IP is null and Zod rejects non-nullable strings before the method even runs.

## Getting data from swamp

To inspect runtime data (IPs, status, etc.) written by model methods:
```bash
swamp data get fleet infinity          # full JSON for the infinity fleet resource
swamp data list fleet                  # list all named resources in the fleet model
swamp data list <modelName>            # list all data for any model
```

`swamp model get <name> --json` returns the **definition** (schema, globalArguments, methods) — NOT runtime data. Use `swamp data get` for runtime values.

## Best Practices

- CEL path format: `model.<def>.resource.<specName>.<instanceName>.attributes.<field>`
- Fleet named resources: `model.fleet.resource.vm["<vmName>"].attributes.ip` (known) or `model.fleet.resource.vm[inputs.vmName].attributes.ip` (dynamic)
- Single-resource models double up: `model.keebDev02.resource.node.node.attributes.ticket`
- writeResource is 4-arg: `writeResource(specName, instanceName, data)` or `writeResource(specName, instanceName, data, overrides)`
- CEL expressions always return strings — handle type coercion in extension code (`parseInt`, `z.union([z.number(), z.string()])`)
- Extension model `version` must be CalVer string: `"YYYY.MM.DD.MICRO"` (e.g., `"2026.02.11.1"`)
- Don't use TypeScript optional params (`opts?`) in extension models — use `opts = {}` instead
- VMs need `qemu-guest-agent` installed and `agent: 1` in Proxmox config for IP discovery
- Workflow step `inputs` pass runtime values to model methods, overriding per-method arguments
- Definitions use `globalArguments:` for shared config, `methods.<name>.arguments:` for per-method args
- Extension model execute signature: `execute(args, context)` — method args in `args`, global args in `context.globalArgs`
- Per-method args that come from workflow inputs (not definition YAML) must use `z.string().default("")` + runtime guard (`if (!args.x) throw new Error("x is required")`) — swamp validates ALL method schemas at model load time, so a required field + empty `arguments: {}` in the definition bricks the entire model
- If a definition has no static per-method arguments, omit the `methods:` block entirely rather than declaring empty `arguments: {}`
