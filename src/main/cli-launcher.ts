import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { parseEnv, promisify } from "node:util";
import { getAppPaths, profileCliCommand, profileCliPath } from "./paths.js";
import { defaultExecutablePathEnv } from "./executable-lookup.js";
import { registerProfileCliPath } from "./cli-path.js";
import { resolveCliTarget, type CliManifest } from "./cli-runner.js";
import { WINDOWS_CLI_SHIM } from "./cli-windows-shim.js";
import type { ManagedProfile, ProfileCliInfo } from "../shared/types.js";

const execFileAsync = promisify(execFile);
const runtimes = new Map<string, Promise<{ runnerPath: string; shimPath: string; shimHash: string }>>();
const generations = new Map<string, Promise<ProfileCliInfo>>();
function quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }

async function prepareRuntime() {
  const source = await fs.readFile(fileURLToPath(new URL("./cli-runner.js", import.meta.url)), "utf8");
  const hash = crypto.createHash("sha256").update(source).update(WINDOWS_CLI_SHIM).digest("hex").slice(0, 16);
  const shimHash = crypto.createHash("sha256").update(WINDOWS_CLI_SHIM).digest("hex");
  const root = path.join(getAppPaths().appDataDir, "cli-runtime", hash);
  const existing = runtimes.get(root);
  if (existing) return existing;
  const pending = (async () => {
    await fs.mkdir(root, { recursive: true });
    const runnerPath = path.join(root, "runner.mjs");
    const shimPath = path.join(root, "profile-cli.exe");
    if (!await exists(runnerPath)) await fs.writeFile(runnerPath, source, { mode: 0o600 });
    if (process.platform === "win32" && !await exists(shimPath)) {
      const bundled = fileURLToPath(new URL("./profile-cli.exe", import.meta.url));
      const signature = `${bundled}.sha256`;
      if (await fs.readFile(signature, "utf8").catch(() => "") === shimHash && await exists(bundled)) {
        await fs.writeFile(shimPath, await fs.readFile(bundled), { mode: 0o700 });
        return { runnerPath, shimPath, shimHash };
      }
      const sourcePath = path.join(root, "profile-cli.cs");
      await fs.writeFile(sourcePath, WINDOWS_CLI_SHIM);
      const script = "Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:CODEX_PROFILE_SHIM_SOURCE)) -OutputAssembly $env:CODEX_PROFILE_SHIM_OUTPUT -OutputType ConsoleApplication -ReferencedAssemblies System.Web.Extensions.dll -ErrorAction Stop";
      await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        env: { ...process.env, CODEX_PROFILE_SHIM_SOURCE: sourcePath, CODEX_PROFILE_SHIM_OUTPUT: shimPath }, windowsHide: true, timeout: 30000
      });
    }
    return { runnerPath, shimPath, shimHash };
  })();
  runtimes.set(root, pending);
  void pending.catch(() => runtimes.delete(root));
  return pending;
}

export function generateCliLauncher(profile: ManagedProfile): Promise<ProfileCliInfo> {
  const executablePath = profileCliPath(profile.id);
  const existing = generations.get(executablePath);
  if (existing) return existing;
  const pending = (async () => {
    const appPaths = getAppPaths();
    await fs.mkdir(appPaths.defaultCliRoot, { recursive: true });
    let previous: CliManifest | null = null;
    try { previous = JSON.parse(await fs.readFile(`${executablePath}.json`, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The existing CLI command manifest is invalid."); }
    if (await exists(executablePath) && (previous?.kind !== "codex-profile-cli" || previous.profileId !== profile.id)) throw new Error(`CLI command ${profileCliCommand(profile.id)} already exists and is not owned by this profile.`);
    const runtime = await prepareRuntime();
    let cliExecutablePath: string | null = null;
    try {
      let profileEnv = {};
      try { profileEnv = parseEnv(await fs.readFile(path.join(profile.paths.codexHome, ".env"), "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const target = await resolveCliTarget({ ...process.env, ...profileEnv }, { fallbackPath: defaultExecutablePathEnv(), home: path.dirname(appPaths.defaultCliRoot), cliExecutablePath: null });
      cliExecutablePath = target.args[0] ?? target.file;
    } catch { /* Commands can be generated before Codex CLI is installed. */ }
    const manifest: CliManifest = {
      kind: "codex-profile-cli", version: 1, profileId: profile.id, codexHome: profile.paths.codexHome,
      registryPath: appPaths.profilesFile, secretsPath: appPaths.secretsFile, masterKeyPath: appPaths.masterKeyFile,
      runtimeExecutable: process.execPath, runnerPath: runtime.runnerPath, home: path.dirname(appPaths.defaultCliRoot),
      fallbackPath: defaultExecutablePathEnv(), cliExecutablePath, shimHash: runtime.shimHash
    };
    const next = `${JSON.stringify(manifest, null, 2)}\n`;
    const prior = previous ? `${JSON.stringify(previous, null, 2)}\n` : null;
    if (next !== prior) {
      const temporary = `${executablePath}.${crypto.randomUUID()}.json`;
      await fs.writeFile(temporary, next, { mode: 0o600 });
      await fs.rename(temporary, `${executablePath}.json`);
    }
    let command: Buffer | string | null = null;
    if (process.platform === "win32") {
      if (!await exists(executablePath) || previous?.shimHash !== runtime.shimHash) command = await fs.readFile(runtime.shimPath);
    } else {
      const shell = `#!/bin/sh\nunset NODE_OPTIONS\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(process.execPath)} ${quote(runtime.runnerPath)} ${quote(`${executablePath}.json`)} "$@"\n`;
      if (!await exists(executablePath) || await fs.readFile(executablePath, "utf8") !== shell) command = shell;
    }
    if (command !== null) {
      const temporary = `${executablePath}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, command, { mode: 0o700 }); await fs.rename(temporary, executablePath); }
      finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    }
    const registration = await registerProfileCliPath();
    return { command: profileCliCommand(profile.id), executablePath, pathEntry: appPaths.defaultCliRoot, cliExecutablePath, pathRegistered: registration.registered, pathError: registration.error };
  })();
  generations.set(executablePath, pending);
  void pending.finally(() => { if (generations.get(executablePath) === pending) generations.delete(executablePath); }).catch(() => {});
  return pending;
}

export async function removeCliLauncher(profile: ManagedProfile): Promise<void> {
  const file = profileCliPath(profile.id);
  try {
    const manifest = JSON.parse(await fs.readFile(`${file}.json`, "utf8"));
    if (manifest.kind !== "codex-profile-cli" || manifest.profileId !== profile.id) return;
    await fs.rm(file, { force: true });
    await fs.rm(`${file}.json`, { force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
