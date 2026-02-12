# Config Reference

## slate-setup-alpine.conf

Answer file for `setup-alpine -f` to install Alpine Linux to disk on the slate VM (vmid 100).

### What it does
- Installs Alpine Linux in `sys` mode to `/dev/sda`
- Partitions: sda1 (boot 300M), sda2 (swap ~4G), sda3 (root ~28G ext4)
- Hostname: `slate`
- Network: eth0 DHCP
- DNS: 10.0.0.162, 10.0.0.137, 10.0.0.1
- Timezone: UTC, Keymap: US
- SSH: openssh, NTP: chrony
- Repos: Alpine latest-stable (main + community)

### Usage (from PXE-booted VM)
```bash
# Copy to VM
scp config/slate-setup-alpine.conf root@<ip>:/tmp/setup-alpine.conf

# Set root password first (setup-alpine inherits it)
ssh root@<ip> 'echo "root:<password>" | chpasswd'

# Run install
ssh root@<ip> 'ERASE_DISKS=/dev/sda setup-alpine -e -f /tmp/setup-alpine.conf'

# Post-install: copy SSH keys to disk
ssh root@<ip> 'mount /dev/sda3 /mnt && mount /dev/sda1 /mnt/boot'
ssh root@<ip> 'mkdir -p /mnt/root/.ssh && cp /root/.ssh/authorized_keys /mnt/root/.ssh/authorized_keys'
ssh root@<ip> 'chroot /mnt apk add qemu-guest-agent && chroot /mnt rc-update add qemu-guest-agent default'
ssh root@<ip> 'umount /mnt/boot && umount /mnt'

# Set boot order to disk-first via swamp
swamp model method run slateDestroy setBootDiskFirst --json

# Reboot via Proxmox
swamp model method run slateDestroy stopVm --json
swamp model method run slateDestroy startVm --json
```

### Notes
- The PXE overlay at 10.0.0.191 provides SSH keys via `alpine.apkovl.tar.gz`
- After disk install, SSH keys must be manually copied to `/mnt/root/.ssh/`
- Boot order must be changed from `net0;scsi0` to `scsi0;net0` or it PXE boots again
- Root password is set before running setup-alpine (it inherits the current password)
