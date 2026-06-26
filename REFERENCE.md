# Proxmox Manager — Reference

The detail backing [CLAUDE.md](./CLAUDE.md): full workflow/model/instance tables, the
core patterns (auth, fleet, annotation), modpack/PXE/metrics mechanics, and
extension-authoring gotchas. CLAUDE.md is the lean operating guide; this is the
lookup table. Runtime values come from `swamp data get`; model definitions from
`swamp model get <name> --json`.

## Design Principles

1. **Fleet-centric, not instance-centric.** Models manage classes of resources, not individuals. The `fleet` definition manages all VMs on the node. Individual VMs are tracked as named resource artifacts within the fleet. Don't create a definition per VM — create a fleet that knows about all of them.
2. **Named resources are identity.** Each managed resource gets its own named artifact: `writeResource("vm", vmName, data)`. This gives per-resource version history, CEL addressability, and independent lifecycle. The name IS the identity within the fleet.
3. **Workflows compose, never duplicate.** Generic workflows handle common operations (start-vm, stop-vm). Service-specific workflows compose generic pieces with service logic. If two workflows look the same except for model names, consolidate.
4. **Services are independent concerns.** A game server model knows about games, not VMs. SSH is an implementation detail wired by CEL. The service model is portable — it works on any host with an SSH endpoint.
5. **Data tells the story.** Every operation writes versioned, immutable data — an audit trail of what happened to every resource. Data accumulates; it never replaces.
6. **Built for agents.** Swamp is the agent's API to infrastructure. Discoverability, safety (verify before destroy), and composability are first-class.
7. **Extend the model, not the workflow.** Missing capability? Add a method to the extension model. Don't add workflow steps that shell out. One method, one purpose, typed input, typed output.

## The Commandments

1. **Models over shell commands.** Never drop to `curl`, `ssh`, or raw API calls. If the model doesn't have the method you need, add it to the extension. (`fetchWithCurl`/`sshExec` *inside* an extension model is the sanctioned HTTP/SSH layer.)
2. **Extend, don't be clever.** Don't work around a missing capability with shell scripts or multi-step hacks. Add a method to the extension model.
3. **Use the data model.** Once data exists (via `lookup`, `start`, `sync`, etc.), reference it with CEL. Don't re-fetch what's already available.
4. **CEL expressions everywhere.** Prefer `data.latest("fleet", "<vm>").attributes.ip` (known) / `data.latest("fleet", inputs.vmName).attributes.ip` (dynamic) / `vault.get("vault-name", "key")` (secrets). The old `model.<def>.resource.<spec>.<instance>.attributes.<field>` form is **deprecated** but still appears in older definitions.
5. **One fleet per concern.** The `fleet` definition manages all VMs. A `docker/compose` model manages Docker services. Don't mix concerns.
6. **Verify vmid before ANY destructive operation.** Always check vmid (`swamp data get fleet <vm>`) before delete/stop/destroy. Never assume based on name alone.

## Workflows

~42 total: ~21 local (tracked in git), ~21 from `@keeb/*` extensions sourced from `~/git/swamp-extensions/*` (wired in `swamp/.swamp-sources.yaml`, gitignored).

### Production (used by Discord bot)

| Workflow | Source | What it does |
|----------|--------|-------------|
| `start-minecraft` | pulled | Start a Minecraft VM + server (`--input vmName=X tmuxSession=Y serverDir=Z startScript=S logPath=L`) |
| `stop-minecraft` | pulled | Stop a Minecraft server + VM (same inputs) |
| `reboot-minecraft` | pulled | Stop + start a Minecraft server (same inputs) |
| `status-minecraft` | pulled | Query Minecraft player count (same inputs) |
| `start-calamity` | local | Start the Terraria server (Docker Compose) |
| `stop-calamity` | local | Stop the Terraria server |
| `reboot-calamity` | local | Stop + start calamity |
| `status-calamity` | local | Query calamity player count |
| `update-calamity` | local | Pull images + restart Terraria |
| `deploy-bot` | local | Deploy the Discord bot to the slate VM |

### Infrastructure

| Workflow | Source | What it does |
|----------|--------|-------------|
| `sync-fleet` | pulled | Auth + sync all VMs into fleet (named resources) |
| `start-vm` | pulled | Start any VM by name (`--input vmName=X`) |
| `stop-vm` | pulled | Stop any VM by name (`--input vmName=X`) |
| `create-vm` | pulled | Create a new VM by name (`--input vmName=X`) |
| `delete-vm` | pulled | Delete a VM by name (`--input vmName=X`) |
| `create-stateful-vm` | pulled | Full provisioning: create VM, PXE boot, install Alpine to disk, reboot from disk |
| `setup-docker` | pulled | Install Docker Engine on a running VM by name |
| `setup-tailscale` | pulled | Install Tailscale and authenticate on a running VM by name |
| `destroy-slate` | local | Stop and delete the slate VM |
| `start-gold-image` | local | Start the gold-image VM |
| `deploy-apkovl` | pulled | Package gold-image overlay and deploy to TFTP server |
| `init-proxy` | local | Initialize nginx stream proxy directory on treehouse |
| `configure-proxy` | pulled | Configure nginx stream proxy on treehouse for a backend service |
| `collect-game-metrics` | pulled | Collect player metrics from all game servers (runs on slate via cron) |
| `setup-game-metrics` | pulled | One-time: enable textfile collector on a game server VM (`--input vmName=X`) |
| `minecraft-install` | pulled | Install a Minecraft server pack on a VM (`--input vmName=X`) |
| `install-monitoring` | local | Install monitoring agents (node-exporter + promtail) on a VM (`--input vmName=X`) |
| `setup-monitoring` | pulled | Full monitoring setup: install agents + configure wiring + register with Prometheus (`--input vmName=X`) |
| `configure-monitoring` | pulled | Configure monitoring wiring (promtail, Prometheus target registration) (`--input vmName=X`) |
| `sync-tailnet` | local | Sync Tailscale machine inventory |
| `fleet-report` | local | Sync fleet, collect game server telemetry, and generate snapshot data for reporting |
| `setup-fleet-report` | local | Install fleet-report cron job on slate |
| `deploy-dashboards` | local | Push all 5 Grafana dashboard JSONs to Grafana |
| `deploy-alerts` | local | Configure Discord contact point + notification policy + push all alert rules |
| `deploy-grafana` | local | Full Grafana deploy: dashboards then alerting |

### Modpack updates (infinity)

| Workflow | Source | What it does |
|----------|--------|-------------|
| `check-infinity-update` | local | Scrape CurseForge for the latest Project Infinity server pack; writes `projectInfinityModpack/project-infinity-0-1` resource with `latestFileId`/`latestFileName` |
| `download-infinity-modpack` | local | discoverLatest + download the latest server-pack zip to `/tmp/curseforge-downloads/` (idempotent — skips if file already on disk with the expected size) |
| `deploy-infinity-modpack` | local | Full pipeline: discover → download → install (unzip into `~/game-<fileId>/`) → stop server → fork world+admin state from active install → swap `~/game` symlink → start server → annotate Grafana |
| `rollback-infinity-modpack` | local | Stop server, point `~/game` at a previously-installed `game-<fileId>`, restart. Takes `--input fileId=...` |
| `list-infinity-modpacks` | local | List all `game-*` installs on the infinity VM, marking which is active. Read with `swamp data get infinityServerPack snapshot` |

### Testing

| Workflow | Source | What it does |
|----------|--------|-------------|
| `vm-lifecycle-test` | pulled | Full create/start/stop/delete cycle via fleet |
| `guest-agent-test` | pulled | Create, start, validate IP via guest agent, cleanup |

## Extension Models

16 generic model types come from 10 `@keeb/*` extensions loaded as local sources from `~/git/swamp-extensions/*` (wired in `swamp/.swamp-sources.yaml`). 3 project-specific models — `@keeb/swamp/repo`, `@keeb/curseforge/modpack`, `@keeb/minecraft/serverpack` — live here in the local-only `@keeb/proxmox-manager` extension (`swamp/local-models/`, tracked in git, not published).

Shared helpers in `swamp/extensions/models/lib/`:
- `lib/proxmox.ts` — Proxmox API helpers (`fetchWithCurl`, `waitForTask`, `resolveAuth`, `getVmIpWithRetry`, `is401`)
- `lib/ssh.ts` — SSH helpers (`sshExec`, `sshExecRaw`, `waitForSsh`)
- `lib/metrics.ts` — Game server metrics helpers (`formatPromMetrics`, `formatLogLine`, `writeMetricsFiles`)
- `lib/grafana.ts` — Grafana API helpers (`grafanaApiGet`, `grafanaApiPost`, `grafanaApiPut`, `grafanaApiDelete`, `grafanaApiPostFile`)

Modpack scraping uses a persistent Chromium profile via Playwright:
- `swamp/scripts/curseforge-scraper.js` — Node script that drives `chromium.launchPersistentContext(userDataDir, ...)`. The userDataDir survives Cloudflare clearance cookies between runs.
- Profile path lives in the vault: `vault.get("proxmox-vault", "chrome-profile-path")` (default `~/.config/swamp-chrome`).
- First run may hit a Cloudflare interstitial. If automated solve doesn't clear in 30s, run `node swamp/scripts/curseforge-scraper.js warmup '{"slug":"<slug>","userDataDir":"<path>","headless":false}'` once with a display to solve manually.
- Scraper talks to CurseForge's internal API (`/api/v1/mods/<projectId>/files`, `/files/<id>/additional-files`) once the page context is warmed — no DOM scraping needed. Server packs are linked to main files via `parentProjectFileId`.

### Published extensions

| Extension | Types |
|-----------|-------|
| `@keeb/proxmox` | `proxmox/node`, `proxmox/vm` |
| `@keeb/ssh` | `ssh/host` |
| `@keeb/docker` | `docker/compose`, `docker/engine` |
| `@keeb/alpine` | `alpine/install`, `alpine/overlay` |
| `@keeb/tailscale` | `tailscale/node`, `tailscale/net` |
| `@keeb/minecraft` | `minecraft/server`, `minecraft/installer` |
| `@keeb/terraria` | `terraria/server` |
| `@keeb/nginx` | `nginx/stream` |
| `@keeb/prometheus` | `monitoring/agent`, `monitoring/hub` |
| `@keeb/grafana` | `grafana/instance` |

### Model types

| Type | Extension | Purpose |
|------|-----------|---------|
| `proxmox/node` | `@keeb/proxmox` | Auth root. Methods: `auth` |
| `proxmox/vm` | `@keeb/proxmox` | Fleet VM lifecycle. Methods: `lookup`, `create`, `start`, `stop`, `delete`, `setBootOrder`, `setConfig`, `sync` |
| `ssh/host` | `@keeb/ssh` | General-purpose SSH operations. Methods: `exec`, `upload`, `waitForConnection` |
| `docker/compose` | `@keeb/docker` | Docker Compose over SSH. Methods: `start`, `stop`, `update`, `status` |
| `docker/engine` | `@keeb/docker` | Docker Engine lifecycle over SSH. Methods: `install`, `build`, `run`, `stop`, `inspect`, `exec` |
| `alpine/install` | `@keeb/alpine` | Alpine disk install via setup-alpine + chroot post-install. Method: `install` |
| `alpine/overlay` | `@keeb/alpine` | Alpine overlay packaging. Method: `deployApkovl` |
| `tailscale/node` | `@keeb/tailscale` | Tailscale install + auth over SSH. Method: `install` |
| `tailscale/net` | `@keeb/tailscale` | Tailnet machine inventory. Methods: `sync`, `discover` |
| `minecraft/server` | `@keeb/minecraft` | Minecraft server control. Methods: `warnShutdown`, `startMinecraftServer`, `stopMinecraftServer`, `status`, `say`, `op`, `deop`, `collectMetrics` |
| `minecraft/installer` | `@keeb/minecraft` | Minecraft server pack installation. Methods: `installDeps`, `upload`, `extract`, `configure` |
| `terraria/server` | `@keeb/terraria` | Terraria server control via Docker tmux. Methods: `warnShutdown`, `status`, `collectMetrics` |
| `monitoring/agent` | `@keeb/prometheus` | Monitoring agent install + config over SSH. Methods: `install`, `configure`, `enableTextfileCollector` |
| `monitoring/hub` | `@keeb/prometheus` | Prometheus target registration. Methods: `discover`, `register` |
| `nginx/stream` | `@keeb/nginx` | Nginx stream proxy config over SSH. Methods: `init`, `configure` |
| `grafana/instance` | `@keeb/grafana` | Grafana dashboard and alert management via API. Methods: `discover`, `pushDashboard`, `exportDashboard`, `configureContactPoint`, `configureNotificationPolicy`, `pushAlertRule`, `createAnnotation` |
| `swamp/repo` | *(local)* | Deploy swamp repo to remote host. Methods: `syncCode`, `syncBinary`, `syncSecrets`, `syncAuth` |
| `curseforge/modpack` | *(local)* | Scrape CurseForge modpack pages via Playwright + internal API; track latest server-pack file. Methods: `discoverLatest`, `listServerPacks`, `download`. Resources: `project` (per slug, holds `latestFileId`/`latestLocalPath` pointer), `file` (per fileId, holds download metadata + localPath). |
| `minecraft/serverpack` | *(local)* | Manages versioned server-pack installs on a Minecraft VM with COW layout (`~/game` → `~/game-<fileId>` symlink). Methods: `install` (upload+unzip), `forkState` (cp world+admin state from active install), `activate` (atomic symlink swap; bootstraps if `~/game` is still a real dir), `currentActive`, `listInstalled`, `removeInstallation`. Methods auto-resolve fileId/localPath from the curseforge project resource when args are empty, so workflows don't need CEL chaining. |

### Auth pattern

Every workflow starts with `keebDev02.auth` (the single `proxmox/node` instance). The `fleet` model receives the ticket via CEL:
```yaml
ticket: '${{ data.latest("keebDev02", "node").attributes.ticket }}'
csrfToken: '${{ data.latest("keebDev02", "node").attributes.csrfToken }}'
```

### Fleet pattern

All VMs go through the single `fleet` definition (`proxmox/vm`). Every method writes a named resource per VM:
```typescript
context.writeResource("vm", vmName, { vmid, vmName, status, ip, ... });
```

CEL references (modern `data.latest` form):
- **Known VMs** (hardcoded in definitions): `${{ data.latest("fleet", "allthemons").attributes.ip }}`
- **Dynamic VMs** (from workflow inputs): `${{ data.latest("fleet", inputs.vmName).attributes.ip }}`

The `sync` method populates the fleet with all VMs from Proxmox in one call.

### Annotation pattern

Workflows that perform significant actions (deploys, game server start/stop/reboot) should end with a Grafana annotation step so events show on dashboards as vertical markers. Add an `annotate` step as the last step, depending on the final "real" step:
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

Tag conventions: `["deploy", "<target>"]` for deploys, `["game", "<action>", "<server>"]` for game server operations. Dashboards filter by tag (Game Servers shows `["game"]`, Node Exporter shows `["deploy"]`).

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
- **projectInfinityModpack** (`curseforge/modpack`) — CurseForge slug `project-infinity-0-1`, Chrome profile path from vault
- **infinityServerPack** (`minecraft/serverpack`) — versioned server-pack installs on infinity VM, COW layout under `/root/game-*` with `~/game` as the active symlink

## Deploy & Bot Runtime

The Discord bot is a Deno app in `bot/`, packaged as the `discord-bot` Docker image and run on **slate** (`10.0.0.33`). The same image is reused by the slate crons (`game-metrics`, `fleet-report`).

**How the image gets its swamp binary** — `bot/Dockerfile` is:
```dockerfile
FROM denoland/deno:debian
RUN apt-get update && apt-get install -y --no-install-recommends curl rsync openssh-client jq ca-certificates && rm -rf /var/lib/apt/lists/*
COPY swamp /usr/local/bin/swamp
RUN chmod +x /usr/local/bin/swamp
```
The binary is **baked into the image at build time** from `bot/swamp` (on slate: `/opt/proxmox-manager/bot/swamp`). Containers run the image's `/usr/local/bin/swamp` — **NOT** the binary on the mounted `/opt/proxmox-manager` volume. So a `syncBinary` only changes a file on disk; it takes effect at the next image build.

**`deploy-bot` workflow steps** (`swamp/workflows/...deploy-bot.yaml`): `auth` → `lookup-slate` → `sync-code` (rsync repo) ∥ `sync-bot` (rsync `bot/`) ∥ `sync-binary` (`which swamp` → `/opt/proxmox-manager/bot/swamp`) ∥ `sync-auth` → `sync-secrets` → `build-image` (`slateDocker.build`, context `/opt/proxmox-manager/bot`, tag `discord-bot`) → `write-env` → `start-bot` (`slateDocker.run`) → `annotate`.

**Updating just the binary** (no bot restart): `swampRepo.syncBinary` → `slateDocker.build`. Per-tick crons auto-pick-up `discord-bot:latest` next run; the long-running `discord-bot` container keeps the old image until `start-bot`/`deploy-bot`. See CLAUDE.md for the recipe + the lock-contention warning.

**syncCode `--delete` hazards:** `swampRepo.syncCode` rsyncs with `--delete`. Excludes must include `bot/` (sync-code and sync-bot run in parallel), and slate-local datastore state (`_extension_catalog.db*`, `pulled-extensions/`, `.swamp-sources.yaml`) — otherwise a deploy clobbers them. Tracked via `SWAMP_EXCLUDES`.

## Datastore & Namespaces

Shared MongoDB datastore on **hancock** (`10.0.0.12:27017`, db `swamp`, tenant `keeb`, `@keeb/mongodb-datastore`). One namespace per logical repo:

| Namespace | Written by |
|-----------|-----------|
| `proxmox-manager` | this repo (`~/git/proxmox-manager/swamp`, repoId `921ecec9…`) **and** slate's `/opt/proxmox-manager` via the `*/10 collect-game-metrics` cron |
| `fleet-report` | slate's hourly `fleet-report` cron (uses a `SWAMP_DATASTORE` env override to redirect namespace) |
| `proxmox-manager-slate`, `swamp-media` | other repos sharing the same Mongo |

**Inspect the datastore** from `~/git/mongo-stats` (the `treehouse` model = `@keeb/mongodb` + `mongodb_datastore_stats.ts`):
```bash
swamp model method run treehouse datastore_stats                              # all namespaces
swamp model method run treehouse datastore_stats --input '{"namespace":"proxmox-manager"}'
```
The stats report's **Locks** column counts raw `_locks` documents in Mongo (stale records included) — distinct from swamp's live `__global__` lock (`swamp datastore lock status`). The **Active window** is min/max `updatedAt` of `_paths`; content-addressed dedup means identical re-writes (e.g. all game servers offline) don't advance it.

**Lock contention:** running local `swamp` against this datastore grabs the global lock and can time out a concurrent slate cron tick (`Lock held by keeb@think.tank`). For stuck locks: `swamp datastore lock status` / `swamp datastore lock release --force`.

> The swamp binary version string `20260206…-sha.` is a **dev-build name artifact, always current** — not stale. Ignore "swamp repo upgrade" / superseded-skill warnings as a version signal.

## slate Crons

`crontab -l` on slate (`10.0.0.33`), all wrapped in `docker rm -f <name>; docker run --rm --name <name> ... timeout <N>`:

| Schedule | Job | Namespace | Notes |
|----------|-----|-----------|-------|
| `*/10 * * * *` | `collect-game-metrics` (`timeout 600`) | `proxmox-manager` | writes game player metrics |
| `0 * * * *` | `fleet-report` (`timeout 600`) | `fleet-report` | hourly fleet snapshot |
| `5 8 * * *` | `post-fleet-report` (`timeout 300`) | — | posts the daily report |
| `0 8 * * *` | `mms-inventory` | — | **broken: image `mms-inventory` missing → `pull access denied`** |

The `docker rm -f` prefix prevents the `--name` Conflict wedge where a hung container blocks every subsequent tick. The `timeout` wrapper guards against a slow datastore push hanging the tick — but if the push exceeds the timeout it's killed mid-write (the 06-14 "leaderboard frozen" failure mode). Logs: `/var/log/{game-metrics,fleet-report,mms-inventory}.log`.

## Modpack Updates (infinity)

Project Infinity ships server packs as separate "additional files" on CurseForge — each main modpack file has a sibling `Serverfiles_*.zip`. The `curseforge/modpack` model resolves the latest server pack via CurseForge's internal API (driven through a Playwright-warmed Chromium context to clear Cloudflare). The `minecraft/serverpack` model lays out versioned installs on the VM:

```
~/game            -> game-<fileId>          (active install — symlink)
~/game-<oldId>/   (previous version, untouched, retained for rollback)
~/game-<newId>/   (current version)
  ├── mods/, config/, libraries/, server.jar, start.sh    (from server pack zip)
  ├── world/                                              (forked from active install at deploy time)
  ├── server.properties, ops.json, whitelist.json, ...    (forked from active install)
  └── variables.txt                                       (new pack's defaults + JAVA_ARGS/SKIP_JAVA_CHECK patched from old)
```

**Copy-on-write world semantics**: each install owns its own world. Deploy copies (`cp -a`) the active install's world into the new install, then atomically swaps the symlink (`ln -sfn`). Rollback re-points the symlink — the old install's world is pristine because the new install played on its own copy.

**Pre-existing installs**: on first deploy, if `~/game` is still a real directory (not a symlink), `activate` renames it to `~/game-preexisting/` before installing the symlink. This bootstraps the COW layout without requiring manual prep.

**Idempotency**:
- `curseforge/modpack.download` checks for an existing local file matching `fileSize` and skips the Playwright round-trip if found (the server pack is 600+ MB).
- `minecraft/serverpack.install` skips the upload+unzip if `<serverParent>/game-<fileId>/start.sh` already exists.

**Java/Alpine gotcha**: ServerPackCreator's start.sh tries to auto-install Java via Jabba, which requires glibc and fails on Alpine/musl. `forkState` patches the new `variables.txt` to set `SKIP_JAVA_CHECK=true` and `WAIT_FOR_USER_INPUT=false`, and carries forward `JAVA_ARGS`/`ADDITIONAL_ARGS`/`JAVA`/`RESTART` from the previous install.

**Inter-step coordination**: swamp's `data.latest()` in workflow CEL is a snapshot from workflow start, so an earlier step's writes aren't visible to later steps' input CEL. The `install`/`forkState`/`activate` methods auto-resolve `fileId` (and `install` also `localPath`) by shelling out to `swamp data get projectInfinityModpack project-infinity-0-1 --json` inside the method body. Workflows pass no inputs to these steps — each method reads the latest pointer itself.

**Common operations:**
```bash
swamp workflow run check-infinity-update                     # what's the latest fileId?
swamp data get projectInfinityModpack project-infinity-0-1   # see the pointer
swamp workflow run deploy-infinity-modpack                   # full upgrade pipeline
swamp workflow run list-infinity-modpacks                    # what installs are on disk?
swamp data get infinityServerPack snapshot                   # ...as JSON
swamp workflow run rollback-infinity-modpack --input fileId=preexisting   # swap back
```

## Discord Bot

Deno app in `bot/`. Runs swamp workflows via chat commands in `#clankers` (requires `homie` role).

```
!start <vm>    !stop <vm>    !reboot <vm>    !update <vm>    !status <vm>
!op <vm> <player>    !deop <vm> <player>    !list    !help
```

Game server VMs are auto-discovered at startup from swamp model definitions (types `@keeb/minecraft/server` and `@keeb/terraria/server`). The `serverName` globalArgument in each definition determines the VM name. Supported actions are type-inherent (minecraft: start/stop/reboot/status/op/deop; terraria: start/stop/reboot/update/status).

For minecraft servers, the bot calls generic workflows (`start-minecraft`, etc.) passing `vmName` and server config (tmuxSession, serverDir, startScript, logPath) extracted from the definition's globalArguments. For terraria servers, the bot calls per-server workflows (`start-calamity`, etc.).

### Adding a new game server (checklist)

1. Create an extension model definition (or reuse `minecraft/server` / `terraria/server`) with `serverName` in globalArguments.
2. Create per-server workflows (or reuse the generic `start-minecraft` etc.).
3. Add the server's `collectMetrics` call to the `collect-game-metrics` workflow.
4. `swamp workflow run setup-game-metrics --input '{"vmName":"X"}'` — node_exporter + textfile collector.
5. `swamp workflow run configure-monitoring --input '{"vmName":"X"}'` — register with Prometheus hub.
6. `swamp workflow run deploy-bot` — bot auto-discovers game servers at startup.
7. Update CLAUDE.md / this file's workflow + instance tables.

## PXE Infrastructure

- **TFTP server**: 10.0.0.191 (vmid 103) — serves kernel + initramfs via TFTP at `/tftp/`
- **HTTP server**: same box (lighttpd) — serves apkovl + modloop at `/srv/http/alpine/`
- **Gold-image VM**: vmid 109, name `gold-image` — PXE-booted diskless Alpine
- **Overlay file**: `/srv/http/alpine/alpine.apkovl.tar.gz`
- **Deploy workflow**: `swamp workflow run deploy-apkovl` (start gold-image → `lbu package` → SCP to HTTP server)
- **Slate setup**: `config/slate-setup-alpine.conf` — Alpine `setup-alpine` answer file

## Game Metrics

Player metrics are collected via the `*/10` `collect-game-metrics` cron on slate. The workflow: auth → sync-fleet → `collectMetrics` on all game servers in parallel.

Each game server's `collectMetrics` method:
1. SSHes to the game VM to query live player count (tmux `list` for Minecraft, `playing` for Terraria)
2. Writes a `.prom` file to `/var/lib/node_exporter/textfile_collector/game_<type>.prom` on the game VM via SSH
3. Appends a JSON line to `/var/log/game-players.log` on the game VM
4. Writes a `metrics` swamp resource with the result

node_exporter runs on each game VM with `--collector.textfile.directory=/var/lib/node_exporter/textfile_collector`. Prometheus on hancock (10.0.0.12) scrapes each game VM's node_exporter at `:9100`.

**Key gotcha:** `sshHost` in minecraft/server GlobalArgs must be `z.string().nullable()` — when a VM is stopped, the fleet IP is null and Zod rejects non-nullable strings before the method even runs.

## Getting data from swamp

```bash
swamp data get fleet infinity          # full JSON for the infinity fleet resource
swamp data list fleet                  # list all named resources in the fleet model
swamp data list <modelName>            # list all data for any model
```

`swamp model get <name> --json` returns the **definition** (schema, globalArguments, methods) — NOT runtime data. Use `swamp data get` for runtime values.

## Extension-Authoring Gotchas

- CEL expressions always return strings — handle coercion in extension code (`parseInt`, `z.union([z.number(), z.string()])`).
- Extension model `version` must be CalVer string: `"YYYY.MM.DD.MICRO"` (e.g., `"2026.02.11.1"`).
- Don't use TypeScript optional params (`opts?`) in extension models — use `opts = {}`.
- `writeResource` is 4-arg: `writeResource(specName, instanceName, data)` or `writeResource(specName, instanceName, data, overrides)`.
- `writeResource` fields holding vault-derived values need `.meta({ sensitive: true })` or the SecretRedactor rewrites them to `***` (corrupting e.g. auth tickets → 401).
- Per-method args that come from workflow inputs (not definition YAML) must use `z.string().default("")` + a runtime guard (`if (!args.x) throw new Error("x is required")`) — swamp validates ALL method schemas at model load time, so a required field + empty `arguments: {}` bricks the whole model. If a definition has no static per-method arguments, omit the `methods:` block entirely.
- `lib/` files under `swamp/extensions/models/lib/` are loaded as potential models — no TS `interface`, type annotations on params, or `const x: Type`. Use untyped function params.
- `modelIdOrName` in workflow steps does NOT evaluate CEL — only static strings. forEach `self.*` works in step names/task inputs, not in `modelIdOrName`. For per-model dispatch use explicit steps.
- VMs need `qemu-guest-agent` installed and `agent: 1` in Proxmox config for IP discovery.
- Workflow step `inputs` pass runtime values, overriding per-method arguments.
- Definitions use `globalArguments:` for shared config, `methods.<name>.arguments:` for per-method args. Execute signature: `execute(args, context)` — method args in `args`, global args in `context.globalArgs`.
- Extension npm deps are bundled (not lockfile-tracked) — pin explicit versions in `npm:` specifiers.

### Minecraft server startup failures
- `startMinecraftServer` tees start.sh output to `/tmp/mc-start-<tmuxSession>.log` on the VM — read it first if the server crashes before becoming ready.
- Common culprit: bad JVM flags in `variables.txt` JAVA_ARGS (e.g. `-XX:+PrefetchCopyIntervalInBytes=512` should be `-XX:PrefetchCopyIntervalInBytes=512` — no `+`). Also check `SERVERSTARTERJAR_FORCE_FETCH` (re-downloads server.jar every start if `true`).

### Alpine promtail
- Package is `loki-promtail` + `loki-promtail-openrc` (NOT `promtail`); service is `loki-promtail` on edge/3.5.x, but `promtail` on allthemons' older stable (loki-promtail 2.9.4-r7). Default config `/etc/loki/promtail-local-config.yaml`. Use `apk info -e <pkg>` to check if actually installed.
