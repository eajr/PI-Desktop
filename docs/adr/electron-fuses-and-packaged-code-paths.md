# ADR: Electron fuses, minimum macOS entitlements, and packaged code paths

- Status: Accepted
- Date: 2026-10-12
- Amends: ADR 0289 (entitlement set), the security spec "Future hardening"
  list
- Related: D008, ADR 0241, ADR 0257, ADR 0278,
  [provider-system-certificates](provider-system-certificates.md),
  [05-security/01-security](../spec/05-security/01-security.md)

> Amended 2026-10-12 by
> [ADR fork-removes-voice-and-speech](fork-removes-voice-and-speech.md): the
> native voice modules were removed, so `app.asar.unpacked` no longer carries
> them and `build.asarUnpack` is gone.

## Context

A security review found that packaged PI-Desktop builds configured no Electron
fuses, so Electron's defaults applied: the binary honors
`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, and `--inspect`, reads app code from a
loose `app` folder when `app.asar` is absent, and never checks `app.asar`
against a signed hash. The macOS entitlements also granted
`allow-unsigned-executable-memory` and `disable-library-validation`. Local
malware could run or modify code inside the signed app identity and inherit
its macOS privacy (TCC) grants. Packaged builds also honored
`PI_DESKTOP_HOST_BIN`, which picks the host-core executable, and passed an
inherited `PI_DESKTOP_BUILTIN_PLUGINS_DIR` through to host-core when Electron
did not set it.

Each fuse was checked against what the app needs. These results come from the
repository and from probes of the Electron 43.6.0 Linux binary with fuses
flipped by `@electron/fuses` 1.8.0:

- The agent sidecar is launched as `process.execPath` with
  `ELECTRON_RUN_AS_NODE=1` (D008, `electron/main/agent-sidecar.ts`) and speaks
  NDJSON over stdin/stdout. No separate Node runtime ships.
- With the `NODE_OPTIONS` fuse off, Electron ignores **and removes**
  `NODE_EXTRA_CA_CERTS` from the main process environment, so the sidecar
  never receives it. An inherited `NODE_EXTRA_CA_CERTS` is a documented trust
  input for provider TLS ([provider-system-certificates](provider-system-certificates.md)).
- With the `nodeCliInspect` fuse off, `--inspect` still works in
  `ELECTRON_RUN_AS_NODE` mode. The fuse protects only the GUI main process.
- The production renderer loads from `file://` (`loadFile`) as a Vite build
  with `<script type="module" crossorigin>` and `crossorigin` stylesheets.
  With `grantFileProtocolExtraPrivileges` off, the probe page's module script
  and stylesheet did not load at all.
- `asar` is enabled, and electron-builder 26 writes the `app.asar` header hash
  into `Info.plist` (macOS) and the executable's resources (Windows). Native
  voice modules are in `app.asar.unpacked`, and the sidecar, host-core,
  bundled plugins, and skills are in `extraResources`. All of these are
  outside `app.asar`.
- electron-builder flips fuses before it signs. A pack with no signing
  identity is not signed again afterward (ADR 0278). On Apple Silicon a
  modified Electron Framework with a stale ad-hoc signature is killed at
  launch.

## Decision

1. `apps/desktop/package.json` `build.electronFuses` sets every fuse
   explicitly:

   | Fuse | Value | Why |
   |---|---|---|
   | `runAsNode` | `true` | The sidecar runs on the Electron binary (D008). Turning this off requires moving the sidecar to `utilityProcess` with a new transport, or shipping a separate Node runtime. That work is tracked as a follow-up, not done here. |
   | `enableCookieEncryption` | `true` | Cookies are encrypted with the OS key that `safeStorage` already uses. This is a one-way change: turning it off later makes the cookie store unreadable. |
   | `enableNodeOptionsEnvironmentVariable` | `true` | Turning it off also drops the supported `NODE_EXTRA_CA_CERTS` trust input. A replacement CA input is a product decision and is not made here. |
   | `enableNodeCliInspectArguments` | `false` | Nothing in the packaged app uses `--inspect` or `SIGUSR1`. Dev and E2E use the unfused `node_modules` Electron. |
   | `enableEmbeddedAsarIntegrityValidation` | `true` | macOS and Windows validate `app.asar` against the hash embedded at build time. |
   | `onlyLoadAppFromAsar` | `true` | A loose `app/` folder can no longer replace `app.asar`. |
   | `loadBrowserProcessSpecificV8Snapshot` | `false` | Electron default. No browser-specific snapshot ships. |
   | `grantFileProtocolExtraPrivileges` | `true` | The renderer loads from `file://` with module scripts, and plugin panels also load from `file://`. Turning this off requires serving them from a custom protocol first. |
   | `resetAdHocDarwinSignature` | `true` | Unsigned macOS packs get a valid ad-hoc signature after the fuses are flipped. Signed packs are signed again with Developer ID immediately afterward. |

2. macOS entitlements drop
   `com.apple.security.cs.allow-unsigned-executable-memory`. V8 uses `MAP_JIT`
   under `allow-jit`, and the Electron-maintained `@electron/osx-sign`
   default app entitlements carry `allow-jit` only.
   `disable-library-validation` stays. The main executable is also the
   sidecar's Node runtime, and plugin hosts run in Electron helpers. Both may
   load native addons from user-installed pi packages and plugins that are
   not signed by the app's team. Hardened runtime still blocks `DYLD_*`
   injection because `allow-dyld-environment-variables` is not granted.
3. Packaged builds resolve executable code only from `process.resourcesPath`
   (`electron/main/packaged-code-paths.ts`):
   - `PI_DESKTOP_HOST_BIN` and the source-checkout `target/` fallbacks apply
     only when `!app.isPackaged`.
   - Electron always sets or clears `PI_DESKTOP_BUILTIN_PLUGINS_DIR` for the
     host-core child, so an inherited value never reaches it. An inherited
     value is a developer override only when unpackaged.
   - `PI_DESKTOP_DATA_DIR` and the other data-location variables remain
     user-facing and unchanged.

## Consequences

- Code inside `app.asar` cannot be swapped or modified without failing
  validation on macOS and Windows. Linux has no embedded asar integrity
  support. There, `onlyLoadAppFromAsar` and the inspect fuse still apply.
- Not covered by asar integrity: `app.asar.unpacked`, the sidecar bundle,
  host-core, bundled plugins, and skills. On macOS the code signature seals
  them, and macOS app-bundle protection guards a notarized bundle. On Windows
  and Linux, protection depends on the install location's file permissions.
- **Residual risk:** `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` are still
  honored. A local process can still run the signed binary as Node and
  inherit the app's TCC grants. Closing that needs both of these:
  - a sidecar launch path that does not depend on `RunAsNode`
  - an explicit, product-approved replacement for `NODE_EXTRA_CA_CERTS`

  This ADR is the place to change when that lands. The fuse test pins
  `runAsNode: true` together with the sidecar's `ELECTRON_RUN_AS_NODE`
  launch, so the two must change together.
- Existing installs encrypt their cookie store on first write after the
  update.
- Developers keep `PI_DESKTOP_HOST_BIN` for unpackaged runs and E2E. It has no
  effect on an installed app.

## Alternatives

- Disable `runAsNode` and `NODE_OPTIONS` now, as the review suggested.
  Rejected. Doing so would break every agent turn and silently remove a
  documented certificate trust input. Neither can be validated without a
  signed macOS build.
- Disable `grantFileProtocolExtraPrivileges`. Rejected until the renderer
  moves to a custom protocol, because the renderer would no longer load.
- Drop `disable-library-validation`. Rejected while the sidecar and plugin
  hosts load third-party native addons.
