# JIT Seedbox as a Cloud Worker Fleet — Design

**Status:** Proposed · **Date:** 2026-07-06 · **Owner:** keeb

Replace the always-on $50/mo DigitalOcean seedbox with **ephemeral droplets that
exist only while a download is running**, provisioned by the same orchestrator
that runs the Proxmox fleet, reproducing treehouse's existing transmission
pipeline exactly, and destroyed the instant the download lands on nami.

Builds on [worker-fleet-architecture.md](./worker-fleet-architecture.md) — this
is that document's "heterogeneous fleets" thesis made concrete: a **cloud**
fleet whose workers don't exist until a workflow provisions them.

---

## 0. The condensation

Three systems, one control plane:

```
        ORCHESTRATOR — swamp serve on hancock (always-on control plane)
        repo · datastore · vault · scheduler · locks · audit · DO API token
              │                    │                        │
   Proxmox VM fleet         swamp-media                JIT seedbox fleet (NEW)
   (game VMs, scale-        post-processing:            ephemeral DO droplets,
    from-zero workers)      drains media.jobs →         provisioned per download,
                            organize/move (pinned       destroyed on completion
                            worker near the disk)
                                    ▲                        │
                                    │   media.jobs queue     │
                                    └──── (MongoDB) ◀─────────┘
                                       the provider-agnostic seam
```

The insight from investigating treehouse: **`media.jobs` already decouples
"download happened" from "process it."** Downstream doesn't care whether the
torrent ran on treehouse or an ephemeral droplet. So JIT-ing the download half is
a drop-in — reproduce the pipeline, insert into `media.jobs`, done.

---

## 1. Ground truth — treehouse's pipeline (verified 2026-07-06)

Read directly off treehouse (`/etc/transmission-daemon/settings.json`,
`torrent-done-script.py`, mount table):

| Element | Value | Note |
|---|---|---|
| transmission | native systemd daemon, RPC :9091 | not containerized |
| `incomplete-dir` | `/mnt/local/incomplete` | in-progress on **local** disk (fast) |
| `download-dir` | `/mnt/nami/media/video/staging` | completed → **CIFS on nami** |
| nami mount | `//nami/storage` → `/mnt/nami`, cifs **vers=3.0**, `username=keeb`, addr `100.94.18.124` | **over Tailscale** |
| on-complete | `torrent-done-script.py` → insert into **MongoDB `media.jobs`** (`status: pending`) at `100.92.243.19` | the handoff queue |
| completion ordering | transmission moves local→CIFS **then** fires done-script | bytes on nami before the queue insert |
| mount definition | **none found** (not fstab/unit/cron/script) — hand-run runtime mount | fragility to fix |

Three data planes are in play and should stay distinct:
- **swamp datastore** (hancock, `10.0.0.12`, db `swamp`) — the orchestrator's world.
- **`media.jobs`** (`100.92.243.19`, db `media`) — swamp-media's app-level work queue.
- **CIFS bytes** on nami — the media itself.

---

## 2. The JIT droplet — what it reproduces

An ephemeral DO droplet is "treehouse's transmission role, cloud-hosted and
disposable." On boot (cloud-init / from a snapshot), it:

1. **Joins the tailnet** with an **ephemeral** Tailscale auth key (auto-removed
   from the tailnet on disconnect → destroyed droplets leave no stale nodes).
2. **Mounts CIFS** `//nami/storage` → `/mnt/nami` (vers=3.0, `username=keeb`),
   **defined declaratively in cloud-init** (fixing treehouse's non-reproducible
   mount).
3. Starts **transmission** with the *same* config: `incomplete-dir` on the
   droplet's local disk, `download-dir` = `/mnt/nami/media/video/staging`,
   `script-torrent-done` → the `media.jobs` insert (unchanged).
4. **Enrolls as a swamp worker** (`swamp worker connect`, fleet token via
   cloud-init env — *not* vault; see §4 C1) labeled `fleet=seedbox`.

The download runs on DO's fat pipe to local disk; on completion transmission
copies to the CIFS staging dir over Tailscale (the delivery), then the done-script
inserts into `media.jobs`. **At that moment the bytes are on nami and the droplet
has no further purpose → destroy.**

---

## 3. Lifecycle

```
  trigger: !download <magnet>  (bot → orchestrator)  OR  media "want" enqueued
        │
        ▼
  workflow: seedbox-download
    step provision   doDroplet.create (snapshot img, cloud-init user-data)  ← runs on orchestrator
    step add-torrent  transmission.addTorrent(magnet)   labels{fleet: seedbox}  queueTimeout: 0
        │  no worker yet → QUEUES; droplet boots, tailscales, mounts, enrolls
        ▼  worker connects → step dispatches in-process on the droplet
  droplet downloads → local disk (DO pipe)
        │  torrent completes → transmission moves local → /mnt/nami/.../staging (CIFS/Tailscale)
        ▼  torrent-done-script.py: insert media.jobs {status: pending}  +  signal orchestrator
  step teardown    doDroplet.destroy(this droplet)      ← bytes already on nami, safe
        │
        ▼
  swamp-media (separate, pinned worker) drains media.jobs → organize/move
```

Completion detection (recommended): the done-script hits a **webhook trigger** on
the orchestrator (event-driven, no polling) which fires the teardown. Fallback:
the workflow polls transmission RPC for `status=complete`.

---

## 4. Design decisions

### D1 — The droplet reproduces treehouse's pipeline verbatim
**Choice:** local `incomplete-dir` + CIFS `download-dir` on nami + the same
`torrent-done` → `media.jobs` insert.
**Why:** `media.jobs` is the provider-agnostic seam (§0). Reproducing it exactly
means **zero downstream change** — swamp-media's organize/move half neither knows
nor cares the download was ephemeral. Do not invent a new handoff.

### D2 — Destroy-on-complete (public / no ratio)
**Choice:** the torrent-done event is the teardown trigger; droplet dies
immediately after.
**Why:** trackers are public / no ratio obligation (confirmed), and transmission
delivers to CIFS *before* the done-script fires — so the bytes are on nami at
teardown time. No seeding tail, maximum savings. This is the purest JIT case.

### D3 — Ephemeral Tailscale nodes
**Choice:** droplets join with an ephemeral auth key.
**Why:** destroyed droplets must not accumulate as dead tailnet peers. Ephemeral
keys auto-deregister on disconnect. Pair with a tailnet ACL tag limiting the
droplet to only nami's SMB port (`445`) and the orchestrator's serve endpoint —
a torrent box on the public internet should reach nothing else.

### D4 — Orchestrator holds the DO token; droplet holds none
**Choice:** `doDroplet.create/destroy` run on the orchestrator (loopback), which
alone holds the DO API token (in vault). The droplet gets only: Tailscale
ephemeral key, CIFS creds, swamp fleet token — via cloud-init.
**Why:** a public-internet torrent box holding cloud-provider API creds is a
blast radius. The droplet cannot self-provision or self-destroy; the orchestrator
is the control chokepoint. Aligns with swamp-media's "isolation for adversarial
ingest" — torrents are adversarial content.

### D5 — Orphan reaper (cost safety net)
**Choice:** a scheduled workflow (`trigger.schedule`, e.g. every 15 min) lists DO
droplets tagged `jit-seedbox`, and destroys any older than N minutes with no
active torrent / no matching in-flight workflow run.
**Why:** the entire point is saving money. A droplet that fails to tear down
(crash, network partition, missed webhook) bills silently and defeats the goal. A
reaper makes runaway cost impossible by construction. Supply/demand is queryable
(`swamp worker list`, and DO's droplet list) — the reaper is just the
measure-then-act idiom.

### D6 — Fix the mount: declarative in cloud-init
**Choice:** the droplet's CIFS mount is defined in cloud-init from vault-sourced
creds, not hand-run.
**Why:** treehouse's mount is undefined anywhere on disk (§1) — unreproducible
and fragile. The ephemeral model *forces* a declarative mount (a fresh box every
time), turning a latent liability into a designed property. (Worth backporting to
treehouse regardless.)

### D7 — Provider is swappable
**Choice:** `doDroplet` is a thin DO-API model; the workflow depends on a generic
"provision a labeled seedbox worker" step shape, not on DO specifics.
**Why:** cost is the explicit goal, and Hetzner CX/CPX are ~⅓ of DO for the same
specs. Keeping the provisioner behind a clean method boundary means switching
providers is a new model, not a redesign. (DO first, per current setup.)

---

## 5. Components to build

| Component | What | Notes |
|---|---|---|
| `doDroplet` model | swamp extension: `create` / `destroy` / `list` / `snapshot` via `fetchWithCurl` to DO API | DO token in vault; runs on orchestrator only |
| Seedbox image | DO snapshot (or cloud-init) with transmission + tailscale + cifs-utils + swamp binary, and the treehouse transmission config | snapshot ⇒ fast boot; cloud-init ⇒ no snapshot cost |
| `seedbox-download` workflow | provision → add-torrent (placed `fleet=seedbox`, `queueTimeout: 0`) → teardown | webhook-triggered teardown from done-script |
| `seedbox-reaper` workflow | `trigger.schedule` orphan sweep (D5) | cost safety net |
| Fleet token | `seedbox` fleet token (`--max-enrollments`) | **needs binary upgrade** — see worker-fleet doc §2 |
| Done-script addition | existing `torrent-done-script.py` + a webhook POST to the orchestrator | keep the `media.jobs` insert unchanged |

---

## 6. Cost model (locked to the decisions)

| | Cost |
|---|---|
| **Today** | $50/mo flat, ~730 hrs mostly idle |
| JIT droplet | capable box ≈ $0.07–0.12/hr × actual download hours (~30–60/mo) → **$2–7/mo** |
| Bandwidth | inbound torrent = **free** on DO; delivery-to-nami within included transfer → ~$0 |
| Storage | **$0** ephemeral (no block volume; destroy before it bills); optional snapshot ≈ $0.15/mo |
| **Est. total** | **~$3–8/mo** — a 6–15× cut, contingent on genuinely bursty use |

Savings are real *because* it's public/no-ratio (D2): no seeding tail keeping the
box alive. Hetzner (D7) would roughly third the droplet line again.

---

## 7. Constraints & open questions

- **C1 — Token distribution is out-of-band.** Workers are repo-less; the fleet
  token, Tailscale key, and CIFS creds reach the droplet via cloud-init/DO
  user-data or a DO-side secret, **not** `${{ vault.get() }}` on the worker. The
  orchestrator reads them from vault and *bakes them into the dispatch*; the
  droplet never queries vault. (Vault-based worker token resolution is
  planned-future in swamp.)
- **C2 — Binary upgrade gates fleet tokens.** `--max-enrollments` / `worker
  queue` / drain flags are not in the installed `20260206…` build (see
  worker-fleet doc §2). Single-droplet + per-token works today; the *fleet* shape
  needs the upgrade.
- **C3 — Does treehouse stay or retire?** Its config is the template either way.
  Open: is treehouse a redundant local downloader that JIT droplets replace, or
  does it keep a distinct role? (Determines whether this *removes* a box or just
  the $50 DO one.)
- **C4 — Trigger source / the "want" queue.** `media.jobs` is *downstream* (after
  download). What enqueues a download *upstream*? Options: bot `!download`;
  swamp-media ingest auto-enqueues discovered items into a new "wants" collection
  the `seedbox-download` workflow consumes. Open decision.
- **C5 — Keep `media.jobs` (Mongo) vs. fold into swamp data.** The app queue and
  swamp's worker-queue are different layers. Recommendation: leave `media.jobs`
  as the app contract; don't force it into the swamp datastore.
- **C6 — CIFS write path over Tailscale for the final move.** Transmission's
  local→CIFS copy on completion is one sequential bulk write (fine), unlike
  torrent random writes (which stay local). Confirm throughput of the
  nami-over-Tailscale link is acceptable for the delivery step.
- **C7 — Tailnet ACLs.** Lock the `jit-seedbox` tag to nami:445 + orchestrator
  only (D3). Open: exact ACL policy.

---

## 8. First move

Prove the building block before wiring the fleet, isolation, or the reaper:

1. Stand up the orchestrator (worker-fleet doc, Phase 1) if not already.
2. Write `doDroplet.create` / `.destroy` (DO token in vault); manually create and
   destroy one droplet from a workflow — validate the DO-API model.
3. Bake one seedbox image (transmission + tailscale + cifs + swamp) and confirm a
   booted droplet mounts nami over Tailscale and downloads one torrent to
   `/mnt/nami/media/video/staging`, firing the existing `media.jobs` insert.
4. Only then: wrap it in `seedbox-download` with placement + destroy-on-complete,
   and add the reaper.

Validates provision → download → deliver → destroy end-to-end on real infra
before adding fleet tokens, isolation hardening, or an upstream want-queue.

---

## 9. Further reading

- [worker-fleet-architecture.md](./worker-fleet-architecture.md) — the
  orchestrator + heterogeneous-fleet foundation this builds on
- swamp manual — `content/manual/how-to/worker-fleets/scale-from-zero.md` (the
  bursty/queue pattern), `.../docker.md` (containerized worker)
- swamp-media `ideas.md` — the sister analysis (egress multiplexing, pin-don't-
  fan-out, autoscaler-as-workflow) that this repo's fleet thinking parallels
