# Profile runtime management

The manager tracks profile main processes by their exact `--user-data-dir`, executable, and process start time. It excludes Electron subprocesses carrying `--type`. A saved PID alone is never sufficient to focus or terminate an instance.

## State and actions

- `not_running`: no matching main process.
- `starting`: a launch has been requested; allow up to 45 seconds for process/window readiness.
- `running`: the main process is verified.
- `background`: Windows found the main process but no visible titled window.
- `closing`: a normal exit or force stop was requested; exit has not yet been confirmed.
- `unknown`: inspection failed; the UI must not infer an exit.
- `error`: launch failed or the desktop process exited before readiness.

Opening a running profile only activates the existing instance. It does not rewrite config/auth or spawn another process. Open/close operations serialize per profile, and concurrent opens share the same launch request. A pending launch also blocks a second launch when its process has not appeared yet.

Normal close uses `WM_CLOSE` on Windows and `NSRunningApplication.terminate` on macOS. If an app remains running after eight seconds, the UI offers an explicit force stop with confirmation. The OS adapter rechecks the process identity immediately before acting. Windows holds a process handle while verifying identity and forcing an exit. macOS verifies the kernel start time/command again inside the AppKit action helper, avoiding assumptions about AppKit registration dates.

## Monitoring cost

One main-process monitor handles all profiles. Polls never overlap. Stable states produce no renderer events; changed snapshots carry monotonically increasing revisions so late responses cannot overwrite newer state.

- Foreground: every 3 seconds.
- Background/minimized/closed manager window on macOS: every 15 seconds.
- Launch/close in progress: every 1 second, bounded by the operation deadline.
- Discovery of untracked external instances: every 30 seconds, or immediately on manager focus and profile operations.
- Spawn/exit notifications: request an immediate discovery check.

Windows compiles the Win32 window helper once in a persistent PowerShell worker. Between discovery scans it checks known PIDs/start times using `System.Diagnostics.Process`; it does not repeatedly start PowerShell or query all process command lines. Failed/expired helper caches trigger discovery again. The worker exits with the manager and is released when no active profiles remain.

macOS uses a single `ps` query for the known PIDs between discovery scans. Activation and termination run on demand through AppKit via the system JXA interpreter; no Swift compiler or third-party executable is required. Window availability is unknown on macOS: `running` confirms a main process, while activation success is reported separately. System restrictions on foreground activation may require selecting the app from the taskbar/Dock; this never causes another instance to be launched.

## Verification

```sh
npm run verify:runtime
npm run verify:runtime-native
npm run verify:runtime-ui
```

The first command exercises Windows/macOS matching, duplicate-launch prevention, state events, close isolation, PID reuse, inspection failures, and macOS action logic with AppKit-shaped doubles. Native verification starts two isolated hidden Electron fixtures on the current OS, verifies their identities, activates the original instance, normally closes A, confirms B is unaffected, and force-stops B. On Windows it also verifies restoration of a minimized window. The Node parent cleans fixture data after Electron exits.

UI verification checks the preload/event bridge, sidebar badges, dynamic start/open/close buttons, external exits, stale snapshots, and that status events do not rerun environment diagnostics. The GitHub Actions matrix runs these checks on Windows and macOS. A local Windows pass does not substitute for a successful native macOS run.
