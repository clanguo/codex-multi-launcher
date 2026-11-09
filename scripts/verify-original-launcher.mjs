import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-original-launcher-"));
const originalEnv = { ...process.env };
const nativeMethods = { execFile: childProcess.execFile, execFileSync: childProcess.execFileSync, spawn: childProcess.spawn };
const calls = [];
let launchError = null;
let appx = null;
childProcess.execFile = (command, args, options, callback) => {
  calls.push({ command, args, options });
  queueMicrotask(() => callback(launchError, "", ""));
  return new EventEmitter();
};
childProcess.execFileSync = (_command, args) => args.some(arg => arg.includes("Get-AppxPackage")) && appx ? JSON.stringify(appx) : "";
childProcess.spawn = (command, args, options) => {
  calls.push({ command, args, options });
  const child = new EventEmitter();
  child.unref = () => {};
  queueMicrotask(() => child.emit(launchError ? "error" : "spawn", launchError));
  return child;
};
syncBuiltinESMExports();

try {
  process.env.CODEX_PROFILE_MANAGER_HOME_OVERRIDE = testRoot;
  process.env.CODEX_PROFILE_MANAGER_PLATFORM_OVERRIDE = "darwin";
  process.env.CODEX_HOME = path.join(testRoot, "isolated");
  process.env.USER_DATA_DIR = path.join(testRoot, "isolated-user-data");
  process.env.CODEX_PROFILE_MANAGER_LAUNCH = "1";
  process.env.CODEX_PROFILE_TEST_API_KEY = "test-profile-key";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.OPENAI_BASE_URL = "https://example.invalid";
  process.env.CODEX_ORIGINAL_TEST_KEEP = "preserved";
  const { openOriginalCodex } = await import("../dist-electron/main/original-launcher.js");
  const appPath = path.join(testRoot, "Original Codex 测试.app");
  const executable = path.join(appPath, "Contents", "MacOS", "Codex");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, "fixture");
  const codexHome = path.join(testRoot, ".codex");
  await fs.mkdir(codexHome);
  await fs.writeFile(path.join(codexHome, "config.toml"), 'model = "existing-model"\n');
  await fs.writeFile(path.join(codexHome, "auth.json"), '{"fixture":"existing-auth"}\n');

  await openOriginalCodex(appPath);
  const mac = calls.at(-1);
  assert.equal(mac.command, "/usr/bin/open");
  assert.deepEqual(mac.args, ["-n", "-a", appPath], "macOS must start the default app instead of focusing an isolated profile");
  for (const key of ["CODEX_HOME", "USER_DATA_DIR", "CODEX_PROFILE_MANAGER_LAUNCH", "CODEX_PROFILE_TEST_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) {
    assert.equal(mac.options.env[key], undefined, `profile environment leaked: ${key}`);
  }
  assert.equal(mac.options.env.CODEX_ORIGINAL_TEST_KEEP, "preserved");
  assert.equal(process.env.CODEX_HOME, path.join(testRoot, "isolated"), "parent environment must remain unchanged");
  launchError = new Error("LaunchServices failed");
  await assert.rejects(openOriginalCodex(appPath), /LaunchServices failed/);
  launchError = null;

  process.env.CODEX_PROFILE_MANAGER_PLATFORM_OVERRIDE = "win32";
  const windowsExecutable = path.join(testRoot, "Desktop App", "Codex.exe");
  await fs.mkdir(path.dirname(windowsExecutable));
  await fs.writeFile(windowsExecutable, "fixture");
  await openOriginalCodex(windowsExecutable);
  assert.equal(calls.at(-1).command, windowsExecutable);
  assert.deepEqual(calls.at(-1).args, [], "Windows original launch must not use a profile user-data-dir");
  assert.equal(calls.at(-1).options.env.CODEX_HOME, undefined);
  launchError = Object.assign(new Error("Access denied"), { code: "EACCES" });
  await assert.rejects(openOriginalCodex(windowsExecutable), /Access denied/);
  launchError = null;

  const storeExecutable = path.join(testRoot, "Program Files", "WindowsApps", "OpenAI.Codex", "Codex.exe");
  await fs.mkdir(path.dirname(storeExecutable), { recursive: true });
  await fs.writeFile(storeExecutable, "fixture");
  appx = { PackageName: "OpenAI.Codex", PackageFullName: "OpenAI.Codex_1", PackageFamilyName: "OpenAI.Codex_test", ApplicationId: "App", InstallLocation: path.dirname(storeExecutable), ExecutablePath: storeExecutable };
  await openOriginalCodex(storeExecutable);
  assert.equal(calls.at(-1).command, "explorer.exe");
  assert.deepEqual(calls.at(-1).args, ["shell:AppsFolder\\OpenAI.Codex_test!App"], "Store original launch must use the registered app identity");
  appx = null;
  for (const key of ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PATH"]) delete process.env[key];
  const beforeMissing = calls.length;
  await assert.rejects(openOriginalCodex(path.join(testRoot, "missing.exe")), /未找到原始/);
  assert.equal(calls.length, beforeMissing, "missing app must not spawn anything");
  assert.equal(await fs.readFile(path.join(codexHome, "config.toml"), "utf8"), 'model = "existing-model"\n');
  assert.equal(await fs.readFile(path.join(codexHome, "auth.json"), "utf8"), '{"fixture":"existing-auth"}\n');
  await assert.rejects(fs.access(path.join(testRoot, "isolated")), { code: "ENOENT" });
  console.log("Original launcher verification passed (macOS, Windows desktop/Store, environment isolation, missing apps, launch errors, original config preservation).");
} finally {
  Object.assign(childProcess, nativeMethods);
  syncBuiltinESMExports();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await fs.rm(testRoot, { recursive: true, force: true });
}
