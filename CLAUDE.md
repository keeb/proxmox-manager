# Proxmox Manager

Model-driven VM lifecycle automation on Proxmox, a Discord bot exposing game-server control via chat, and PXE infra for diskless Alpine VMs. All managed with [swamp](https://github.com/systeminit/swamp).

## Job loop
Interpret intent → run a swamp workflow or model method → verify with `swamp data get` / `swamp data list`. Swamp is the runtime *and* the API to the infrastructure; everything happens through it. Don't `curl`/`ssh`/hit the Proxmox API from the shell to read or change state — query swamp data, or add a method to the model. (`fetchWithCurl`/`sshExec` *inside* an extension model is the sanctioned HTTP/SSH layer.)

Run from the swamp repo root: `cd ~/git/proxmox-manager/swamp`. Prefer default log output; use `--json` only when piping.

## Rules
1. **Models over shell.** Never `curl`/`ssh`/raw-API from the CLI. Missing capability → add a method to the extension model. One method, one purpose, typed in/out.
2. **Verify vmid before any destructive op.** `swamp data get fleet <vm>` and check vmid before delete/stop/destroy. Never trust the name alone.
3. **CEL wires models.** `data.latest("fleet", "<vm>").attributes.ip` (known) · `data.latest("fleet", inputs.vmName).attributes.ip` (dynamic) · `vault.get("proxmox-vault", "<key>")` (secrets).
4. **Fleet-centric.** One `fleet` definition holds every VM as a named resource (`writeResource("vm", vmName, …)`). Don't make a definition per VM.
5. **Data accumulates.** Every method writes versioned, immutable data — the audit trail. Reference existing data; don't re-fetch.

## Workflows (compile targets)
`swamp workflow run <name>`. ~42 total — full table in [REFERENCE.md](./REFERENCE.md). The ones you reach for:
- **Game servers** (also driven by the bot): `start-minecraft`/`stop-minecraft`/`reboot-minecraft`/`status-minecraft` (`--input vmName=… tmuxSession=… serverDir=… startScript=… logPath=…`); `start-calamity`/`stop-calamity`/`reboot-calamity`/`status-calamity`/`update-calamity` (Terraria).
- **VM lifecycle:** `sync-fleet`; `start-vm`/`stop-vm`/`create-vm`/`delete-vm` (`--input vmName=…`); `create-stateful-vm`.
- **Deploy:** `deploy-bot` (full bot deploy to slate), `deploy-grafana`, `deploy-apkovl`.
- **Infinity modpack:** `check-infinity-update`, `deploy-infinity-modpack`, `rollback-infinity-modpack --input fileId=…`, `list-infinity-modpacks`.

## When the user wants to deploy the bot / update the swamp binary on slate
The bot and the slate crons (`game-metrics`, `fleet-report`) run swamp **from the `discord-bot` Docker image**, which bakes the binary in at build time (`bot/Dockerfile`: `COPY swamp /usr/local/bin/swamp`). Containers run the *image's* `/usr/local/bin/swamp` — **not** the binary on the mounted `/opt/proxmox-manager` volume. So updating the binary is sync + rebuild:

1. `swamp model method run swampRepo syncBinary` — copies local `which swamp` → `/opt/proxmox-manager/bot/swamp` on slate. **No effect on any container yet** — just a file on disk.
2. `swamp model method run slateDocker build` — bakes `bot/swamp` into `discord-bot:latest`.

After the rebuild:
- **`game-metrics` + `fleet-report` crons auto-pick-up** the new binary on their next tick (each tick is a fresh `docker run` off `discord-bot:latest`). Nothing to restart.
- **The long-running `discord-bot` container does not** — it keeps the old image until restarted (`start-bot` step, or a full `deploy-bot`).

Full deploy (code + bot + binary + secrets + image + bot restart): `swamp workflow run deploy-bot`.

⚠️ **Running local `swamp` against this datastore contends the global lock with the live slate crons** — a long local method can fail a `collect-game-metrics` tick (`Lock held by keeb@think.tank`). Fine for one-offs; don't leave local runs going when you care about cron continuity.

## When the user wants to update the infinity modpack
`check-infinity-update` (find latest fileId) → `deploy-infinity-modpack` (full copy-on-write pipeline) → `list-infinity-modpacks` / `swamp data get infinityServerPack snapshot` to verify. Rollback: `rollback-infinity-modpack --input fileId=<id|preexisting>`. COW layout + Alpine/Java gotchas in [REFERENCE.md](./REFERENCE.md).

## When the user wants to add a new game server
Reuse `minecraft/server` / `terraria/server`, wire workflows, `setup-game-metrics` + `configure-monitoring`, add to `collect-game-metrics`, then `deploy-bot` (the bot auto-discovers game servers at startup). Full checklist in [REFERENCE.md](./REFERENCE.md).

## When the user wants to know what's running / diagnose
- Runtime state: `swamp data get fleet <vm>` · `swamp data list fleet` · `swamp data list <model>`.
- Datastore health / namespaces / locks: inspect from `~/git/mongo-stats` — `swamp model method run treehouse datastore_stats`. Live lock: `swamp datastore lock status`.
- slate is reachable at `root@10.0.0.33`; cron logs at `/var/log/{game-metrics,fleet-report}.log`.

## Infrastructure facts
- **Datastore:** shared MongoDB on **hancock** (`10.0.0.12`, db `swamp`, tenant `keeb`). Namespace `proxmox-manager` is written by *both* this repo and slate's `/opt/proxmox-manager` (the `*/10 collect-game-metrics` cron); `fleet-report` is a separate namespace written by slate's hourly cron. See [REFERENCE.md](./REFERENCE.md#datastore--namespaces).
- **slate** (`10.0.0.33`) — Docker host for the bot + crons (`*/10` collect-game-metrics, `0 *` fleet-report, `5 8` post-fleet-report, `0 8` mms-inventory).
- **hancock** (`10.0.0.12`) — Prometheus + Grafana + the Mongo datastore; separate physical box.
- **PXE:** TFTP/HTTP box `10.0.0.191` (vmid 103); gold-image VM vmid 109.
- **Auth root:** `keebDev02` (`proxmox/node`); every workflow starts with `keebDev02.auth`.
- The swamp binary version `20260206…-sha.` is a **dev-build name artifact, always current** — not stale; ignore "swamp repo upgrade" warnings as a version signal.

## Reference
- [REFERENCE.md](./REFERENCE.md) — full workflow/model/instance tables; auth/fleet/annotation patterns; deploy, datastore, cron, modpack, PXE, and metrics mechanics; extension-authoring gotchas.
- Model params & schemas: `swamp model method describe <model>` · `swamp model get <name> --json` — fetch, don't memorize. (`swamp data get` for runtime values; `swamp model get` for the definition.)
- Memory: `~/.claude/projects/-home-keeb-git-proxmox-manager/memory/` — operational learnings & incident history.
- swamp project rules & skills: [swamp/CLAUDE.md](./swamp/CLAUDE.md).
