# Profile CLI commands

[简体中文](profile-cli.zh-CN.md)

Each profile has a command such as `codex-api1`. Use that name as the Codex executable in Multica or another platform that supports a custom executable. Select the **Codex** runtime type and let the platform supply its usual arguments. You can also run it in a terminal:

```sh
codex-api1 --version
codex-api1
codex-api2 app-server
```

The name uses the profile's stable ID, so renaming the display name does not break platform bindings. Profiles with the same name receive distinct IDs. Find and copy the actual command under **Profile Codex CLI** in the profile detail page.

## Setup and PATH

Install Codex CLI on the machine, then create a profile or reopen the manager to generate commands for existing profiles. The manager discovers the base CLI from PATH and common macOS installation locations. An installed desktop app alone is not guaranteed to provide a CLI in these locations.

The command directory is `~/.codex-profile-bin`:

| Platform | Command entry | PATH registration |
| --- | --- | --- |
| Windows | `codex-api1.exe`, a native console executable | Prepends the directory to the current user's registry PATH and broadcasts the change. Existing expandable PATH values are retained. |
| macOS | `codex-api1`, an executable shell entry | Adds a guarded block to zsh/bash startup files and a user LaunchAgent that restores GUI PATH at login. |

After first setup, reopen terminals and restart Multica or its background daemon. A process that is already running retains its previous environment. Use **Register PATH again** to repair registration. If a host uses its own restricted PATH, add the displayed command directory to that host's environment, or use **Copy executable path** when the host accepts absolute paths.

The manager must remain installed at its current location: commands use its embedded runtime and shared installed Codex CLI. They do not require a separate Node installation and do not open the manager window. After moving or updating the manager, open it once to refresh command paths.

## Profile configuration and environment

On every invocation, the command:

1. Reads the current profile record and rejects removed profiles.
2. Binds `CODEX_HOME` to that profile's directory, preserving the caller's working directory.
3. Loads that directory's `.env`. Inherited API keys, provider-key variables, endpoint overrides and Node bootstrap options are cleared first. Explicit `.env` values configure that profile's tools. The saved profile API key takes precedence over copied key values; `CODEX_HOME` always remains bound to the profile.
4. Starts the installed Codex CLI with all supplied arguments and unchanged stdin/stdout/stderr. Exit codes reach the calling platform.

Commands share the profile's `config.toml`, credentials and resources with its desktop window. Official profiles do not receive model flags or model presets. API keys are read from the manager's encrypted store on each launch; changing a saved key does not require regenerating the command. Account profiles use their own Codex login storage. If the CLI requests login, run `codex-api1 login` for that profile.

The `.env` parser supports quoted and multiline values. It does not execute shell code or expand `$PATH`, `%PATH%` or variable references. Set a complete PATH value if you override PATH. Otherwise, the caller's PATH is supplemented with the installation paths captured by the manager.

To select a particular CLI version, set its absolute executable path in the profile's `.env`:

```dotenv
# Windows: forward slashes are accepted
CODEX_PROFILE_CLI_PATH="C:/Tools/Codex/codex.exe"
# macOS example instead:
# CODEX_PROFILE_CLI_PATH="/opt/homebrew/bin/codex"
```

This is a launcher setting and must point to the base Codex CLI, not another profile command. npm's Codex entry points are supported without passing arguments through `cmd.exe`.

CLI tasks are owned by the calling platform. They do not appear as desktop windows in the manager's runtime status, and **Close** for a desktop profile does not stop those tasks. Stopping the CLI command cleans up its process tree on Windows; on macOS the platform should signal the task's process group to stop its tools too.

## Removal and verification

Removing a profile disables its command; restoring it enables the same name. Permanent deletion removes the owned executable and manifest. An existing unrelated executable with the same name is preserved, and profile creation reports the conflict. The manifest contains paths and IDs, not API keys. `.env` remains a local plaintext environment file.

Verification uses temporary homes and synthetic keys, without modifying the real user's PATH:

```sh
npm run verify:profile-cli
npm run verify:runtime-ui
```

The Windows/macOS CI matrix exercises named command lookup, authentication isolation, arguments, protocol input/output, working directories, exit codes, cancellation, migration, deletion and PATH handling. The optional local smoke check invokes an installed CLI without making a model request:

```sh
node scripts/verify-profile-cli.mjs --real-cli=/absolute/path/to/codex
```
