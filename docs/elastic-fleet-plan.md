# Elastic Fleet — Plan & Working Notes

**Status:** Active / evolving · **Started:** 2026-07-06 · **Owner:** keeb

The living checkpoint for the central plan: one self-orchestrating fleet that
grows and shrinks to serve disparate swamp workloads. This is the thinking
document — decisions, open questions, and where we left off. The two concrete
design docs it sits above:

- [worker-fleet-architecture.md](./worker-fleet-architecture.md) — retire slate's
  fat-client model; orchestrator on hancock; VMs as scale-from-zero workers;
  crons → triggers.
- [jit-seedbox-fleet.md](./jit-seedbox-fleet.md) — ephemeral DO droplets that
  reproduce treehouse's transmission pipeline and self-destroy on completion.

---

## The vision

The disparate workflows — game servers, media post-processing, seedbox downloads,
metrics, and automation tasks (e.g. issue triage) — are **demand**. They stay
disparate; they don't know about each other. Underneath them is **one elastic
fleet** that reconciles *supply* to that demand: it grows and shrinks capacity as
needed to facilitate whatever work shows up, then releases it.

The fleet is not three systems. It's one control loop over heterogeneous compute.

---

## The fleet is a control loop

A reconciling autoscaler has four parts. Swamp gives three natively:

| Part | What it is | Status |
|---|---|---|
| **Demand** | pending work + the capability each item needs | ✅ `swamp worker queue` (+ webhook events, + `media.jobs`) |
| **Supply** | connected workers, labels, free slots | ✅ `swamp worker list` (queryable data models) |
| **Actuator** | create/destroy capacity | ✅ `fleet.start/stop` (Proxmox), `doDroplet.create/destroy` (cloud) — just models |
| **Controller** | reconcile supply → demand | ⛏ **the piece we're building** |

The missing controller is two things:

1. **A substrate-provisioner abstraction** — a uniform "give me a worker of class
   X / destroy this worker" interface that Proxmox VMs, DO droplets, Hetzner, and
   containers all implement, each carrying a **cost + latency profile**.
2. **The reconciler** — read demand + supply, actuate to close the gap, with
   hysteresis and caps. Its decisions are themselves swamp data (audit + tuning).

---

## Decisions so far

### DEC-1 — `swamp serve` is the controller; webhooks + schedule drive it
The reconciler is not a separate process and not Kubernetes. **`swamp serve` is
the controller.** It already owns the datastore, scheduler, worker pool, queue,
and tokens — so it has native access to demand and supply with no bridge. This
keeps the invariant everything else depends on: **swamp is the world.**

Rejected alternatives: k8s + KEDA (a second control plane competing with swamp;
overkill at current scale) and a standalone custom reconciler (write it later
only if serve proves too coarse — build the logic liftable).

### DEC-2 — Schedule is the loop; webhooks are fast-path edges into it
swamp triggers **itself**. A scheduled tick — **"wake up → check queue →
dispatch"** — is the primary, level-driven reconcile heartbeat. It reads actual
state (queue depth + worker list vs. what's running) and re-converges, so it
self-heals missed events and reaps orphans by design.

Webhooks are **not** a separate mechanism — they're low-latency edges that fire
the *same* "check queue → dispatch" evaluation for events you don't want to wait
a tick for (torrent-done, a bot command, a new issue). Because both paths run
identical logic against current state, the controller is **idempotent by
construction**.

```
   schedule tick ─┐
                  ├──▶  evaluate: read queue + worker list  ──▶  actuate (provision/destroy/dispatch)
   webhook edge ──┘        (level, not edge)                      idempotent vs. current state
```

### DEC-3 — Demand is one general work queue; workers run dispatched methods
The queue is **not** infra-specific. A worker runs whatever method is dispatched
to it, including agentic ones. "New lab issue arrives → dispatch a worker to run
`triage lab <issue_number>`" is the **same pattern** as "torrent-done → dispatch a
seedbox" — different capability label, identical mechanism. The fleet is a
**general task-execution substrate**, not just infra provisioning. (Issue triage
lines up with swamp's upstream issue-lifecycle work.)

### DEC-4 — Cost policy is tiered spillover (what makes this *ours*)
Two capacity tiers with very different cost curves: **local Proxmox VMs**
(already paid for, electricity-only, finite) vs. **paid cloud** (elastic,
metered). The objective is not "minimize instances" — it's:

> prefer already-running local → boot an idle local VM → spill to paid cloud only
> when local is exhausted **or** the work intrinsically needs cloud (e.g. the
> seedbox's fat egress pipe).

Cost-aware placement is the real design substance and is specific to us; no
off-the-shelf autoscaler encodes it.

---

## Capacity classes (sketch — to be nailed down)

Demand items are keyed by the capability they need; supply is labeled to match.
A rough taxonomy:

| Class | Example demand | Substrate | Placement |
|---|---|---|---|
| `game-vm:<name>` | `!start atm10` | local Proxmox VM (scale-from-zero) | boot the specific VM |
| `seedbox` | torrent-done / a "want" | ephemeral DO/Hetzner droplet | provision + destroy-on-complete |
| `media-pinned` | organize/dedup a completed download | the one worker on the media host | pinned, never fanned out |
| `task`/`agentic` | `triage lab <n>`, metrics fan-out | generic worker, cheapest tier first | any matching, least-loaded |

The reconciler keeps supply-per-class matched to demand-per-class, choosing the
cheapest satisfying substrate (DEC-4).

---

## Things the design must get right

- **Single-flight / idempotent reconcile.** Concurrent webhooks (and a webhook
  racing the scheduled tick) must not double-provision. The evaluation must be
  idempotent against current state; serialize/lease the decision.
- **serve gains an inbound surface.** Workers dial *out*; webhooks POST *in*. That
  means TLS, signature-verified webhooks, and `--trusted-hosts`. Fine over
  Tailscale, but a new exposure to get right.
- **Orphan safety = the scheduled tick.** A provision that fails to tear down
  bills silently (defeats the seedbox savings). The level-driven sweep is the
  backstop that makes runaway cost impossible.
- **`HOME` pinned in serve's unit** — else pulled `@keeb/*` extensions fail to
  load on scheduled runs ("Unknown model type").

---

## Gates & open questions

- **Binary upgrade gates the fleet layer.** Fleet tokens (`--max-enrollments`),
  `swamp worker queue`, and drain flags (`--idle-timeout`, `--max-dispatches`)
  are **not** in the installed `20260206` build. Serve + scheduler + webhook
  triggers + labeled `worker connect` **are** present today. Upgrade the
  orchestrator + gold-image worker binary together before the fleet phases.
- **Where the reconciler runs vs. hancock as SPOF** — one serve = one failure
  domain; state survives in Mongo, but confirm scheduler/lease recovery on
  restart.
- **Upstream "want" queue** — `media.jobs` is *downstream* (after download). What
  enqueues a download/triage/etc. *upstream*? (bot command, media ingest, issue
  arrival → all webhooks per DEC-2.)
- **Does treehouse stay or retire** once JIT seedboxes exist?

---

## Where we left off / next step

Two ways to start, unresolved:

- **Prototype-first (recommended):** one reconcile workflow driven by *both* a
  scheduled tick and a webhook — read `worker queue`, boot **one** local VM if
  there's unmatched demand, tear it down on idle. This pressure-tests the whole
  thesis (event latency, lock behavior under a reconcile, idempotency) before
  building the taxonomy or the provisioner abstraction.
- **Model-first:** nail the capacity-class taxonomy + provisioner interface (the
  data model the loop reasons over) before wiring behavior.

---

*Update this document as the plan develops — it's the canonical readable state.*
