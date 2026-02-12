# From 200-Line Monolith to 65-Second Composable VM Factory

I had a 200-line method called `provisionSlate`. It created a VM, PXE-booted it into diskless Alpine, installed Alpine to disk, configured SSH keys and guest agents, flipped the boot order, rebooted, and installed Docker. All in one function. Ten steps, one giant `execute` block, zero reusability.

It worked. I hated it.

## The Problem With Monoliths That Work

`provisionSlate` did everything right. It authenticated, created the VM, waited for the IP, set the root password, wrote an answer file, ran `setup-alpine`, did a post-install chroot to set up SSH keys and `qemu-guest-agent`, flipped the boot order to disk-first, rebooted, waited for the disk-booted IP, and installed Docker. 220 lines of sequential API calls and SSH commands, all in one method.

The problem wasn't that it broke. The problem was that I couldn't use any of its pieces independently. Want to install Alpine on a VM that already exists? Can't. Want to skip Docker? Can't. Want to add Tailscale instead? Better copy-paste those 220 lines and hack them up.

## Decomposition

I use [swamp](https://github.com/systeminit/swamp) for model-driven automation. The idea is simple: define extension models in TypeScript with methods that do one thing, wire them together with YAML workflows and CEL expressions, and let the workflow engine handle sequencing.

So I broke `provisionSlate` into pieces:

**`alpine/install`** -- Single method: `install`. Takes an SSH host, hostname, password, and target disk. Sets the root password, writes a templated `setup-alpine` answer file, runs the install, then does the post-install chroot (SSH keys, APK repos, `qemu-guest-agent`, root password on the installed system).

**`docker/engine`** -- Single method: `install`. Takes an SSH host. Runs `apk add docker && rc-update add docker default && service docker start`. That's it. Seven seconds of work wrapped in a model so it's composable.

**`proxmox/vm` (new method: `setBootOrder`)** -- Already had `create`, `start`, `stop`, `delete`, `lookup`. Added `setBootOrder` which resolves a VM by name and PUTs the boot order via the Proxmox API.

Each model has a definition that wires its inputs via CEL expressions:

```yaml
# alpineInstaller definition
type: alpine/install
name: alpineInstaller
attributes:
  sshHost: '${{ model.testVm.data.attributes.ip }}'
  hostname: '${{ inputs.vmName }}'
  password: '${{ vault.get("proxmox-vault", "password") }}'
```

The workflow becomes a readable sequence:

```yaml
steps:
  - auth          # keebDev02.auth
  - create-vm     # testVm.create (PXE-first boot order)
  - start-vm      # testVm.start (PXE boots, waits for IP)
  - install-alpine # alpineInstaller.install (setup-alpine + chroot)
  - set-boot-order # testVm.setBootOrder (disk-first)
  - stop-vm       # testVm.stop
  - start-from-disk # testVm.start (boots from disk, waits for IP)
```

Seven steps instead of one monolith. Each step is independently testable. The workflow handles dependencies (`dependsOn: auth` etc.) and sequencing.

## The Bug That Wasn't Obvious

First run: `setup-alpine` blew up with `/dev/sda is not a block device suitable for partitioning`. The disk existed in Proxmox. The VM was running. The guest agent had reported an IP. SSH was working. I could even see the disk in `/proc/partitions`.

But `/dev/sda` wasn't a block device.

The PXE-booted Alpine kernel has `virtio_scsi` available as a module but doesn't autoload it. The guest agent starts before the SCSI controller is initialized. So the VM reports "I'm alive, here's my IP" while the disk is invisible to the kernel.

The fix was three commands before the disk check:

```bash
modprobe virtio_scsi 2>/dev/null
modprobe sd_mod 2>/dev/null
mdev -s 2>/dev/null
```

Load the SCSI controller driver, load the SCSI disk driver, scan for new devices. Disk appears instantly.

I also added `waitForSsh` before any SSH commands (the guest agent can report an IP before `sshd` is ready) and a disk readiness loop as a safety net. The install method now handles the full boot-to-ready gap gracefully.

## Composability Pays Off Immediately

With the decomposed models, adding new "setup" workflows is trivial. `setup-docker` was the first:

```yaml
steps:
  - auth
  - lookup        # testVm.lookup (get IP)
  - install-docker # dockerEngine.install
```

Then someone asked for Tailscale. New extension model:

```typescript
// tailscale_node.ts - the entire file is 50 lines
await sshExec(sshHost, sshUser,
  `apk add tailscale && rc-update add tailscale default && service tailscale start`);
await sshExec(sshHost, sshUser,
  `tailscale up --authkey=${authKey}`);
const ipResult = await sshExec(sshHost, sshUser, `tailscale ip -4`);
```

New definition wired to the vault:

```yaml
attributes:
  sshHost: '${{ model.testVm.data.attributes.ip }}'
  authKey: '${{ vault.get("proxmox-vault", "tailscaleAuthKey") }}'
```

New workflow:

```yaml
steps:
  - auth
  - lookup
  - install-tailscale
```

From "someone asked for Tailscale" to "Tailscale is deployed and reporting a 100.x.x.x IP" in about ten minutes. The second run was a clean 3-second workflow. That's what composability buys you.

## The Numbers

Full `create-stateful-vm` workflow: **~65 seconds**. That's create a VM from nothing, PXE boot into RAM, install an OS to disk, configure it, reboot from disk, and hand back a running VM with an IP.

- VM creation: ~1s
- PXE boot + IP: ~36s (waiting for guest agent)
- SSH ready: ~3s
- Alpine install + chroot: ~14s
- Boot order + stop + restart: ~11s

`setup-docker`: **~1 second**.

`setup-tailscale`: **~3 seconds**.

`delete-vm`: **~2 seconds**.

## What I Learned

**Monoliths hide assumptions.** `provisionSlate` assumed you always wanted Docker. It assumed the VM didn't exist yet. It assumed a specific disk layout. Breaking it apart forced each assumption into a visible, overridable input.

**The boot gap is real.** There's a window between "guest agent says the VM is alive" and "the VM is actually ready for work." SSH might not be listening. Kernel modules might not be loaded. Disks might not be visible. Every composable step that touches a freshly-booted VM needs to handle this gap explicitly.

**CEL expressions are the glue.** `${{ model.testVm.data.attributes.ip }}` means "grab the IP from whatever testVm's last method call returned." The workflow engine evaluates these between steps. No manual data passing, no shared state, no coupling between models.

**Small models compose better than smart ones.** `docker/engine` is 40 lines. `tailscale/node` is 50 lines. They do exactly one thing. The workflow is where the intelligence lives -- which models to call, in what order, with what inputs. The models themselves are deliberately dumb.

The 200-line monolith is still there in `proxmox_api.ts`. It still works. But I haven't touched it since.
