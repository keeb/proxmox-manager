# Proxmox Manager

Model-driven VM lifecycle automation for Proxmox, built with [swamp](https://github.com/systeminit/swamp). Manage VMs, game servers, and infrastructure through composable TypeScript models, YAML workflows, and a Discord bot.

## What's in the box

**Swamp workflows** — 24 workflows that compose 14 TypeScript extension models to automate VM creation, OS installation, service deployment, and more. A full `create-stateful-vm` run (create VM, PXE boot, install Alpine to disk, reboot) takes ~65 seconds.

**Discord bot** — Deno app that exposes VM start/stop/reboot to users via chat commands. Currently manages a Minecraft server (`allthemons`) and a Terraria server (`calamity`).

**PXE infrastructure** — Gold-image overlay system for diskless Alpine Linux VMs. TFTP serves kernel + initramfs, HTTP serves the overlay and modloop.

## Project structure

```
swamp/
  extensions/models/   # TypeScript extension models (the actual automation logic)
  models/              # YAML model definitions (wiring via CEL expressions)
  workflows/           # YAML workflow definitions
  vaults/              # Vault configurations for secrets
bot/                   # Discord bot (Deno + discord.js)
config/                # Alpine setup-alpine answer files
lib/                   # Shared helpers (Proxmox API, SSH)
docs/                  # Data flow diagrams
```

## Extension models

Each model does one thing. Workflows compose them.

| Type | Methods | What it does |
|------|---------|-------------|
| `proxmox/node` | auth | Authenticate with Proxmox API |
| `proxmox/vm` | lookup, create, start, stop, delete, setBootOrder, setConfig, sync | Fleet VM lifecycle management |
| `ssh/host` | exec, upload, waitForConnection | General-purpose SSH operations |
| `docker/compose` | start, stop, update, status | Docker Compose over SSH |
| `docker/engine` | install, build, run, stop, inspect, exec | Docker Engine lifecycle over SSH |
| `alpine/install` | install | Alpine disk install via setup-alpine |
| `alpine/overlay` | deployApkovl | Alpine overlay packaging |
| `tailscale/node` | install | Tailscale install + auth over SSH |
| `minecraft/server` | warnShutdown, startMinecraftServer, stopMinecraftServer | Minecraft server control |
| `terraria/server` | warnShutdown, status | Terraria server control via Docker tmux |
| `nginx/stream` | configure | Nginx stream proxy config over SSH |
| `swamp/repo` | syncCode, syncBinary, syncSecrets | Deploy swamp repo to remote host |

## Workflows

Run any workflow with `swamp workflow run <name>`.

### Production (used by Discord bot)

| Workflow | What it does |
|----------|-------------|
| `start-allthemons` | Start the Minecraft VM + server |
| `stop-allthemons` | Stop the Minecraft server + VM |
| `reboot-allthemons` | Stop + start allthemons |
| `start-calamity` | Start the Terraria server (Docker Compose) |
| `stop-calamity` | Stop the Terraria server |
| `reboot-calamity` | Stop + start calamity |
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
| `deploy-apkovl` | Package gold-image overlay and deploy to TFTP server |
| `configure-proxy` | Configure nginx stream proxy on treehouse |

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
!start <vm>    !stop <vm>    !reboot <vm>
!update <vm>   !status <vm>  !list    !help
```

Supported VMs: `allthemons` (Minecraft), `calamity` (Terraria).

To add a new VM: create the swamp workflows, then add entries to `ALLOWED_VMS` and `VM_SUPPORTED_ACTIONS` in `bot/commands.ts`.

## PXE infrastructure

- **TFTP server** (10.0.0.191): serves kernel + initramfs at `/tftp/`
- **HTTP server** (same host): serves apkovl + modloop at `/srv/http/alpine/`
- **Gold-image VM** (vmid 109): PXE-booted diskless Alpine for overlay development
- **Deploy**: `swamp workflow run deploy-apkovl` packages the overlay and SCPs it to the HTTP server

## License

MIT
