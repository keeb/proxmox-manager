// extensions/models/alpine_install.ts
import { z } from "npm:zod@4";

// extensions/models/lib/ssh.ts
async function sshExec(ip, user, command) {
  const proc = new Deno.Command("ssh", {
    args: [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "ConnectTimeout=10",
      `${user}@${ip}`,
      command
    ]
  });
  const result = await proc.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.code !== 0) {
    throw new Error(`SSH command failed (exit ${result.code}): ${stderr.slice(-500)}`);
  }
  return {
    code: result.code,
    stdout,
    stderr
  };
}
async function sshExecRaw(ip, user, command) {
  const proc = new Deno.Command("ssh", {
    args: [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "ConnectTimeout=10",
      `${user}@${ip}`,
      command
    ]
  });
  const result = await proc.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  return {
    code: result.code,
    stdout,
    stderr
  };
}
async function waitForSsh(ip, user, timeoutSeconds = 60, pollInterval = 3) {
  const deadline = Date.now() + timeoutSeconds * 1e3;
  while (Date.now() < deadline) {
    const result = await sshExecRaw(ip, user, "echo ready");
    if (result.code === 0 && result.stdout.trim() === "ready") {
      return true;
    }
    await new Promise((r) => setTimeout(r, pollInterval * 1e3));
  }
  return false;
}

// extensions/models/alpine_install.ts
var GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname/IP of the PXE-booted VM (set via CEL from testVm)"),
  sshUser: z.string().default("root").describe("SSH user (default 'root')")
});
var InstallArgs = z.object({
  hostname: z.string().describe("Hostname for the installed system"),
  password: z.string().describe("Root password for the installed system"),
  disk: z.string().default("/dev/sda").describe("Target disk for Alpine install (default '/dev/sda')")
});
var ResultSchema = z.object({
  success: z.boolean(),
  hostname: z.string(),
  disk: z.string(),
  timestamp: z.string()
});
function buildAnswerFile(hostname, disk) {
  return `KEYMAPOPTS="us us"
HOSTNAMEOPTS="-n ${hostname}"
INTERFACESOPTS="auto lo
iface lo inet loopback

auto eth0
iface eth0 inet dhcp
"
DNSOPTS="-d local 10.0.0.162 10.0.0.137 10.0.0.1"
TIMEZONEOPTS="-z UTC"
PROXYOPTS="none"
APKREPOSOPTS="-1"
SSHDOPTS="-c openssh"
NTPOPTS="-c chrony"
DISKOPTS="-m sys ${disk}"
`;
}
var model = {
  type: "@user/alpine/install",
  version: "2026.02.11.1",
  resources: {
    "result": {
      description: "Alpine install result",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10
    }
  },
  globalArguments: GlobalArgs,
  methods: {
    install: {
      description: "Install Alpine to disk on a PXE-booted VM: set password, run setup-alpine, post-install chroot setup",
      arguments: InstallArgs,
      execute: async (args, context) => {
        const { hostname, password, disk = "/dev/sda" } = args;
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!sshHost) throw new Error("sshHost is required \u2014 VM must be running with an IP");
        if (!hostname) throw new Error("hostname is required");
        if (!password) throw new Error("password is required");
        console.log(`[install] Installing Alpine to ${disk} on ${sshHost} (hostname: ${hostname})`);
        console.log(`[install] Waiting for SSH on ${sshHost}...`);
        const sshReady = await waitForSsh(sshHost, sshUser, 60, 3);
        if (!sshReady) throw new Error(`SSH not ready on ${sshHost} after 60s`);
        console.log(`[install] Loading SCSI modules and waiting for disk ${disk}...`);
        await sshExec(sshHost, sshUser, `modprobe virtio_scsi 2>/dev/null; modprobe sd_mod 2>/dev/null; mdev -s 2>/dev/null; for i in $(seq 1 30); do [ -b ${disk} ] && exit 0; echo "Waiting for ${disk} ($i/30)..."; sleep 2; done; echo "${disk} not found after 60s"; exit 1`);
        console.log(`[install] Disk ${disk} is ready`);
        console.log(`[install] Step 1: Setting root password...`);
        await sshExec(sshHost, sshUser, `echo '${sshUser}:${password}' | chpasswd`);
        console.log(`[install] Root password set`);
        console.log(`[install] Step 2: Writing setup-alpine answer file...`);
        const answerFile = buildAnswerFile(hostname, disk);
        await sshExec(sshHost, sshUser, `cat > /tmp/setup-alpine.conf << 'ANSWEREOF'
${answerFile}ANSWEREOF`);
        console.log(`[install] Answer file written`);
        console.log(`[install] Step 3: Running setup-alpine (this may take a while)...`);
        await sshExec(sshHost, sshUser, `ERASE_DISKS=${disk} setup-alpine -e -f /tmp/setup-alpine.conf`);
        console.log(`[install] Alpine installed to ${disk}`);
        console.log(`[install] Step 4: Post-install setup (SSH keys, guest agent, repos)...`);
        const postInstallScript = [
          // Mount the installed system
          `mount ${disk}3 /mnt`,
          `mount ${disk}1 /mnt/boot`,
          // Copy SSH authorized_keys
          `mkdir -p /mnt/root/.ssh`,
          `cp /root/.ssh/authorized_keys /mnt/root/.ssh/authorized_keys`,
          `chmod 700 /mnt/root/.ssh`,
          `chmod 600 /mnt/root/.ssh/authorized_keys`,
          // Fix apk repos to latest-stable main+community
          `echo 'https://dl-cdn.alpinelinux.org/alpine/latest-stable/main' > /mnt/etc/apk/repositories`,
          `echo 'https://dl-cdn.alpinelinux.org/alpine/latest-stable/community' >> /mnt/etc/apk/repositories`,
          // Mount necessary filesystems for chroot
          `mount -t proc proc /mnt/proc`,
          `mount -t sysfs sys /mnt/sys`,
          `mount -o bind /dev /mnt/dev`,
          // Install qemu-guest-agent in chroot
          `chroot /mnt apk update`,
          `chroot /mnt apk add qemu-guest-agent`,
          `chroot /mnt rc-update add qemu-guest-agent default`,
          // Set root password in chroot
          `chroot /mnt sh -c 'echo "root:${password}" | chpasswd'`,
          // Cleanup chroot mounts
          `umount /mnt/dev`,
          `umount /mnt/sys`,
          `umount /mnt/proc`,
          `umount /mnt/boot`,
          `umount /mnt`
        ].join(" && ");
        await sshExec(sshHost, sshUser, postInstallScript);
        console.log(`[install] Post-install setup complete`);
        console.log(`[install] Alpine installation complete on ${sshHost}`);
        const handle = await context.writeResource("result", "result", {
          success: true,
          hostname,
          disk,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        return {
          dataHandles: [
            handle
          ]
        };
      }
    }
  }
};
export {
  model
};
