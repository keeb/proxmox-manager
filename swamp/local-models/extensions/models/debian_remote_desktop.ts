/**
 * @keeb/debian/remote-desktop — turns a Debian host into a lightweight remote
 * desktop over SSH: XFCE (compositing off) + xrdp, Firefox ESR, and Claude
 * Code (native installer) for a given user. Idempotent; safe to re-run.
 */
import { z } from "npm:zod@4";
import { sshExec, waitForSsh, isValidSshHost } from "./lib/ssh.ts";

const GlobalArgs = z.object({
  sshHost: z.string().describe("SSH host of the Debian VM (CEL from fleet)"),
  sshUser: z.string().default("root").describe("SSH user"),
});

const InstallArgs = z.object({
  vmName: z.string().describe("Fleet VM name (resolves sshHost via CEL)"),
  username: z.string().describe("Desktop user (must already exist)"),
  sshTimeout: z.number().default(300).describe(
    "Seconds to wait for SSH before installing",
  ),
});

const ResultSchema = z.object({
  vmName: z.string(),
  host: z.string(),
  username: z.string(),
  xrdpVersion: z.string().optional(),
  claudeVersion: z.string().optional(),
  firefoxVersion: z.string().optional(),
  logs: z.string().optional(),
  timestamp: z.string(),
});

/** Render the idempotent setup script. Pure. */
export function renderSetupScript(username: string): string {
  const home = `/home/${username}`;
  return `set -eu
export DEBIAN_FRONTEND=noninteractive
id ${username} >/dev/null

apt-get update -q
apt-get install -y -q --no-install-recommends \\
  xfce4 xfce4-terminal xfce4-notifyd xfce4-taskmanager mousepad \\
  adwaita-icon-theme fonts-dejavu fonts-noto-color-emoji at-spi2-core \\
  dbus-x11 xrdp xorgxrdp firefox-esr git curl ca-certificates
apt-get install -y -q pipewire-module-xrdp pipewire-pulse wireplumber || echo "audio redirection packages unavailable — skipping"

# xrdp needs to read the snakeoil key
adduser xrdp ssl-cert >/dev/null

# Suppress the "authentication required to create a color managed device"
# prompt that colord raises in every xrdp session
mkdir -p /etc/polkit-1/rules.d
cat > /etc/polkit-1/rules.d/45-allow-colord.rules <<'EOF'
polkit.addRule(function(action, subject) {
  if (action.id.indexOf("org.freedesktop.color-manager.") == 0 &&
      subject.isInGroup("users")) {
    return polkit.Result.YES;
  }
});
EOF

# Session: XFCE, compositing off (snappier over RDP)
echo startxfce4 > ${home}/.xsession
mkdir -p ${home}/.config/xfce4/xfconf/xfce-perchannel-xml
XFWM=${home}/.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml
if [ ! -f "$XFWM" ]; then
  cat > "$XFWM" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfwm4" version="1.0">
  <property name="general" type="empty">
    <property name="use_compositing" type="bool" value="false"/>
  </property>
</channel>
EOF
fi
grep -q '.local/bin' ${home}/.bashrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ${home}/.bashrc
chown -R ${username}:${username} ${home}/.xsession ${home}/.config ${home}/.bashrc

# Claude Code (native binary, per-user). Don't use install.sh: it ends with
# an interactive \`claude install\` that spins forever without a TTY. Do its
# download + checksum steps directly and lay the binary out the same way.
apt-get install -y -q jq >/dev/null
if [ ! -x ${home}/.local/bin/claude ]; then
  su - ${username} -c '
    set -eu
    BASE=https://downloads.claude.ai/claude-code-releases
    VER=$(curl -fsSL $BASE/latest)
    SUM=$(curl -fsSL $BASE/$VER/manifest.json | jq -r ".platforms[\\"linux-x64\\"].checksum")
    mkdir -p ~/.local/share/claude/versions ~/.local/bin
    curl -fsSL -o ~/.local/share/claude/versions/$VER $BASE/$VER/linux-x64/claude
    echo "$SUM  $HOME/.local/share/claude/versions/$VER" | sha256sum -c --quiet
    chmod +x ~/.local/share/claude/versions/$VER
    ln -sfn ~/.local/share/claude/versions/$VER ~/.local/bin/claude
    rm -rf ~/.claude/downloads
  '
fi

systemctl enable xrdp >/dev/null 2>&1
systemctl restart xrdp

echo "XRDP=$(dpkg-query -W -f='\${Version}' xrdp)"
echo "FIREFOX=$(dpkg-query -W -f='\${Version}' firefox-esr)"
echo "CLAUDE=$(su - ${username} -c '~/.local/bin/claude --version' 2>/dev/null | head -n1)"
`;
}

export const model = {
  type: "@keeb/debian/remote-desktop",
  version: "2026.10.13.1",
  resources: {
    "desktop": {
      description: "Remote desktop install result",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  globalArguments: GlobalArgs,
  methods: {
    install: {
      description:
        "Install XFCE + xrdp + Firefox ESR + Claude Code for a user (idempotent)",
      arguments: InstallArgs,
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const { vmName, username, sshTimeout = 300 } = args;
        const { sshHost, sshUser = "root" } = context.globalArgs;
        if (!isValidSshHost(sshHost)) {
          throw new Error(`sshHost is required — is "${vmName}" running?`);
        }
        const logs: string[] = [];
        const log = (msg: string) => {
          logs.push(msg);
          console.log(msg);
        };

        log(`Waiting for SSH on ${sshUser}@${sshHost} (up to ${sshTimeout}s)`);
        if (!(await waitForSsh(sshHost, sshUser, sshTimeout))) {
          throw new Error(`SSH not reachable on ${sshHost}`);
        }

        // A failed ISO boot falls through to PXE and comes up as diskless
        // Alpine with the same IP — refuse to run against that.
        await sshExec(
          sshHost,
          sshUser,
          `test -f /etc/debian_version || { echo "${sshHost} is not Debian (ISO boot fell through to PXE?)" >&2; exit 1; }`,
        );

        log(`Installing remote desktop for ${username} on ${sshHost}`);
        const b64 = btoa(
          String.fromCharCode(
            ...new TextEncoder().encode(renderSetupScript(username)),
          ),
        );
        const result = await sshExec(
          sshHost,
          sshUser,
          `echo '${b64}' | base64 -d > /tmp/remote-desktop-setup.sh && bash /tmp/remote-desktop-setup.sh </dev/null`,
        );
        const pick = (k: string) =>
          result.stdout.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();
        const xrdpVersion = pick("XRDP");
        const firefoxVersion = pick("FIREFOX");
        const claudeVersion = pick("CLAUDE");
        log(`xrdp ${xrdpVersion} · firefox-esr ${firefoxVersion} · claude ${claudeVersion}`);

        const handle = await context.writeResource("desktop", vmName, {
          vmName,
          host: sshHost,
          username,
          xrdpVersion,
          firefoxVersion,
          claudeVersion,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
