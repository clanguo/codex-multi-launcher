import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
if (!process.env.CODEX_CLI_VERIFICATION_ROOT) {
  const temporaryBase = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryBase, "codex-cli-test space & % !'-"));
  try {
    const runtime = process.argv.find(arg => arg.startsWith("--runtime="))?.slice("--runtime=".length) ?? require("electron");
    const result = spawnSync(runtime, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CODEX_CLI_VERIFICATION_ROOT: root },
      stdio: "inherit", windowsHide: true, timeout: 120000
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== temporaryBase || !path.basename(resolved).startsWith("codex-cli-test ")) throw new Error("Unexpected CLI test cleanup path");
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
} else {
  const root = process.env.CODEX_CLI_VERIFICATION_ROOT;
  process.env.CODEX_PROFILE_MANAGER_HOME_OVERRIDE = root;
  process.env.CODEX_PROFILE_MANAGER_PLATFORM_OVERRIDE = process.platform;
  process.env.APPDATA = path.join(root, "AppData");
  const { createProfileRecord, findProfile, softDeleteProfile, restoreProfileRecord, saveRegistry, loadRegistry } = await import("../dist-electron/main/registry.js");
  const { generateCliLauncher } = await import("../dist-electron/main/cli-launcher.js");
  const { getAppPaths, profileCliPath } = await import("../dist-electron/main/paths.js");
  const { upsertApiKey } = await import("../dist-electron/main/secrets.js");
  const { writeCodexAuth, writeCodexConfig } = await import("../dist-electron/main/codex-config.js");
  const { createProfile, permanentlyDeleteProfile, getProfileCliInfo } = await import("../dist-electron/main/profile-service.js");
  const { prependCliPath, updateShellPath, registerProfileCliPath, WINDOWS_CLI_PATH_SCRIPT } = await import("../dist-electron/main/cli-path.js");
  const { resolveCliTarget, buildCliEnvironment } = await import("../dist-electron/main/cli-runner.js");
  const fake = path.join(root, "fake-codex.mjs");
  const desktop = path.join(root, "Codex.exe");
  await fs.writeFile(desktop, "test desktop placeholder\n");
  await fs.writeFile(fake, `import fs from 'node:fs';
import {spawn} from 'node:child_process';
const args=process.argv.slice(2);
if(args.includes('--child')){setInterval(()=>{},1000);}
else if(args.includes('--hold')){
 const child=spawn(process.execPath,[process.argv[1],'--child'],{stdio:'ignore',env:process.env});
 process.stdout.write(JSON.stringify({pid:process.pid,child:child.pid})+'\\n');
 setInterval(()=>{},1000);
} else if(args.includes('--fail')){process.stderr.write('fake stderr\\n');process.exitCode=7;}
else{
 const input=fs.readFileSync(0,'utf8');
 process.stdout.write(JSON.stringify({args,cwd:process.cwd(),input,home:process.env.CODEX_HOME,label:process.env.RUN_LABEL,api:process.env.OPENAI_API_KEY,a:process.env.CODEX_PROFILE_API1_API_KEY,b:process.env.CODEX_PROFILE_API2_API_KEY,quoted:process.env.QUOTED,multiline:process.env.MULTILINE,danger:process.env.DANGER,nodeOptions:process.env.NODE_OPTIONS,base:process.env.OPENAI_BASE_URL})+'\\n');
}
`, { mode: 0o700 });

  async function fixture(name, account = false, official = account) {
    const profile = await createProfileRecord({ name, authMode: account ? "chatgpt_account" : "api_key", codexAppPath: desktop, provider: {
      type: official ? "official_openai" : "third_party_responses", displayName: name, model: official ? undefined : "test-model", baseUrl: official ? undefined : "https://example.invalid/v1"
    } });
    if (!account) {
      await upsertApiKey({ profileId: profile.id, providerId: profile.provider.id, envKeyName: profile.provider.envKeyName, secretType: "api_key", value: `test-secret-${name}` });
      await writeCodexAuth(profile, `test-secret-${name}`);
    } else await fs.writeFile(path.join(profile.paths.codexHome, "auth.json"), '{"tokens":{"access_token":"account-token"}}\n');
    await writeCodexConfig(profile);
    await fs.writeFile(path.join(profile.paths.codexHome, ".env"), `RUN_LABEL=${name}\nCODEX_PROFILE_CLI_PATH="${fake.replace(/\\/g, "/")}"\nCODEX_HOME=must-not-win\nOPENAI_API_KEY=local-must-not-win\nNODE_OPTIONS=--no-warnings\nQUOTED=" two words "\nMULTILINE="first\nsecond"\nDANGER=$(touch never-execute)\n`);
    const command = await generateCliLauncher(profile);
    assert.equal(command.command, `codex-${name}`);
    assert.equal(command.executablePath, profile.paths.cliLauncherPath);
    return { profile, command };
  }
  const a = await fixture("api1"), b = await fixture("api2"), account = await fixture("account", true), official = await fixture("official", false, true);
  const workspace = path.join(root, "work space & 2");
  await fs.mkdir(workspace);
  const childEnv = { ...process.env, PATH: prependCliPath(process.platform === "win32" ? process.env.PATH ?? process.env.Path ?? "" : "/usr/bin:/bin", getAppPaths().defaultCliRoot), CODEX_HOME: "wrong-parent-home", OPENAI_BASE_URL: "https://wrong-parent.invalid", OPENAI_API_KEY: "wrong-parent-api", CODEX_API_KEY: "wrong-exec-key", CODEX_PROFILE_API1_API_KEY: "wrong-parent-a", CODEX_PROFILE_API2_API_KEY: "wrong-parent-b" };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  // Windows keeps PATH case-insensitively; eliminate duplicate Path/PATH keys.
  if (process.platform === "win32") for (const key of Object.keys(childEnv)) if (key !== "PATH" && key.toLowerCase() === "path") delete childEnv[key];
  function launch(command, args = [], input = "") {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: workspace, env: childEnv, shell: false, windowsHide: true });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout += data; });
      child.stderr.on("data", data => { stderr += data; });
      child.once("error", reject);
      child.once("close", code => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  }
  const args = ["app-server", "--stdio", "", "two words", 'json:{"q":"quoted \\" text"}', "a&b|c%PATH%!value", "trailing\\", "中文 🧪"];
  const input = '{"jsonrpc":"2.0","method":"initialize","id":1}\nstdin 中文\n';
  const first = await launch(a.command.command, args, input);
  assert.equal(first.code, 0, first.stderr);
  const probe = JSON.parse(first.stdout);
  assert.deepEqual(probe.args, args, "all arguments must pass without shell interpretation");
  assert.equal(probe.input, input);
  assert.equal(probe.cwd, workspace);
  assert.equal(probe.home, a.profile.paths.codexHome);
  assert.equal(probe.label, "api1");
  assert.equal(probe.a, "test-secret-api1");
  assert.equal(probe.b, undefined);
  assert.equal(probe.api, undefined);
  assert.equal(probe.quoted, " two words ");
  assert.equal(probe.multiline, "first\nsecond");
  assert.equal(probe.danger, "$(touch never-execute)");
  assert.equal(probe.nodeOptions, "--no-warnings", "explicit profile Node options must remain available to tools");
  assert.equal(probe.base, undefined, "inherited endpoint overrides must not reroute a profile");
  const second = await launch(b.command.command);
  assert.equal(second.code, 0, second.stderr);
  const other = JSON.parse(second.stdout);
  assert.equal(other.label, "api2");
  assert.equal(other.a, undefined);
  assert.equal(other.b, "test-secret-api2");
  const officialResult = await launch(official.command.command);
  assert.equal(officialResult.code, 0, officialResult.stderr);
  const officialProbe = JSON.parse(officialResult.stdout);
  assert.equal(officialProbe.api, "test-secret-official");
  assert.equal(officialProbe.a, undefined);
  assert.equal(officialProbe.b, undefined);
  const authBefore = await fs.readFile(path.join(account.profile.paths.codexHome, "auth.json"), "utf8");
  const accountResult = await launch(account.command.command);
  assert.equal(accountResult.code, 0, accountResult.stderr);
  assert.equal(JSON.parse(accountResult.stdout).api, undefined);
  assert.equal(await fs.readFile(path.join(account.profile.paths.codexHome, "auth.json"), "utf8"), authBefore);
  const accountEnvFile = path.join(account.profile.paths.codexHome, ".env");
  await fs.rename(accountEnvFile, `${accountEnvFile}.saved`);
  const accountManifest = JSON.parse(await fs.readFile(`${account.command.executablePath}.json`, "utf8"));
  const missingEnv = await buildCliEnvironment({ ...accountManifest, fallbackPath: "/fallback/bin" }, { PATH: "/parent/bin", NODE_OPTIONS: "--inspect", OPENAI_API_KEY: "parent-key" });
  assert.equal(missingEnv.env.PATH, ["/parent/bin", "/fallback/bin"].join(path.delimiter));
  assert.equal(missingEnv.env.NODE_OPTIONS, undefined);
  await fs.rename(`${accountEnvFile}.saved`, accountEnvFile);
  await upsertApiKey({ profileId: a.profile.id, providerId: a.profile.provider.id, envKeyName: a.profile.provider.envKeyName, secretType: "api_key", value: "rotated-secret" });
  assert.equal(JSON.parse((await launch(a.command.command)).stdout).a, "rotated-secret", "commands must read current credentials without regeneration");
  const failed = await launch(a.command.command, ["--fail"]);
  assert.equal(failed.code, 7, "CLI exit codes must reach the platform");
  assert.ok(failed.stderr.includes("fake stderr"));
  for (const file of [a.command.executablePath, `${a.command.executablePath}.json`]) {
    const bytes = await fs.readFile(file);
    assert.equal(bytes.includes(Buffer.from("test-secret-api1")), false);
    assert.equal(bytes.includes(Buffer.from("rotated-secret")), false);
  }

  const registry = await loadRegistry();
  delete registry.profiles.find(p => p.id === "api1").paths.cliLauncherPath;
  await saveRegistry(registry);
  assert.equal((await getProfileCliInfo("api1")).command, "codex-api1", "older profiles must migrate automatically");
  await softDeleteProfile("api1");
  assert.notEqual((await launch(a.command.command)).code, 0, "removed profiles must not run");
  await restoreProfileRecord("api1");
  assert.equal((await launch(a.command.command)).code, 0);

  const unmanaged = profileCliPath("collision");
  await fs.writeFile(unmanaged, "keep unmanaged command\n");
  await assert.rejects(createProfile({ name: "collision", authMode: "chatgpt_account", codexAppPath: desktop, provider: { type: "official_openai", displayName: "OpenAI" } }), /already exists/);
  assert.equal(await fs.readFile(unmanaged, "utf8"), "keep unmanaged command\n");
  assert.equal(await findProfile("collision"), null, "failed CLI generation must roll back profile creation");

  assert.equal(prependCliPath("C:\\Other;c:\\BIN", "C:\\bin", "win32"), "C:\\bin;C:\\Other");
  const shell = updateShellPath("export ORIGINAL=keep\n", "/path with 'quote/bin");
  assert.equal(updateShellPath(shell, "/path with 'quote/bin"), shell);
  assert.ok(shell.startsWith("export ORIGINAL=keep\n"));
  if (process.platform === "win32") {
    // Exercise the real registration algorithm against an in-memory registry.
    // Never write the developer/CI user's PATH while testing.
    const registryExpression = "[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')";
    assert.ok(WINDOWS_CLI_PATH_SCRIPT.includes(registryExpression));
    const algorithm = WINDOWS_CLI_PATH_SCRIPT.split("\nAdd-Type")[0].replace(registryExpression, "$mock");
    const script = `$mock = [pscustomobject]@{ Raw = '%SystemRoot%\\System32;c:\\BIN;C:\\Other'; Result = '' }
$mock | Add-Member ScriptMethod GetValue { param($name,$default,$options) return $this.Raw }
$mock | Add-Member ScriptMethod SetValue { param($name,$value,$kind) $this.Result = $value }
$mock | Add-Member ScriptMethod Dispose { }
${algorithm}
$mock.Result | ConvertTo-Json -Compress`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: { ...process.env, CODEX_PROFILE_BIN_ENTRY: "C:\\bin" }, encoding: "utf8", windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()), "C:\\bin;%SystemRoot%\\System32;C:\\Other", "PATH registration must preserve expandable values and deduplicate case-insensitively");
  }
  if (process.platform === "darwin") {
    await fs.writeFile(path.join(root, ".profile"), "export ORIGINAL=keep\n");
    await registerProfileCliPath({ persist: true, applySystem: false, force: true });
    await assert.rejects(fs.access(path.join(root, ".bash_profile")), { code: "ENOENT" });
    assert.ok((await fs.readFile(path.join(root, ".profile"), "utf8")).includes("export ORIGINAL=keep"));
    const shellFile = path.join(root, "path-check.sh");
    await fs.writeFile(shellFile, `${shell}\n${shell}\nprintf '%s' "$PATH"\n`);
    const sourced = spawnSync("/bin/sh", [shellFile], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000 });
    assert.equal(sourced.status, 0, sourced.stderr);
    assert.equal(sourced.stdout, "/path with 'quote/bin:/usr/bin:/bin", "shell login + interactive loading must not duplicate PATH entries");
  }

  // A global npm .cmd must be unwrapped without cmd.exe; JS may be non-executable.
  const npmRoot = path.join(root, "npm installation");
  const npmScript = path.join(npmRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
  await fs.mkdir(path.dirname(npmScript), { recursive: true });
  await fs.writeFile(npmScript, "// stub npm entry\n", { mode: 0o600 });
  const npmCmd = path.join(npmRoot, "codex.cmd");
  await fs.writeFile(npmCmd, "@echo stub\n", { mode: 0o700 });
  const npmTarget = await resolveCliTarget({ CODEX_PROFILE_CLI_PATH: npmCmd }, { home: root, fallbackPath: "", cliExecutablePath: null });
  assert.equal(npmTarget.file, process.execPath);
  assert.deepEqual(npmTarget.args, [await fs.realpath(npmScript)]);
  await assert.rejects(resolveCliTarget({ CODEX_PROFILE_CLI_PATH: b.command.executablePath }, { home: root, fallbackPath: "", cliExecutablePath: null }), /another profile CLI/);

  const realCli = process.argv.find(arg => arg.startsWith("--real-cli="))?.slice("--real-cli=".length);
  if (realCli) {
    await fs.writeFile(path.join(official.profile.paths.codexHome, ".env"), `CODEX_PROFILE_CLI_PATH="${realCli.replace(/\\/g, "/")}"\n`);
    const version = await launch(official.command.command, ["--version"]);
    assert.equal(version.code, 0, version.stderr);
    assert.match(version.stdout, /codex/i);
    console.log(`Installed Codex CLI smoke passed: ${version.stdout.trim()}`);
  }

  // Cancellation must not leave a CLI/tool tree behind. POSIX platforms signal
  // the process group, as hosting platforms do; Windows uses the native job.
  const holding = spawn(a.command.command, ["--hold"], { cwd: workspace, env: childEnv, detached: process.platform !== "win32", windowsHide: true });
  holding.stderr.resume();
  const pids = await new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => reject(new Error("CLI hold fixture timed out")), 15000);
    holding.once("error", reject);
    holding.stdout.on("data", chunk => { data += chunk; if (data.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(data.split("\n")[0])); } });
  });
  const ended = new Promise(resolve => holding.once("close", resolve));
  if (process.platform === "win32") holding.kill(); else process.kill(-holding.pid, "SIGTERM");
  await ended;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 5000;
  while ((alive(pids.pid) || alive(pids.child)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(alive(pids.pid), false, "cancel must end the CLI");
  assert.equal(alive(pids.child), false, "cancel must end tool descendants");

  await permanentlyDeleteProfile("api1");
  await assert.rejects(fs.access(a.command.executablePath), { code: "ENOENT" });
  await assert.rejects(fs.access(`${a.command.executablePath}.json`), { code: "ENOENT" });
  assert.equal((await launch(b.command.command)).code, 0, "removing A must preserve B's command");
  console.log(`Profile CLI verification passed on ${process.platform} using bundled Electron Node (named commands, isolation, arguments, stdio, cwd, exit codes, cancellation, migration, deletion, PATH files).`);
}
