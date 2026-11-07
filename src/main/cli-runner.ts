// Standalone runtime: this compiled file is copied outside app.asar and runs
// through the manager's bundled Node runtime without opening the desktop UI.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

export interface CliManifest {
  kind: "codex-profile-cli";
  version: 1;
  profileId: string;
  codexHome: string;
  registryPath: string;
  secretsPath: string;
  masterKeyPath: string;
  runtimeExecutable: string;
  runnerPath: string;
  home: string;
  fallbackPath: string;
  cliExecutablePath: string | null;
  shimHash: string;
}

async function readJson(file: string): Promise<any> { return JSON.parse(await fs.readFile(file, "utf8")); }
async function exists(file: string): Promise<boolean> { try { await fs.access(file, process.platform === "win32" || /\.m?js$/i.test(file) ? fs.constants.F_OK : fs.constants.X_OK); return (await fs.stat(file)).isFile(); } catch { return false; } }
interface CliTarget { file: string; args: string[]; extraPath?: string[]; managedByNpm?: boolean }

async function nativeTarget(file: string): Promise<CliTarget> {
  const root = path.dirname(path.dirname(file));
  if (path.basename(path.dirname(file)) === "codex" && /(?:apple-darwin|windows-msvc)$/.test(path.basename(root))) {
    const bin = path.join(root, "path");
    return { file, args: [], extraPath: await fs.stat(bin).then(stat => stat.isDirectory() ? [bin] : []).catch(() => []), managedByNpm: true };
  }
  return { file, args: [] };
}

async function unwrapCli(candidate: string): Promise<CliTarget | null> {
  if (!await exists(candidate)) return null;
  try {
    if ((await readJson(`${candidate}.json`)).kind === "codex-profile-cli") throw new Error("A profile CLI cannot use another profile CLI as its underlying Codex executable.");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("A profile CLI")) throw error;
  }
  candidate = await fs.realpath(candidate);
  try {
    if ((await readJson(`${candidate}.json`)).kind === "codex-profile-cli") throw new Error("A profile CLI cannot use another profile CLI as its underlying Codex executable.");
  } catch (error) { if (error instanceof Error && error.message.startsWith("A profile CLI")) throw error; }
  if (/\.(?:cmd|bat|ps1)$/i.test(candidate)) {
    const script = path.join(path.dirname(candidate), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (!await exists(script)) return null;
    candidate = script;
  }
  if (/\.m?js$/i.test(candidate)) {
    // npm Codex shims have native platform packages; prefer that native binary.
    const target = process.platform === "win32" ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc` : `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
    try {
      const require = createRequire(path.resolve(candidate));
      const platformPackage = require.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
      const native = path.join(path.dirname(platformPackage), "vendor", target, "codex", process.platform === "win32" ? "codex.exe" : "codex");
      if (await exists(native)) return nativeTarget(native);
    } catch { /* Older npm installations keep vendor inside @openai/codex. */ }
    const native = path.resolve(path.dirname(candidate), "..", "vendor", target, "codex", process.platform === "win32" ? "codex.exe" : "codex");
    if (await exists(native)) return nativeTarget(native);
    return { file: process.execPath, args: [candidate] };
  }
  return nativeTarget(candidate);
}

export async function resolveCliTarget(env: NodeJS.ProcessEnv, manifest: Pick<CliManifest, "fallbackPath" | "cliExecutablePath" | "home">): Promise<CliTarget> {
  const explicit = env.CODEX_PROFILE_CLI_PATH;
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit.startsWith("~/") ? path.join(manifest.home, explicit.slice(2)) : explicit);
  else {
    if (manifest.cliExecutablePath) candidates.push(manifest.cliExecutablePath);
    const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
    for (const directory of [...pathValue.split(path.delimiter), ...manifest.fallbackPath.split(path.delimiter)]) {
      if (!directory) continue;
      for (const name of process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat"] : ["codex"]) candidates.push(path.join(directory, name));
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    const result = await unwrapCli(candidate);
    if (result) return result;
  }
  throw new Error("Codex CLI was not found. Install Codex CLI or set CODEX_PROFILE_CLI_PATH in this profile's .env to its executable.");
}

export async function buildCliEnvironment(manifest: CliManifest, inherited: NodeJS.ProcessEnv): Promise<{ env: NodeJS.ProcessEnv; profile: any }> {
  const registry = await readJson(manifest.registryPath);
  const profile = registry.profiles.find((entry: any) => entry.id === manifest.profileId);
  if (!profile || profile.status === "deleted" || path.resolve(profile.paths.codexHome) !== path.resolve(manifest.codexHome)) throw new Error("This profile is missing, removed, or has moved. Regenerate its CLI command in Codex Launcher.");
  const env: NodeJS.ProcessEnv = {};
  const keyName = (key: string) => process.platform === "win32" ? key.toUpperCase() : key;
  const forbidden = new Set(["CODEX_HOME", "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", ...registry.profiles.map((entry: any) => entry.provider?.envKeyName).filter(Boolean)].map(keyName));
  for (const [key, value] of Object.entries(inherited)) if (value !== undefined && !forbidden.has(keyName(key)) && !/^CODEX_PROFILE_.*_API_KEY$/i.test(key)) env[keyName(key)] = value;
  let localPath = false;
  try {
    const local = parseEnv(await fs.readFile(path.join(manifest.codexHome, ".env"), "utf8"));
    for (const [key, value] of Object.entries(local)) env[keyName(key)] = value;
    localPath = Object.keys(local).some(key => keyName(key) === "PATH");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read this profile's .env file."); }
  if (!localPath) env.PATH = [...new Set([...(env.PATH ?? "").split(path.delimiter), ...manifest.fallbackPath.split(path.delimiter)].filter(Boolean))].join(path.delimiter);
  env.CODEX_HOME = manifest.codexHome;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  if ((profile.auth?.mode ?? "api_key") !== "chatgpt_account") {
    let apiKey: string | undefined;
    try {
      const encrypted = await readJson(manifest.secretsPath);
      const masterKey = Buffer.from((await fs.readFile(manifest.masterKeyPath, "utf8")).trim(), "base64");
      const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, Buffer.from(encrypted.payload.iv, "base64"));
      decipher.setAuthTag(Buffer.from(encrypted.payload.authTag, "base64"));
      const secrets = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.payload.ciphertext, "base64")), decipher.final()]).toString("utf8"));
      apiKey = secrets.secrets.find((entry: any) => entry.profileId === profile.id && entry.providerId === profile.provider.id)?.value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read this profile's saved API key. Save the key again in Codex Launcher."); }
    if (!apiKey) {
      try { apiKey = (await readJson(path.join(manifest.codexHome, "auth.json"))).OPENAI_API_KEY; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read this profile's auth.json."); }
    }
    if (apiKey) env[keyName(profile.provider.envKeyName)] = apiKey;
  }
  return { env, profile };
}

export async function runProfileCli(manifestPath: string, args: string[]): Promise<void> {
  const manifest = await readJson(manifestPath) as CliManifest;
  if (manifest.kind !== "codex-profile-cli" || manifest.version !== 1) throw new Error("Invalid profile CLI manifest. Regenerate this command.");
  const { env } = await buildCliEnvironment(manifest, process.env);
  const target = await resolveCliTarget(env, manifest);
  if (target.extraPath?.length) env.PATH = [...target.extraPath, env.PATH ?? ""].join(path.delimiter);
  if (target.managedByNpm) env.CODEX_MANAGED_BY_NPM = "1";
  if (target.args.length && target.file === process.execPath && process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  const argv = [...target.args, ...args];
  if (process.platform !== "win32" && process.execve) {
    process.execve(target.file, [target.file, ...argv], env as Record<string, string>);
    return;
  }
  const child = spawn(target.file, argv, { stdio: "inherit", env, shell: false, windowsHide: true });
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => { if (signal !== "SIGINT" || (!process.stdin.isTTY && process.platform !== "win32")) child.kill(signal); };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143); resolve(); });
  }).finally(() => { for (const [signal, handler] of handlers) process.off(signal, handler); });
}

const modulePath = fileURLToPath(import.meta.url);
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
if (process.argv[1] && samePath(path.basename(process.argv[1]), path.basename(modulePath))) {
  Promise.all([fs.realpath(process.argv[1]), fs.realpath(modulePath)]).then(async ([entry, module]) => {
    if (samePath(entry, module)) await runProfileCli(process.argv[2], process.argv.slice(3));
  }).catch((error) => {
    process.stderr.write(`Codex profile CLI: ${error instanceof Error ? error.message : "Launch failed."}\n`);
    process.exitCode = 1;
  });
}
