import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ManagedProfile } from "../shared/types.js";

const execFileAsync = promisify(execFile);

export interface WindowsTaskbarIdentityResult {
  pid: number;
  windowHandle: string;
  appUserModelId: string;
}

export interface WindowsProfileTaskbarIdentity {
  appUserModelId: string;
  iconPath: string;
  shortcutPath: string;
}

export async function prepareWindowsProfileTaskbarIdentity(
  profile: ManagedProfile,
  codexExecutable: string
): Promise<WindowsProfileTaskbarIdentity> {
  const iconPath = path.join(profile.paths.codexHome, "profile-taskbar.ico");
  const appUserModelId = `CodexProfileManager.Profile.${profile.id}`;
  const script = buildPrepareWindowsProfileTaskbarIdentityScript({
    profileId: profile.id,
    profileName: profile.name,
    iconPath,
    iconColor: profile.appearance.iconBackgroundColor,
    codexExecutable,
    userDataDir: profile.paths.userDataDir,
    appUserModelId
  });
  await runPowerShell(script, 35_000);
  return {
    appUserModelId,
    iconPath,
    shortcutPath: path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Codex Profile Manager", `${profile.id}.lnk`)
  };
}

export async function removeWindowsProfileTaskbarIdentity(profileId: string): Promise<void> {
  const script = `
$ErrorActionPreference = "Stop"
$shortcutPath = Join-Path $env:APPDATA ${powershellLiteral(`Microsoft\\Windows\\Start Menu\\Programs\\Codex Profile Manager\\${profileId}.lnk`)}
Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
`;
  await runPowerShell(script, 10_000);
}

export async function restoreWindowsDesktopTaskbarIdentity(
  pid: number,
  appUserModelId: string,
  iconPath: string
): Promise<WindowsTaskbarIdentityResult> {
  const script = buildWindowsTaskbarIdentityScript(pid, appUserModelId, iconPath);
  const { stdout } = await runPowerShell(script, 35_000);
  const result = JSON.parse(stdout.trim()) as WindowsTaskbarIdentityResult;
  if (!result.pid || !result.windowHandle || !result.appUserModelId) {
    throw new Error("Windows taskbar identity helper returned an invalid result.");
  }
  return result;
}

export function buildPrepareWindowsProfileTaskbarIdentityScript(input: {
  profileId: string;
  profileName: string;
  iconPath: string;
  iconColor: string;
  codexExecutable: string;
  userDataDir: string;
  appUserModelId: string;
}): string {
  const monogram = [...input.profileName.trim()][0] ?? "C";
  return `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CodexProfileShortcutProperties {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  private struct PropertyKey {
    public Guid formatId;
    public uint propertyId;
    public PropertyKey(Guid formatId, uint propertyId) { this.formatId = formatId; this.propertyId = propertyId; }
  }

  [StructLayout(LayoutKind.Explicit)]
  private struct PropVariant {
    [FieldOffset(0)] public ushort valueType;
    [FieldOffset(8)] public IntPtr pointerValue;
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
    [PreserveSig] int Commit();
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
  private static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr bindContext, uint flags, ref Guid interfaceId, out IPropertyStore store);
  [DllImport("ole32.dll", PreserveSig = true)] private static extern int PropVariantClear(ref PropVariant value);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool DestroyIcon(IntPtr iconHandle);

  public static void SetAppUserModelId(string shortcutPath, string appUserModelId) {
    Guid interfaceId = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    IPropertyStore store;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(shortcutPath, IntPtr.Zero, 2, ref interfaceId, out store));
    PropertyKey key = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
    PropVariant value = new PropVariant { valueType = 31, pointerValue = Marshal.StringToCoTaskMemUni(appUserModelId) };
    try { Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value)); Marshal.ThrowExceptionForHR(store.Commit()); }
    finally { PropVariantClear(ref value); Marshal.ReleaseComObject(store); }
  }
}
'@

$iconPath = ${powershellLiteral(input.iconPath)}
$iconDirectory = Split-Path -Parent $iconPath
New-Item -ItemType Directory -Force -Path $iconDirectory | Out-Null
$bitmap = [System.Drawing.Bitmap]::new(64, 64, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)
$color = [System.Drawing.ColorTranslator]::FromHtml(${powershellLiteral(input.iconColor)})
$brush = [System.Drawing.SolidBrush]::new($color)
$shape = New-Object System.Drawing.Drawing2D.GraphicsPath
$shape.AddArc(2, 2, 20, 20, 180, 90)
$shape.AddArc(42, 2, 20, 20, 270, 90)
$shape.AddArc(42, 42, 20, 20, 0, 90)
$shape.AddArc(2, 42, 20, 20, 90, 90)
$shape.CloseFigure()
$graphics.FillPath($brush, $shape)
$font = [System.Drawing.Font]::new("Segoe UI", 31, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$format = [System.Drawing.StringFormat]::new()
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$textBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$graphics.DrawString(${powershellLiteral(monogram)}, $font, $textBrush, [System.Drawing.RectangleF]::new(1, 0, 62, 62), $format)
$iconHandle = $bitmap.GetHicon()
try {
  $icon = [System.Drawing.Icon]::FromHandle($iconHandle)
  $stream = [System.IO.File]::Create($iconPath)
  try { $icon.Save($stream) } finally { $stream.Dispose() }
} finally {
  [CodexProfileShortcutProperties]::DestroyIcon($iconHandle)
}
$graphics.Dispose(); $bitmap.Dispose(); $brush.Dispose(); $shape.Dispose(); $font.Dispose(); $format.Dispose(); $textBrush.Dispose()

$shortcutDirectory = Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs\\Codex Profile Manager"
New-Item -ItemType Directory -Force -Path $shortcutDirectory | Out-Null
$shortcutPath = Join-Path $shortcutDirectory ${powershellLiteral(`${input.profileId}.lnk`)}
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = ${powershellLiteral(input.codexExecutable)}
$shortcut.Arguments = ${powershellLiteral(`--user-data-dir="${input.userDataDir}"`)}
$shortcut.WorkingDirectory = Split-Path -Parent ${powershellLiteral(input.codexExecutable)}
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Description = ${powershellLiteral(input.profileName)}
$shortcut.Save()
[CodexProfileShortcutProperties]::SetAppUserModelId($shortcutPath, ${powershellLiteral(input.appUserModelId)})
`;
}

export function buildWindowsTaskbarIdentityScript(pid: number, appUserModelId: string, iconPath: string): string {
  return `
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CodexTaskbarIdentity {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  private struct PropertyKey {
    public Guid formatId;
    public uint propertyId;
    public PropertyKey(Guid formatId, uint propertyId) { this.formatId = formatId; this.propertyId = propertyId; }
  }

  [StructLayout(LayoutKind.Explicit)]
  private struct PropVariant {
    [FieldOffset(0)] public ushort valueType;
    [FieldOffset(8)] public IntPtr pointerValue;
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
    [PreserveSig] int Commit();
  }

  [DllImport("shell32.dll", PreserveSig = true)]
  private static extern int SHGetPropertyStoreForWindow(IntPtr windowHandle, ref Guid interfaceId, [Out, MarshalAs(UnmanagedType.Interface)] out IPropertyStore propertyStore);
  [DllImport("ole32.dll", PreserveSig = true)] private static extern int PropVariantClear(ref PropVariant value);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int width, int height, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessage(IntPtr windowHandle, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool DestroyIcon(IntPtr iconHandle);

  public static void SetWindowAppUserModelId(IntPtr windowHandle, string appUserModelId) {
    Guid interfaceId = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    IPropertyStore propertyStore;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(windowHandle, ref interfaceId, out propertyStore));
    PropertyKey key = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
    PropVariant value = new PropVariant { valueType = 31, pointerValue = Marshal.StringToCoTaskMemUni(appUserModelId) };
    try { Marshal.ThrowExceptionForHR(propertyStore.SetValue(ref key, ref value)); Marshal.ThrowExceptionForHR(propertyStore.Commit()); }
    finally { PropVariantClear(ref value); Marshal.ReleaseComObject(propertyStore); }
  }

  public static void SetWindowIcon(IntPtr windowHandle, string iconPath) {
    const uint IMAGE_ICON = 1, LR_LOADFROMFILE = 0x10, LR_DEFAULTSIZE = 0x40;
    const uint WM_SETICON = 0x80;
    IntPtr icon = LoadImage(IntPtr.Zero, iconPath, IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE);
    if (icon == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    SendMessage(windowHandle, WM_SETICON, new IntPtr(1), icon);
    SendMessage(windowHandle, WM_SETICON, IntPtr.Zero, icon);
    DestroyIcon(icon);
  }
}
'@

$rootPid = ${pid}
$appUserModelId = ${powershellLiteral(appUserModelId)}
$iconPath = ${powershellLiteral(iconPath)}
$deadline = [DateTime]::UtcNow.AddSeconds(30)
$target = $null
do {
  $candidate = Get-Process -Id $rootPid -ErrorAction SilentlyContinue
  if ($candidate) {
    $candidate.Refresh()
    if ($candidate.MainWindowHandle -ne 0) { $target = $candidate }
  }
  if (-not $target) { Start-Sleep -Milliseconds 150 }
} while (-not $target -and [DateTime]::UtcNow -lt $deadline)
if (-not $target -or $target.MainWindowHandle -eq 0) { throw "Timed out waiting for the Codex desktop window." }
[CodexTaskbarIdentity]::SetWindowAppUserModelId($target.MainWindowHandle, $appUserModelId)
[CodexTaskbarIdentity]::SetWindowIcon($target.MainWindowHandle, $iconPath)
[PSCustomObject]@{ pid = $target.Id; windowHandle = $target.MainWindowHandle.ToString(); appUserModelId = $appUserModelId } | ConvertTo-Json -Compress
`.trim();
}

async function runPowerShell(script: string, timeout: number): Promise<{ stdout: string }> {
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  return execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand
  ], { timeout, windowsHide: true, encoding: "utf8" });
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
