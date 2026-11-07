import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import path from "node:path";
import { getRuntimePlatform, type SupportedPlatform } from "./paths.js";
import type { ManagedProfile } from "../shared/types.js";

const execFileAsync = promisify(execFile);

export interface RuntimeProcess {
  pid: number;
  command: string;
  executable: string;
  startTime: string;
  hasWindow: boolean | null;
}

export type WindowAction = "focus" | "close" | "force";
export interface WindowActionResult { performed: boolean; hasWindow: boolean | null }
export interface RuntimePlatform {
  platform: SupportedPlatform;
  scan(profiles: ManagedProfile[]): Promise<RuntimeProcess[]>;
  inspect(processes: RuntimeProcess[]): Promise<RuntimeProcess[]>;
  act(process: RuntimeProcess, action: WindowAction): Promise<WindowActionResult>;
  dispose(): void;
}

// One PowerShell process serves all profiles. Native declarations compile once.
export const WINDOWS_RUNTIME_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ProfileWindows {
  public delegate bool WindowCallback(IntPtr hwnd, IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr state);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool FlashWindow(IntPtr hwnd, bool invert);
  public static IntPtr[] Windows(int target) {
    var found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr hwnd, IntPtr state) {
      uint owner; GetWindowThreadProcessId(hwnd, out owner);
      if (owner == target && GetWindowTextLength(hwnd) > 0) found.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
  public static bool HasWindow(int target) {
    foreach (var hwnd in Windows(target)) if (IsWindowVisible(hwnd)) return true;
    return false;
  }
  public static bool Focus(int target) {
    foreach (var hwnd in Windows(target)) {
      if (!IsWindowVisible(hwnd)) continue;
      ShowWindowAsync(hwnd, IsIconic(hwnd) ? 9 : 5);
      if (SetForegroundWindow(hwnd) || GetForegroundWindow() == hwnd) return true;
      FlashWindow(hwnd, true);
      return false;
    }
    return false;
  }
  public static bool Close(int target) {
    bool sent = false;
    foreach (var hwnd in Windows(target)) sent = PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero) || sent;
    return sent;
  }
}
'@ | Out-Null
$processCache = @{}
function Convert-ProcessRow($row) {
  try { $native = [Diagnostics.Process]::GetProcessById([int]$row.ProcessId) }
  catch [ArgumentException] { return }
  try { $nativeStart = $native.StartTime.ToUniversalTime().Ticks.ToString() }
  finally { $native.Dispose() }
  $converted = [PSCustomObject]@{
    pid = [int]$row.ProcessId
    command = [string]$row.CommandLine
    executable = [string]$row.ExecutablePath
    startTime = $row.CreationDate.ToUniversalTime().Ticks.ToString()
    hasWindow = [ProfileWindows]::HasWindow([int]$row.ProcessId)
  }
  $processCache[[int]$row.ProcessId] = @{ nativeStart = $nativeStart; row = $converted }
  return $converted
}
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = $null
  try {
    $request = $line | ConvertFrom-Json
    if ($request.action -eq 'scan') {
        $parts = @($request.names | ForEach-Object {
          if ($_ -notmatch '^[\w .()-]+\.exe$') { throw 'Invalid executable name' }
          "Name='$_'"
        })
      $result = @()
      $processCache = @{}
      if ($parts.Count -gt 0) {
        $result = @(Get-CimInstance Win32_Process -Filter ($parts -join ' OR ') | Where-Object { $_.CommandLine -and $_.ExecutablePath } | ForEach-Object { Convert-ProcessRow $_ })
      }
    } elseif ($request.action -eq 'inspect') {
      $result = @()
      foreach ($processId in $request.pids) {
        if ([int]$processId -le 0) { throw 'Invalid process ID' }
        $cached = $processCache[[int]$processId]
        if (-not $cached) { throw 'The process cache expired; run discovery again.' }
        try { $native = [Diagnostics.Process]::GetProcessById([int]$processId) }
        catch [ArgumentException] { $processCache.Remove([int]$processId); continue }
        try {
          if ($native.StartTime.ToUniversalTime().Ticks.ToString() -cne $cached.nativeStart) {
            $processCache.Remove([int]$processId)
            continue
          }
          $cached.row.hasWindow = [ProfileWindows]::HasWindow([int]$processId)
          $result += $cached.row
        } finally { $native.Dispose() }
      }
    } elseif ($request.action -in @('focus', 'close', 'force')) {
      $expected = $request.process
      if ([int]$expected.pid -le 0) { throw 'Invalid process ID' }
      $heldProcess = [Diagnostics.Process]::GetProcessById([int]$expected.pid)
      try {
        $null = $heldProcess.Handle
        $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$expected.pid)
        if (-not $current -or $current.CreationDate.ToUniversalTime().Ticks.ToString() -cne $expected.startTime -or $current.CommandLine -cne $expected.command -or $current.ExecutablePath -ine $expected.executable) {
          throw 'The process identity changed; refresh the profile status and retry.'
        }
        $hasWindow = [ProfileWindows]::HasWindow([int]$expected.pid)
        if ($request.action -eq 'force') { $heldProcess.Kill(); $performed = $true }
        elseif ($request.action -eq 'close') { $performed = [ProfileWindows]::Close([int]$expected.pid) }
        else { $performed = [ProfileWindows]::Focus([int]$expected.pid) }
        $result = @{ performed = [bool]$performed; hasWindow = [bool]$hasWindow }
      } finally { $heldProcess.Dispose() }
    } else { throw 'Unsupported runtime action' }
    @{ id = $request.id; ok = $true; result = $result } | ConvertTo-Json -Depth 8 -Compress | ForEach-Object { [Console]::WriteLine($_) }
  } catch {
    @{ id = $request.id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress | ForEach-Object { [Console]::WriteLine($_) }
  }
}
`;

export class WindowsRuntimePlatform implements RuntimePlatform {
  platform = "win32" as const;
  private worker: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  private request<T>(payload: Record<string, unknown>): Promise<T> {
    if (!this.worker) {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_RUNTIME_SCRIPT, "utf16le").toString("base64")], {
        windowsHide: true, stdio: "pipe"
      });
      this.worker = child;
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
      const reader = createInterface({ input: child.stdout });
      reader.on("line", (line) => {
        try {
          const message = JSON.parse(line);
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.ok) pending.resolve(message.result);
          else pending.reject(new Error(message.error || "Runtime helper failed."));
        } catch { /* PowerShell startup output is not a protocol response. */ }
      });
      child.stderr.resume();
      child.stdin.on("error", () => this.reset(new Error("Runtime helper input closed."), child));
      child.on("error", (error) => this.reset(error, child));
      child.on("exit", () => { reader.close(); this.reset(new Error("Runtime helper exited."), child); });
    }
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.reset(new Error("Runtime helper timed out.")), 12000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.worker!.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
    });
  }

  private reset(error: Error, expectedWorker = this.worker): void {
    if (expectedWorker !== this.worker) return;
    const worker = this.worker;
    this.worker = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    worker?.kill();
  }

  scan(profiles: ManagedProfile[]): Promise<RuntimeProcess[]> {
    const names = [...new Set(["Codex.exe", "ChatGPT.exe", ...profiles.map((profile) => path.win32.basename(profile.paths.codexAppPath)).filter((name) => name.toLowerCase().endsWith(".exe"))])];
    return this.request({ action: "scan", names });
  }
  inspect(processes: RuntimeProcess[]): Promise<RuntimeProcess[]> {
    if (!processes.length) return Promise.resolve([]);
    return this.request({ action: "inspect", pids: [...new Set(processes.map((process) => process.pid))] });
  }
  act(process: RuntimeProcess, action: WindowAction): Promise<WindowActionResult> { return this.request({ action, process }); }
  dispose(): void { this.reset(new Error("Runtime monitoring stopped.")); }
}

export function parseMacProcesses(output: string): RuntimeProcess[] {
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/);
    if (!match) return [];
    const command = match[3];
    const executable = command.match(/^(.*?\/Contents\/MacOS\/[^/ ]+)(?:\s|$)/)?.[1] ?? command.split(" ")[0];
    return [{ pid: Number(match[1]), startTime: match[2].replace(/\s+/g, " "), command, executable, hasWindow: null }];
  });
}

export const MAC_RUNTIME_ACTION_SCRIPT = String.raw`
ObjC.import('AppKit');
function run(argv) {
  var request = JSON.parse(argv[0]);
  var expected = request.process;
  var target = $.NSRunningApplication.runningApplicationWithProcessIdentifier(expected.pid);
  if (!target || target.isNil() || target.isTerminated) throw new Error('The profile process has exited.');
  // Validate against the same kernel process timestamp used for discovery.
  // AppKit launchDate may describe app registration after a launcher exec.
  var probe = $.NSTask.alloc.init;
  probe.launchPath = '/bin/ps';
  probe.arguments = ['-p', String(expected.pid), '-ww', '-o', 'lstart=,args='];
  var environment = $.NSProcessInfo.processInfo.environment.mutableCopy;
  environment.setObjectForKey('C', 'LC_ALL');
  probe.environment = environment;
  var output = $.NSPipe.pipe;
  probe.standardOutput = output;
  probe.standardError = $.NSPipe.pipe;
  probe.launch;
  var data = output.fileHandleForReading.readDataToEndOfFile;
  probe.waitUntilExit;
  var text = String(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)));
  var observed = text.match(/^\s*(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+?)\s*$/);
  if (Number(probe.terminationStatus) !== 0 || !observed ||
      observed[1].replace(/\s+/g, ' ') !== expected.startTime || observed[2] !== expected.command || target.isTerminated ||
      String(ObjC.unwrap(target.executableURL.path)) !== expected.executable) {
    throw new Error('The process identity changed; refresh the profile status and retry.');
  }
  var performed;
  if (request.action === 'focus') performed = target.activateWithOptions(3);
  else if (request.action === 'close') performed = target.terminate;
  else if (request.action === 'force') performed = target.forceTerminate;
  else throw new Error('Unsupported runtime action');
  return JSON.stringify({ performed: Boolean(performed), hasWindow: null });
}
`;

export class MacRuntimePlatform implements RuntimePlatform {
  platform = "darwin" as const;
  private async query(pids?: number[]): Promise<RuntimeProcess[]> {
    if (pids && !pids.length) return [];
    try {
      const { stdout } = await execFileAsync("/bin/ps", [pids ? "-p" : "-ax", ...(pids ? [pids.join(",")] : []), "-ww", "-o", "pid=,lstart=,args="], {
        env: { ...process.env, LC_ALL: "C" }, timeout: 10000, maxBuffer: 4 * 1024 * 1024
      });
      return parseMacProcesses(stdout);
    } catch (error) {
      const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
      if (pids && failure.code === 1 && !failure.stderr?.trim()) return parseMacProcesses(failure.stdout ?? "");
      throw error;
    }
  }
  scan(): Promise<RuntimeProcess[]> { return this.query(); }
  inspect(processes: RuntimeProcess[]): Promise<RuntimeProcess[]> { return this.query([...new Set(processes.map((process) => process.pid))]); }
  async act(process: RuntimeProcess, action: WindowAction): Promise<WindowActionResult> {
    const current = (await this.inspect([process])).find((row) => row.pid === process.pid);
    if (!current || current.startTime !== process.startTime || current.command !== process.command) throw new Error("The process identity changed; refresh the profile status and retry.");
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_RUNTIME_ACTION_SCRIPT, JSON.stringify({ process, action })], { timeout: 10000 });
    return JSON.parse(stdout.trim()) as WindowActionResult;
  }
  dispose(): void { /* Queries and actions are short-lived native commands. */ }
}

export function createRuntimePlatform(): RuntimePlatform {
  const platform = getRuntimePlatform();
  if (platform === "win32") return new WindowsRuntimePlatform();
  if (platform === "darwin") return new MacRuntimePlatform();
  throw new Error("Profile window management supports Windows and macOS.");
}
