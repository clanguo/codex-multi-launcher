import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAppPaths } from "./paths.js";

const execFileAsync = promisify(execFile);
const registrations = new Map<string, Promise<{ registered: boolean; error?: string }>>();
const START = "# >>> Codex Profile CLI commands >>>";
const END = "# <<< Codex Profile CLI commands <<<";
function shQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
function xml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

export function prependCliPath(current: string, entry: string, platform = process.platform): string {
  const separator = platform === "win32" ? ";" : ":";
  const normalize = (value: string) => platform === "win32" ? value.replace(/[\\/]+$/, "").toLowerCase() : value.replace(/\/+$/, "");
  return [entry, ...current.split(separator).filter(value => value && normalize(value) !== normalize(entry))].join(separator);
}

export function updateShellPath(source: string, entry: string): string {
  const block = `${START}\ncase ":$PATH:" in\n  *:${shQuote(entry)}:*) ;;\n  *) export PATH=${shQuote(entry)}:"$PATH" ;;\nesac\n${END}`;
  const existing = new RegExp(`${START}[\\s\\S]*?${END}`);
  if (existing.test(source)) return source.replace(existing, () => block);
  return `${source}${source && !source.endsWith("\n") ? "\n" : ""}\n${block}\n`;
}

export const WINDOWS_CLI_PATH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$entry = $env:CODEX_PROFILE_BIN_ENTRY
$environmentKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $current = [string]$environmentKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $entries = @($current -split ';' | Where-Object { $_ -and $_.Trim('"').TrimEnd([char]92,[char]47) -ine $entry.TrimEnd([char]92,[char]47) })
  $next = (@($entry) + $entries) -join ';'
  if ($next -cne $current) { $environmentKey.SetValue('Path', $next, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
} finally { $environmentKey.Dispose() }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ProfilePathNotification {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
$result = [UIntPtr]::Zero
[void][ProfilePathNotification]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 1000, [ref]$result)
`;

export async function registerProfileCliPath(options: { persist?: boolean; applySystem?: boolean; force?: boolean } = {}): Promise<{ registered: boolean; error?: string }> {
  const { defaultCliRoot, appDataDir } = getAppPaths();
  const key = process.platform === "win32" ? Object.keys(process.env).find(key => key.toLowerCase() === "path") ?? "PATH" : "PATH";
  process.env[key] = prependCliPath(process.env[key] ?? "", defaultCliRoot);
  const persist = options.persist ?? !process.env.CODEX_PROFILE_MANAGER_HOME_OVERRIDE;
  if (!persist) return { registered: true };
  if (options.force) registrations.delete(defaultCliRoot);
  const existing = registrations.get(defaultCliRoot);
  if (existing) return existing;
  const pending = (async () => {
    try {
      if (process.platform === "win32") {
        if (options.applySystem !== false) await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_CLI_PATH_SCRIPT, "utf16le").toString("base64")], {
          env: { ...process.env, CODEX_PROFILE_BIN_ENTRY: defaultCliRoot }, windowsHide: true, timeout: 15000
        });
      } else if (process.platform === "darwin") {
        const home = path.dirname(defaultCliRoot);
        let bashLogin = ".profile";
        for (const filename of [".bash_profile", ".bash_login", ".profile"]) {
          try { await fs.access(path.join(home, filename)); bashLogin = filename; break; } catch {}
        }
        for (const filename of [".zshrc", ".zprofile", ".bashrc", bashLogin]) {
          const file = path.join(home, filename);
          let source = "";
          try { source = await fs.readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          const next = updateShellPath(source, defaultCliRoot);
          if (next !== source) await fs.writeFile(file, next, { mode: 0o600 });
        }
        const scriptPath = path.join(appDataDir, "cli-path.sh");
        const script = `#!/bin/sh\nprofile_cli_path=$(/bin/launchctl getenv PATH 2>/dev/null || true)\n[ -n "$profile_cli_path" ] || profile_cli_path='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'\ncase ":$profile_cli_path:" in\n  *:${shQuote(defaultCliRoot)}:*) ;;\n  *) profile_cli_path=${shQuote(defaultCliRoot)}:"$profile_cli_path" ;;\nesac\n/bin/launchctl setenv PATH "$profile_cli_path"\n`;
        await fs.mkdir(appDataDir, { recursive: true });
        await fs.writeFile(scriptPath, script, { mode: 0o700 });
        const agentPath = path.join(home, "Library", "LaunchAgents", "local.codexprofilemanager.cli-path.plist");
        await fs.mkdir(path.dirname(agentPath), { recursive: true });
        await fs.writeFile(agentPath, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>local.codexprofilemanager.cli-path</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(scriptPath)}</string></array><key>RunAtLoad</key><true/></dict></plist>\n`, { mode: 0o600 });
        if (options.applySystem !== false) {
          await execFileAsync("/bin/sh", [scriptPath], { timeout: 10000 });
          // The plist restores the PATH entry after login. New apps inherit it;
          // already-running terminals/daemons must be restarted once.
          const domain = `gui/${process.getuid!()}`;
          await execFileAsync("/bin/launchctl", ["bootout", `${domain}/local.codexprofilemanager.cli-path`], { timeout: 10000 }).catch(() => {});
          await execFileAsync("/bin/launchctl", ["bootstrap", domain, agentPath], { timeout: 10000 });
        }
      }
      return { registered: true };
    } catch (error) {
      registrations.delete(defaultCliRoot);
      return { registered: false, error: error instanceof Error ? error.message : "Could not register the CLI command directory in PATH." };
    }
  })();
  registrations.set(defaultCliRoot, pending);
  return pending;
}
