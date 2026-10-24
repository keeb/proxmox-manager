# Worker-Fleet Architecture — Design

**Status:** Proposed · **Date:** 2026-07-06 · **Owner:** keeb

A deliberate redesign of how slate (and the rest of the VM fleet) operates:
retire the fat-client / hand-rolled-cron model and move to a single
**orchestrator** with the VMs as a **worker fleet**, scheduled work as workflow
**triggers**, and idle VMs as **scale-from-zero** capacity.

This is a design document, not a runbook. It states the target, the reasoning,
the explicit decisions, and a phased migration — so the architecture is chosen,
not emergent.

---

## 0. Terminology — two things called "fleet"

Get this straight before reading further; the collision is real and unavoidable.

| Term | Meaning here |
|------|--------------|
| **VM fleet** (`fleet` model) | Our existing Proxmox concept: one `fleet` definition holding every VM as a named resource. Storage/inventory shape. |
| **Worker fleet** (swamp) | A pool of swamp *workers* sharing one enrollment token, auto-labeled `fleet=<token>`. Compute shape. |

**The thesis of this design is that these two should become the same population:**
every VM in the VM fleet is also a member of a swamp worker fleet. "Fleet" stops
being just an inventory list and becomes an execution substrate.

---

## 1. Current architecture — the fat client

Today **slate is a second orchestrator**. `/opt/proxmox-manager` carries a full
copy of the durable world, and slate runs `swamp` locally as a co-equal
authority against the shared Mongo on hancock.

```
   laptop (keeb@think.tank)            slate (10.0.0.33, vmid 100)
   full repo + binary + vault          full repo + baked binary + vault + auth
   + auth + catalog                    + catalog  (discord-bot:latest image)
        │                                    │
        │   swamp (local authority)          │   Alpine crontab:
        │                                    │     */10 collect-game-metrics  (docker run --name)
        └──────────────┬─────────────────────┤     0 *  fleet-report          (docker run --name)
                       │  BOTH contend the    │     5 8  post-fleet-report
                       ▼  global Mongo lock   │     0 8  mms-inventory
              ┌─────────────────────┐         │
              │ hancock 10.0.0.12   │◀────────┘   discord-bot container (long-running):
              │ MongoDB datastore   │               bot/main.ts → Deno.Command("swamp", ...)
              │ (db swamp, keeb)    │               cwd /opt/proxmox-manager/swamp
              └─────────────────────┘
```

Two authorities, one lock. slate needs its own copy of everything, so deploying
to it means **syncing the whole world**.

### Every slate pain is a symptom of "slate is a durable authority"

| Symptom (from incident history) | Root cause |
|---|---|
| `deploy-bot` is ~11 steps, **5 of them syncs** (code, bot, binary, secrets, auth) | slate needs its own copy of the world |
| syncCode `--delete` clobbers `_extension_catalog.db` / `pulled-extensions/` / `.swamp-sources.yaml` | slate holds catalog state |
| binary update = sync **+ rebuild image + restart** | binary baked into image, not dispatched |
| `slate-cron-name-wedge` — `docker run --rm --name` blocks all future ticks | crons are hand-rolled Docker wrappers |
| `leaderboard-frozen` — `timeout 240` kills the datastore push | crons are crontab lines with a guillotine |
| global-lock contention (laptop run fails a slate tick) | **two** authorities, one Mongo lock |
| `setup-fleet-report` SSHes crontab lines into `/etc/crontabs/root` | the scheduler lives in Alpine cron |
| 200-line `fleet-report.sh` doing `swamp data get ... \| awk \| sed \| jq` | reporting bypasses the model layer |

The crons are a shadow orchestrator built out of shell. The whole point of the
redesign is to delete that shadow.

---

## 2. What we're building on (shipped vs. needs-upgrade)

Remote execution and worker fleets are real swamp features, but they arrived in
two waves. **This design is honest about which wave the installed binary
(`20260206…`) is in**, because the migration phases depend on it.

| Capability | In installed binary? | Notes |
|---|---|---|
| `swamp serve` with scheduled execution (on by default; `--no-schedule` to disable) | ✅ yes | `ScheduledExecutionService`; needs `HOME` set in the service unit or pulled extensions fail with "Unknown model type" |
| `trigger.schedule` / `trigger.inputs` in workflow YAML | ✅ yes | |
| Webhook triggers | ✅ yes | |
| `swamp worker connect` with `--label`, `--cache-dir` | ✅ yes | labeled workers, stable machine id |
| `swamp worker token` / `swamp worker list` | ✅ yes | |
| **Fleet tokens** (`--max-enrollments N\|unlimited`, auto `fleet=` label) | ❌ **no** | needs binary upgrade |
| **`swamp worker queue`** / elastic queueing / scale-from-zero | ❌ **no** | needs binary upgrade |
| **Drain policies** (`--idle-timeout`, `--max-dispatches`, SIGTERM 300s grace) | ❌ **no** | needs binary upgrade |
| Placement `queueTimeout`, `swamp worker daemon` | ❌ **no** | needs binary upgrade |

**Consequence for the plan:** Phase 1 (orchestrator + scheduler + one labeled
worker) is buildable on today's binary. Phases 2–3 (fleet token, scale-from-zero)
require a binary upgrade first — which reclassifies "update swamp" from chore to
explicit prerequisite, tracked as its own phase.

Reference: the worker-fleets manual lives in the swamp-club site repo under
`content/manual/explanation/worker-fleets.md` and `content/manual/how-to/worker-fleets/`.

---

## 3. Target architecture

```
                 ┌──────────────────────────────────────────────┐
                 │  ORCHESTRATOR — swamp serve on hancock         │
                 │  (always-on box; already holds Mongo + Grafana)│
                 │                                                │
                 │  repo · datastore · vault · catalog · locks ·  │
                 │  SCHEDULER · webhook triggers · audit · tokens │
                 └───▲───────────────▲────────────────▲───────────┘
   ws+h2, worker-    │               │ trigger.schedule│ swamp CLI --server
   initiated,        │               │ (in workflow    │ (SWAMP_SERVE_URL)
   outbound          │               │  YAML)          │
             ┌───────┴────────┐  ┌───┴─────────────┐  ┌┴───────────────────┐
             │ WORKER FLEET   │  │ SCHEDULED WORK  │  │ discord-bot         │
             │ = the VM fleet │  │ collect-game-   │  │ = thin client       │
             │ one fleet token│  │ metrics,        │  │ discord.js + swamp  │
             │ baked in gold  │  │ fleet-report =  │  │ binary in --server  │
             │ image; each VM │  │ trigger.schedule│  │ mode; only          │
             │ self-enrolls,  │  │ workflows,      │  │ DISCORD_TOKEN in env│
             │ labeled        │  │ per-VM steps    │  └─────────────────────┘
             │ fleet=game-... │  │ PLACED on fleet │
             └────────────────┘  └─────────────────┘
```

- **Orchestrator** is the sole durable authority. One lock owner. One place that
  holds repo/vault/catalog/secrets.
- **VMs are workers.** They carry no repo, no vault, no catalog, no baked binary
  — "a binary, a token, and a URL." Dispatched code and every data write proxy
  home.
- **Scheduled work is declarative** (`trigger.schedule`), owned by the
  orchestrator's scheduler — no crontab, no `docker run --name`, no `timeout`.
- **The bot is a thin client** pointed at the orchestrator via `--server`.

### Why this is worth doing (beyond deleting incidents)

§1 frames the change as *removing pain*. The affirmative value — what a fleet
positively buys this repo — is three things, and it is worth naming which of
them actually apply so we don't import a rationale that isn't real here:

1. **Compute location decoupled from state location.** The step that reads a
   game's player count runs *on that game's VM*; the datastore still lives at the
   orchestrator. Work happens where it physically wants to be (the box with the
   game, the disk, the mount) while state stays central.
2. **Fan-out output is durable, versioned swamp data** — not ephemeral shell in
   a cron. Metrics and audit accumulate as queryable model data, which is the
   `swamp data get`/`list` idiom this repo already runs on.
3. **Elastic capacity** — idle VMs are free workers; booting one adds capacity
   (D5, §6).

**What does *not* apply:** egress multiplexing (many workers = many source IPs
against a per-IP rate limit) is a real fleet win in repos that scrape rate-limited
third parties — it is **not** a reason here. The Proxmox API is a single internal
endpoint; our reason for many workers is compute-location and elastic capacity,
not IP spread.

---

## 4. Design decisions (the deliberate part)

Each decision states the choice, the alternatives, and why — so future changes
argue against a recorded rationale instead of re-deriving from scratch.

### D1 — Orchestrator lives on hancock
**Choice:** run the single `swamp serve` on hancock (`10.0.0.12`).
**Alternatives:** keeb-dev-02 (the auth root); slate itself.
**Why:** hancock is a separate always-on physical box already holding the Mongo
datastore and Grafana. keeb-dev-02 has nothing auto-start on it (per the
power-outage runbook) and would make the orchestrator as fragile as the laptop.
The orchestrator must outlive any single workstation.
**Cost:** hancock becomes more load-bearing; its `swamp serve` unit must pin
`HOME` (else pulled `@keeb/*` extensions fail to load on scheduled runs).

### D2 — The VM fleet IS the worker fleet, provisioned by the gold image
**Choice:** one `fleet=game-servers` (and similar) fleet token, baked into the
gold image (vmid 109) so every PXE'd VM self-enrolls on boot.
**Alternatives:** per-VM tokens (one token per machine); no workers, keep SSH.
**Why:** per-VM tokens reintroduce the provisioning ceremony fleets exist to
kill. Baking enrollment into the gold image means the population of workers is,
by construction, the population of VMs — the two "fleets" converge with zero
per-machine config.
**Blocked on:** fleet tokens (`--max-enrollments`) — needs binary upgrade (§2).

### D3 — Scheduled work is `trigger.schedule`, never crontab
**Choice:** `collect-game-metrics`, `fleet-report`, `post-fleet-report`,
`mms-inventory` become workflows with a `trigger.schedule` block, run by the
orchestrator scheduler.
**Alternatives:** keep the Alpine crontab; use host systemd timers.
**Why:** every cron incident (name-wedge, timeout-kills-push, drifted crontab,
SSH-injected install) is a property of running the scheduler as shell on slate.
Moving it into the orchestrator deletes the entire class. The schedule becomes
versioned, in-repo, and lock-serialized.

### D4 — Per-VM work is *placed*, not SSH'd
**Choice:** steps that must run on a specific VM use placement `labels:` and run
in-process on that VM's worker. Retire `testVmSsh exec` / `sshExec` for these
paths.
**Alternatives:** keep SSHing from the orchestrator into each box.
**Why:** placement is the mechanism that makes "the fleet member is the compute"
expressible. Game metrics collected on the game VM; no guest-agent IP dance, no
tee-to-`/tmp`-then-cat-back. Data writes proxy home to the one datastore.
**Note:** ad-hoc SSH (`ssh/host`) stays for genuinely out-of-band ops
(bootstrap, a box with no worker yet). Placement replaces the *routine* per-VM
steps, not all SSH.

### D5 — Idle VMs are scale-from-zero workers
**Choice:** a stopped VM is a worker that isn't connected. Steps placed on it
**queue** (with `queueTimeout: 0` where an external actor guarantees a boot)
until the VM comes up and its worker enrolls.
**Alternatives:** fail-fast if the VM is down; keep all VMs running.
**Why:** the dataflow snapshot shows 7 of 10 VMs `stopped`. Idle workers cost
nothing because they aren't connected; the queue absorbs the boot gap. This is
the elastic-capacity model the architecture has implicitly wanted.
**Blocked on:** elastic queueing / `swamp worker queue` — needs upgrade (§2).

### D6 — The bot is a thin `--server` client (interim), webhook later
**Choice (now):** the bot stays a Deno process but its `swamp` calls run in
`--server` mode against the orchestrator; container drops the repo/vault mounts
and holds only `DISCORD_TOKEN`.
**Choice (later):** Discord interactions POST to a webhook trigger; the
long-running bot process largely disappears.
**Why:** the bot is the one genuinely long-lived, event-driven actor — not a
scheduled workflow. The `--server` move removes its fat-client-ness immediately
and cheaply; the webhook rearchitecture is a larger lift deferred until the
foundation is proven.

### D7 — Grace period is 5 minutes, not 30
**Choice:** worker drain grace (SIGTERM → finish in-flight → exit 0) is 300s.
**Why:** a step may be a minecraft start/stop that legitimately takes minutes. A
30s window kills steps mid-execution and loses results — the same failure shape
as the old `timeout 240`. The 5-minute grace is the well-behaved replacement.

### D8 — Placement over fan-out for single-endpoint / single-disk work
**Choice:** work that funnels through one shared resource is **pinned by label to
one worker**, never fanned out across the fleet.
**Applies to:** `fleet.sync` (hits the *single* Proxmox node API,
`GET /nodes/keeb-dev-02/qemu` — a list call against one endpoint); the **infinity
modpack COW pipeline** (single-disk copy-on-write on one VM).
**Why:** fanning these out multiplies contention on one spindle / one API for
zero gain — parallelism where the bottleneck is a shared resource, not swamp
inputs. Elastic queueing makes pinning *safe*: if the target worker is briefly
down (reboot, remount) the step **queues** for it instead of running in the wrong
place or failing. The pin becomes a correctness constraint (a step *cannot*
dispatch where the resource isn't), not a manual restart.
**Rule of thumb:** fan out the CPU/Claude/independent-per-VM half; *place* the
I/O-bound / single-endpoint half. Keep the two shapes separate.

---

## 5. Component-by-component: what changes

| Component today | Fate under this design |
|---|---|
| `deploy-bot` (11 steps, 5 syncs) | **Gutted.** No repo/vault/auth/catalog/binary on slate → `sync-code`, `sync-bot`, `sync-binary`, `sync-secrets`, `sync-auth`, `build-image` have nothing to sync. Deploy = orchestrator has new code; workers pull per-dispatch. |
| `swampRepo`, `slateDocker` models | Mostly obsolete; retained only if the bot container image still needs building. |
| Alpine crontab + `setup-fleet-report` | **Deleted.** Replaced by `trigger.schedule` in workflow YAML. |
| `fleet-report.sh` (200 lines of `awk\|sed\|jq`) | **Deleted.** Report reads `swamp worker list` / `worker queue` + fleet data models (model layer, per CLAUDE.md rules). |
| `collect-game-metrics` per-server steps | Per-VM step **placed** on `fleet=game-servers`; runs on the box. |
| `testVmSsh exec` in routine workflows | Replaced by placement (D4); `ssh/host` kept for bootstrap only. |
| discord-bot container | Thin `--server` client (D6); only `DISCORD_TOKEN` in env. |
| Global-lock contention | Gone — orchestrator is the sole authority; laptop is just a client. |

---

## 6. Scale-from-zero flow (chat-driven boot)

The concrete payoff of D2+D5, once the fleet-token/queue binary lands:

```
  player: !start atm10
        │
        ▼
  bot (--server) → orchestrator: run start-atm10 workflow
        │
        ▼
  step "run-minecraft"  labels{fleet: atm10-pool}  queueTimeout: 0
        │  no worker connected (VM is stopped) → step QUEUES
        ▼
  step "boot-vm"  fleet.start(atm10)   ← runs on orchestrator/loopback
        │
        ▼
  VM boots → gold-image-baked worker dials home → enrolls, labeled fleet=atm10-pool
        │  orchestrator evaluates queue on enrollment event (no polling)
        ▼
  queued "run-minecraft" step DISPATCHES immediately, in-process on atm10
```

Stopped VMs are free capacity. Booting one is how you add a worker.

---

## 7. Constraints & open questions

- **C1 — Token distribution is out-of-band.** Workers are repo-less and resolve
  the enrollment token from CLI/env, *not* from `proxmox-vault` (vault-based
  resolution is a planned swamp enhancement, not yet shipped). So the fleet
  token must reach each VM via cloud-init / gold-image bake / a host secret —
  distributed by something other than swamp vault. **Open:** where exactly does
  the gold image read the token from, and how is it rotated?
- **C2 — Binary upgrade is a hard gate for Phase 2+.** Fleet tokens, queueing,
  and drain policies are not in `20260206…`. **Open:** upgrade the orchestrator
  and the gold-image worker binary together; confirm the version that has all of
  `--max-enrollments`, `worker queue`, `--idle-timeout`.
- **C3 — hancock as SPOF.** One orchestrator = one failure domain. **Open:** is
  single-orchestrator acceptable, or do we want the datastore to survive an
  orchestrator restart cleanly (it should — state is in Mongo, but confirm
  scheduler/lease recovery on restart)?
- **C4 — HOME in the service unit.** `swamp serve`'s own help warns pulled
  extensions fail without `HOME` set. Must be in the systemd unit on hancock.
- **C5 — TLS / exposure.** Workers dial the orchestrator over `wss://`.
  hancock's serve endpoint needs TLS (`--cert-file`/`--key-file`) and possibly
  `--trusted-hosts` / `SWAMP_SERVE_EXTRA_HEADERS` if fronted by a tunnel.
  **Open:** cert story on the internal network.
- **C6 — Bot event-loop vs. worker.** The bot is long-running and event-driven;
  it is a *client*, not a worker. Confirm we don't conflate the two (the bot
  should not be `worker connect`).

---

## 8. Migration — phased, each phase independently valuable

**Phase 0 — Prereq: binary upgrade.** Upgrade swamp on the orchestrator host and
in the gold image to a build that has fleet tokens + `worker queue` + drain
flags (C2). Verify with `swamp worker queue --help` and `worker token create
--max-enrollments`. *Gate for Phases 3–4.*

**Phase 1 — Stand up the orchestrator (additive, no removal).** Run `swamp serve`
on hancock (HOME pinned, TLS). Points at the existing shared datastore. Nothing
else changes; everything keeps working. Prove the endpoint with one manual
`swamp workflow run --server`.

**Phase 2 — Move one schedule.** Convert `fleet-report` to a `trigger.schedule`
workflow on the orchestrator; disable the slate fleet-report cron. Lowest-risk
single cron; immediately kills name-wedge + timeout for that job. Prove the
pattern, then migrate `collect-game-metrics`, `mms-inventory`, `post-fleet-report`.

**Phase 3 — Enroll the fleet.** Bake the `fleet=game-servers` token into the gold
image; VMs self-enroll as labeled workers (D2). Re-express `collect-game-metrics`
per-VM steps as *placed* steps (D4). Retire routine `testVmSsh exec`.

**Phase 4 — Scale-from-zero.** Wire the chat-driven queue-then-boot flow (§6) for
one game VM as a proof of concept, then generalize. Add `--idle-timeout` for
auto-drain of idle workers.

**Phase 5 — Thin the bot & gut deploy-bot.** Repoint the bot to `--server`, drop
its repo/vault mounts (D6). Delete the sync-the-world half of `deploy-bot`,
`fleet-report.sh`, `setup-fleet-report`, and the Alpine crontab.

---

## 9. What gets deleted (the scorecard)

If this design lands fully:

- ✂ 6 of `deploy-bot`'s ~11 steps (all the syncs + image build)
- ✂ `setup-fleet-report` workflow (SSH-injected crontab)
- ✂ `fleet-report.sh` (200-line shell report)
- ✂ the entire Alpine crontab on slate + every `docker run --name` wrapper
- ✂ `swampRepo` / `slateDocker` (unless kept for bot image build)
- ✂ routine `testVmSsh exec` steps
- ✂ global-lock contention as a failure mode
- ✂ the whole "update binary = sync + rebuild + restart" ritual

…and the corresponding incident classes stop being possible by construction.

---

## 10. Further reading

- swamp manual — `content/manual/explanation/worker-fleets.md`,
  `content/manual/how-to/worker-fleets/{docker,docker-compose,kubernetes,scale-from-zero}.md`
  (in the swamp-club site repo)
- swamp design — `design/remote-execution.md` (orchestrator/worker model)
- [sync-fleet-dataflow.md](./sync-fleet-dataflow.md) — how the VM fleet is
  synced today
- [../CLAUDE.md](../CLAUDE.md) — current slate/deploy/cron mechanics
