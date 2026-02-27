# Plan: Reusable `minecraft-install` Workflow

## Context

We manually set up a Project Infinity server on the infinity VM (install packages, upload zip, extract, configure variables.txt/EULA, start in tmux). This plan automates all of that as a reusable workflow that works with any Forge/NeoForge/Fabric server pack zip on any VM. Every step produces versioned data. Every connection uses CEL.

## Components

### 1. New extension model: `minecraft/installer` (`minecraft_installer.ts`)

**Type:** `@user/minecraft/installer`

**globalArguments:** `sshHost`, `sshUser` (wired from fleet via CEL)

**Resources** (all named per-VM):
| Resource | Instance | Description |
|----------|----------|-------------|
| `deps` | `[vmName]` | Package install result (packages, java version) |
| `upload` | `[vmName]` | Upload result (localPath, remotePath) |
| `server` | `[vmName]` | Discovered config (modloader, mcVersion, startScript, serverDir, logPath) |
| `config` | `[vmName]` | Configuration result (jvmMemory, eulaAccepted) |

**Methods:**

**`installDeps(vmName)`** — Install `openjdk21-jre tmux bash curl unzip` via `apk add`, wait for SSH first. Write `deps` resource.

**`upload(vmName, localPath)`** — rsync zip from local to `~/server-pack.zip` on VM using `Deno.Command` (same pattern as `ssh_host.ts:90` and `swamp_repo.ts:69`). Write `upload` resource with `remotePath`.

**`extract(vmName, remotePath, serverDir)`** — `unzip` to serverDir, parse `variables.txt` to discover MODLOADER, MINECRAFT_VERSION, MODLOADER_VERSION, JAVA_ARGS. Discover start script (`start.sh`, `startserver.sh`, etc.). Write `server` resource with all discovered metadata + computed `logPath`.

- `remotePath` comes via CEL: `model.minecraftInstaller.resource.upload[inputs.vmName].attributes.remotePath`
- Stores `logPath: "${serverDir}/logs/latest.log"` explicitly (avoids CEL string concatenation)

**`configure(vmName, serverDir, jvmMemory)`** — sed `JAVA_ARGS` to `-Xmx${mem} -Xms${mem}`, set `SKIP_JAVA_CHECK=true`, `WAIT_FOR_USER_INPUT=false`, `RESTART=false`. Write `eula.txt`. chmod start scripts. Write `config` resource.

- `serverDir` comes via CEL: `model.minecraftInstaller.resource.server[inputs.vmName].attributes.serverDir`

### 2. Generalize `minecraft/server` (`minecraft_server.ts`)

Add to GlobalArgs (with backward-compatible defaults matching allthemons):

```
tmuxSession  default "mons"
serverDir    default "~/mons"
startScript  default "./startserver.sh"
logPath      default "~/mons/logs/latest.log"
serverName   default "server"
```

Replace ALL hardcoded references across all 8 methods:
- `tmux has-session -t mons` → `tmux has-session -t ${tmuxSession}`
- `tmux send-keys -t mons` → `tmux send-keys -t ${tmuxSession}`
- `tmux kill-session -t mons` → `tmux kill-session -t ${tmuxSession}`
- `tmux new-session -d -s mons -c ~/mons './startserver.sh'` → `tmux new-session -d -s ${tmuxSession} -c ${serverDir} 'bash ${startScript}'`
- `~/mons/logs/latest.log` → `${logPath}`
- `writeResource("server", "server", ...)` → `writeResource("server", serverName, ...)`
- `writeResource("metrics", "metrics", ...)` → `writeResource("metrics", serverName, ...)`
- `writeMetricsFiles(..., "allthemons", ...)` → `writeMetricsFiles(..., serverName, ...)`

Affected methods: `say`, `op`, `deop`, `warnShutdown`, `stopMinecraftServer`, `startMinecraftServer`, `status`, `collectMetrics`

Version bump: `"2026.02.16.1"`

### 3. New definition: `minecraftInstaller`

```yaml
name: minecraftInstaller
type: '@user/minecraft/installer'
globalArguments:
  sshHost: '${{ model.fleet.resource.vm[inputs.vmName].attributes.ip }}'
  sshUser: root
methods:
  installDeps:
    arguments:
      vmName: '${{ inputs.vmName }}'
  upload:
    arguments:
      vmName: '${{ inputs.vmName }}'
      localPath: '${{ inputs.serverPackPath }}'
  extract:
    arguments:
      vmName: '${{ inputs.vmName }}'
      remotePath: '${{ model.minecraftInstaller.resource.upload[inputs.vmName].attributes.remotePath }}'
      serverDir: '${{ inputs.serverDir }}'
  configure:
    arguments:
      vmName: '${{ inputs.vmName }}'
      serverDir: '${{ model.minecraftInstaller.resource.server[inputs.vmName].attributes.serverDir }}'
      jvmMemory: '${{ inputs.jvmMemory }}'
```

### 4. New definition: `minecraftGame`

Generic minecraft/server instance that reads all config from installer data:

```yaml
name: minecraftGame
type: '@user/minecraft/server'
globalArguments:
  sshHost: '${{ model.fleet.resource.vm[inputs.vmName].attributes.ip }}'
  sshUser: root
  tmuxSession: '${{ inputs.vmName }}'
  serverDir: '${{ model.minecraftInstaller.resource.server[inputs.vmName].attributes.serverDir }}'
  startScript: '${{ model.minecraftInstaller.resource.server[inputs.vmName].attributes.startScript }}'
  logPath: '${{ model.minecraftInstaller.resource.server[inputs.vmName].attributes.logPath }}'
  serverName: '${{ inputs.vmName }}'
```

Key CEL wiring: fleet provides IP, installer provides server config, workflow provides vmName.

### 5. Update `allthemonsMinecraft` definition

Add the new globalArguments explicitly (values match current hardcoded defaults):

```yaml
globalArguments:
  sshHost: '${{ model.fleet.resource.vm["allthemons"].attributes.ip }}'
  sshUser: root
  tmuxSession: mons
  serverDir: ~/mons
  startScript: ./startserver.sh
  logPath: ~/mons/logs/latest.log
  serverName: allthemons
```

### 6. Workflow: `minecraft-install`

**Inputs:** `vmName` (required), `serverPackPath` (required), `serverDir` (default `~/game`), `jvmMemory` (default `10G`)

**Step dependency graph:**
```
auth
  │
  v
lookup-vm
  │         \
  v          v
install-deps  upload-pack     ← parallel (independent)
  │          │
  └────┬─────┘
       v
  extract-pack                ← needs both deps + zip
       │
       v
  configure-server
       │
       v
  start-server
```

Steps:
1. **auth** → `keebDev02.auth`
2. **lookup-vm** → `fleet.lookup(vmName)`
3. **install-deps** → `minecraftInstaller.installDeps(vmName)` [parallel with upload]
4. **upload-pack** → `minecraftInstaller.upload(vmName, serverPackPath)` [parallel with deps]
5. **extract-pack** → `minecraftInstaller.extract(vmName, remotePath←CEL, serverDir)` [depends on 3+4]
6. **configure-server** → `minecraftInstaller.configure(vmName, serverDir←CEL, jvmMemory)` [depends on 5]
7. **start-server** → `minecraftGame.startMinecraftServer()` [depends on 6; reads serverDir/startScript/logPath from installer data via CEL]

Proxy not included — run `configure-proxy` separately after install (follows "Workflows compose, never duplicate").

## CEL Data Flow

```
fleet.lookup        → resource.vm["infinity"].attributes.ip = "10.0.0.225"
installer.installDeps → resource.deps["infinity"].attributes.packages = "openjdk21-jre tmux..."
installer.upload    → resource.upload["infinity"].attributes.remotePath = "~/server-pack.zip"
installer.extract   → resource.server["infinity"].attributes.{modloader,startScript,serverDir,logPath}
installer.configure → resource.config["infinity"].attributes.{jvmMemory,eulaAccepted}
minecraftGame.start → resource.server["infinity"].attributes.serverReady = true
```

## Files to create
- `swamp/extensions/models/minecraft_installer.ts`

## Files to modify
- `swamp/extensions/models/minecraft_server.ts` (generalize hardcoded paths)
- `swamp/.swamp/definitions/@user/minecraft/server/d6879760-e416-4101-92e9-f349187b3db2.yaml` (add new globalArgs to allthemonsMinecraft)

## Definitions/workflows to create via CLI
- `swamp model create minecraftInstaller` (minecraft/installer definition)
- `swamp model create minecraftGame` (generic minecraft/server definition)
- `swamp workflow create minecraft-install`

## Verification
1. `swamp model method run allthemonsMinecraft status` — regression test (should work unchanged)
2. `swamp workflow run minecraft-install --input '{"vmName":"infinity","serverPackPath":"/home/keeb/Downloads/Serverfiles_Project_Infinity_0_1_0.0.47.1.zip","jvmMemory":"10G"}'`
3. Verify data written: `swamp model get minecraftInstaller --json` shows per-VM resources
4. Verify server running: `swamp model method run minecraftGame status --input '{"vmName":"infinity"}'`
