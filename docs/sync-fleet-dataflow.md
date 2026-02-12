# sync-fleet Workflow Data Flow

How data moves from trigger through definitions, extension models, and outputs — and how downstream models consume the results via CEL.

## Overview

```
$ swamp workflow run sync-fleet
        │
        ▼
┌─────────────────┐     ┌─────────────────┐     ┌──────────────────────┐
│  Step 1: auth   │────▶│ Step 2: sync    │────▶│  10 named resources  │
│  keebDev02.auth │     │ fleet.sync      │     │  in .swamp/data/     │
└─────────────────┘     └─────────────────┘     └──────────────────────┘
   writes ticket           reads ticket via          consumed by all
   + csrfToken             CEL, queries              downstream models
                           Proxmox API               via CEL
```

---

## Step 1: Authentication

**Model:** `keebDev02` | **Type:** `proxmox/node` | **Method:** `auth`

### Definition Attributes

| Attribute | Value | Source |
|-----------|-------|--------|
| `apiUrl` | `https://10.0.0.4:8006` | hardcoded |
| `username` | `root` | hardcoded |
| `password` | `${{ vault.get("proxmox-vault", "password") }}` | vault CEL |
| `realm` | `pam` | hardcoded |
| `node` | `keeb-dev-02` | hardcoded |

### What the Extension Does

```
proxmox_node.ts :: auth(definition, context)

    1. POST /api2/json/access/ticket
       body: { username: "root@pam", password: "..." }

    2. Receives: { ticket: "PVE:root@pam:6819A3C2::...",
                   CSRFPreventionToken: "6819A3C2:..." }

    3. context.writeResource("node", {
         ticket, csrfToken, username, timestamp
       })
```

### Output

```
.swamp/data/@user/proxmox/node/<keebDev02-id>/node/5/raw

{
  "ticket":    "PVE:root@pam:6819A3C2::...",
  "csrfToken": "6819A3C2:...",
  "username":  "root@pam",
  "timestamp": "2026-02-11T05:40:47Z"
}
```

**CEL addresses created:**
- `model.keebDev02.resource.node.attributes.ticket`
- `model.keebDev02.resource.node.attributes.csrfToken`

---

## Step 2: Fleet Sync

**Model:** `fleet` | **Type:** `proxmox/vm` | **Method:** `sync`

### Definition Attributes

| Attribute | Value | Source |
|-----------|-------|--------|
| `apiUrl` | `https://10.0.0.4:8006` | hardcoded |
| `ticket` | `${{ model.keebDev02.resource.node.attributes.ticket }}` | CEL from step 1 |
| `csrfToken` | `${{ model.keebDev02.resource.node.attributes.csrfToken }}` | CEL from step 1 |
| `node` | `keeb-dev-02` | hardcoded |

### What the Extension Does

```
proxmox_vm.ts :: sync(definition, context)

    1. GET /api2/json/nodes/keeb-dev-02/qemu
       ──▶ returns list of all VMs on the node

    2. For each running VM, resolve IP via QEMU guest agent:
       GET /nodes/keeb-dev-02/qemu/{vmid}/agent/network-get-interfaces

    3. Write a NAMED RESOURCE per VM:
       for (const vm of vms) {
         context.writeResource("vm",
           { vmid, vmName, status, ip, timestamp },
           { name: vm.name }    ◀── name IS the identity
         )
       }
```

### Outputs (10 named resources)

```
.swamp/data/@user/proxmox/vm/<fleet-id>/
├── allthemons/2/raw    {"vmid":108, "status":"running",  "ip":"10.0.0.96"}
├── atm10/2/raw         {"vmid":101, "status":"stopped",  "ip":null}
├── calamity/2/raw      {"vmid":107, "status":"running",  "ip":"10.0.0.208"}
├── factorio/2/raw      {"vmid":106, "status":"stopped",  "ip":null}
├── gold-image/2/raw    {"vmid":109, "status":"running",  "ip":"10.0.0.143"}
├── meatballcraft/2/raw {"vmid":105, "status":"stopped",  "ip":null}
├── satisfactory/2/raw  {"vmid":104, "status":"stopped",  "ip":null}
├── slate/2/raw         {"vmid":100, "status":"running",  "ip":"10.0.0.33"}
├── tftp-server/2/raw   {"vmid":103, "status":"running",  "ip":null}
└── VM 102/2/raw        {"vmid":102, "status":"stopped",  "ip":null}
```

Each resource is versioned (the `/2/` segment) and addressable via CEL:

```
model.fleet.resource.vm[<name>].attributes.<field>
```

---

## Downstream CEL Consumers

Once sync-fleet has run, every other model in the system can reference fleet data through CEL expressions in their definition attributes.

### Hardcoded VM References

These definitions wire directly to a known VM name:

```
allthemonsMinecraft.host = ${{ model.fleet.resource.vm[allthemons].attributes.ip }}
                           ──▶ "10.0.0.96"

calamityTerraria.host    = ${{ model.fleet.resource.vm[calamity].attributes.ip }}
                           ──▶ "10.0.0.208"

calamity.host            = ${{ model.fleet.resource.vm[calamity].attributes.ip }}
                           ──▶ "10.0.0.208"

goldImageOverlay.host    = ${{ model.fleet.resource.vm[gold-image].attributes.ip }}
                           ──▶ "10.0.0.143"

botDeployer.host         = ${{ model.fleet.resource.vm[slate].attributes.ip }}
                           ──▶ "10.0.0.33"
```

### Dynamic VM References

These definitions use `inputs.vmName`, resolved at runtime from workflow `--input vmName=X`:

```
alpineInstaller.host     = ${{ model.fleet.resource.vm[inputs.vmName].attributes.ip }}
dockerEngine.host        = ${{ model.fleet.resource.vm[inputs.vmName].attributes.ip }}
tailscaleNode.host       = ${{ model.fleet.resource.vm[inputs.vmName].attributes.ip }}
testVmSsh.host           = ${{ model.fleet.resource.vm[inputs.vmName].attributes.ip }}
```

Example: `swamp workflow run setup-docker --input vmName=calamity` resolves the CEL to `10.0.0.208`.

---

## Full Flow Diagram

```
  $ swamp workflow run sync-fleet
                │
                ▼
  ┌─────────────────────────────────────────────────────┐
  │ WORKFLOW: sync-fleet                                │
  │                                                     │
  │  ┌───────────────────────────────────────────────┐  │
  │  │ STEP 1: keebDev02.auth                        │  │
  │  │                                               │  │
  │  │  vault.get("proxmox-vault","password")        │  │
  │  │         │                                     │  │
  │  │         ▼                                     │  │
  │  │  POST /api2/json/access/ticket                │  │
  │  │         │                                     │  │
  │  │         ▼                                     │  │
  │  │  writeResource("node", {ticket, csrfToken})   │  │
  │  └────────────────────┬──────────────────────────┘  │
  │                       │                             │
  │            CEL: model.keebDev02.resource            │
  │                  .node.attributes.ticket            │
  │                       │                             │
  │                       ▼                             │
  │  ┌───────────────────────────────────────────────┐  │
  │  │ STEP 2: fleet.sync                            │  │
  │  │                                               │  │
  │  │  GET /nodes/keeb-dev-02/qemu ──► 10 VMs       │  │
  │  │         │                                     │  │
  │  │         ├──► running? GET .../agent/          │  │
  │  │         │    network-get-interfaces ──► IP    │  │
  │  │         │                                     │  │
  │  │         ▼                                     │  │
  │  │  for each VM:                                 │  │
  │  │    writeResource("vm", data, {name: vmName})  │  │
  │  └────────────────────┬──────────────────────────┘  │
  │                       │                             │
  └───────────────────────┼─────────────────────────────┘
                          │
              10 named resources written
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼
  ┌──────────────┐ ┌────────────┐ ┌──────────────┐
  │ allthemons   │ │ calamity   │ │ slate        │
  │ vmid: 108    │ │ vmid: 107  │ │ vmid: 100    │
  │ ip: 10.0.0.96│ │ ip: .208   │ │ ip: .33      │
  └──────┬───────┘ └─────┬──────┘ └──────┬───────┘
         │               │               │
         ▼               ▼               ▼
  ┌──────────────┐ ┌────────────┐ ┌──────────────┐
  │ allthemons   │ │ calamity   │ │ botDeployer  │
  │ Minecraft    │ │ Terraria   │ │              │
  │ (minecraft/  │ │ (docker/   │ │ (bot/deploy) │
  │  server)     │ │  compose)  │ │              │
  └──────────────┘ └────────────┘ └──────────────┘
```
