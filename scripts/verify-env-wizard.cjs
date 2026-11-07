const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const electron = require("electron");
const { parse } = require("smol-toml");

if (typeof electron === "string") {
  // Chromium releases its user-data files only after Electron exits.
  // Keep cleanup in the Node parent so Windows file locks cannot hide failures.
  (async () => {
    const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-env-wizard-"));
    const childEnv = { ...process.env, CODEX_ENV_WIZARD_TEST_ROOT: testRoot };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    try {
      const result = require("node:child_process").spawnSync(electron, [__filename, ...process.argv.slice(2)], {
        env: childEnv, stdio: "inherit", windowsHide: true, timeout: 60000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    } finally {
      const resolved = path.resolve(testRoot);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("codex-env-wizard-")) {
        throw new Error("Unexpected test cleanup path");
      }
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  })().catch((error) => { console.error(error); process.exitCode = 1; });
} else {
const { app, BrowserWindow, ipcMain } = electron;

app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
let win;
let runtime;

async function evaluate(expression) {
  return win.webContents.executeJavaScript(expression);
}

async function waitFor(expression) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`UI condition timed out: ${expression}`);
}

async function nextStep(step) {
  await evaluate('document.querySelector(".wizard-actions .primary").click()');
  await waitFor(`document.querySelector(".wizard-nav li.current")?.textContent.includes(${JSON.stringify(step)})`);
}

async function run() {
  const officialApi = process.argv.includes("--official-api");
  const runtimeMode = process.argv.includes("--runtime");
  let runtimeRows = [], launches = 0, environmentReads = 0, cliRegistrations = 0;
  const nativeActions = [];
  const testRoot = process.env.CODEX_ENV_WIZARD_TEST_ROOT;
  if (!testRoot) throw new Error("Run this verification script with Node.");
  process.env.CODEX_PROFILE_MANAGER_HOME_OVERRIDE = testRoot;
  process.env.CODEX_PROFILE_MANAGER_PLATFORM_OVERRIDE = "win32";
  process.env.APPDATA = path.join(testRoot, "AppData");
  const defaultEnvPath = path.join(testRoot, ".codex", ".env");
  const original = "# Copied in full\r\nAPI_URL=https://example.invalid\r\nCUSTOM_VALUE=original\r\n\r\n";
  const edited = "# Edited for this profile\nAPI_URL=https://example.invalid\nCUSTOM_VALUE=edited\n\n";
  const codexAppPath = path.join(testRoot, "Codex.exe");
  try {
    await fs.mkdir(path.dirname(defaultEnvPath));
    await fs.writeFile(defaultEnvPath, original);
    await fs.writeFile(codexAppPath, "test executable\n");
    app.setPath("userData", testRoot);
    const service = await import(pathToFileURL(path.resolve(__dirname, "../dist-electron/main/profile-service.js")));
    const envFiles = await import(pathToFileURL(path.resolve(__dirname, "../dist-electron/main/profile-env.js")));
    const responses = {
      "app:get-info": {},
      "app:get-announcement": { item: null },
      "app:set-language": { ok: true },
      "app:check-for-updates": { status: "up_to_date" },
      "environment:get": { codexAppPath, checks: [] },
      "profiles:runtime": [],
      "profiles:runtime-snapshot": { revision: 0, profiles: [] },
      "profiles:backups": []
    };
    if (runtimeMode) {
      const { ProfileRuntimeMonitor } = await import(pathToFileURL(path.resolve(__dirname, "../dist-electron/main/runtime-monitor.js")));
      runtime = new ProfileRuntimeMonitor({ readProfiles: () => service.listProfiles(), platform: {
        platform: "win32",
        async scan() { return [...runtimeRows]; },
        async inspect(known) { return runtimeRows.filter(row => known.some(previous => previous.pid === row.pid)); },
        async act(row, action) {
          nativeActions.push([row.pid, action]);
          if (action !== "focus") runtimeRows = runtimeRows.filter(current => current.pid !== row.pid);
          return { performed: true, hasWindow: true };
        },
        dispose() {}
      } });
      runtime.subscribe(snapshot => { if (win && !win.isDestroyed()) win.webContents.send("profiles:runtime-changed", snapshot); });
      delete responses["profiles:runtime-snapshot"];
      ipcMain.handle("profiles:runtime-snapshot", () => runtime.refresh(true));
      ipcMain.handle("profiles:open", async (_event, id) => {
        const profile = (await service.listProfiles()).find(profile => profile.id === id);
        const result = await runtime.open(profile, async () => {
          launches++;
          runtimeRows.push({ pid: 7001, command: `"${codexAppPath}" --user-data-dir="${profile.paths.userDataDir}"`, executable: codexAppPath, startTime: "test-process", hasWindow: true });
          return { pid: 7001 };
        });
        await runtime.refresh(true);
        return result;
      });
      ipcMain.handle("profiles:close", async (_event, id, force) => {
        const profile = (await service.listProfiles()).find(profile => profile.id === id);
        const result = await runtime.close(profile, force);
        await runtime.refresh(true);
        return result;
      });
    }
    for (const [channel, result] of Object.entries(responses)) ipcMain.handle(channel, () => {
      if (channel === "environment:get") environmentReads++;
      return result;
    });
    ipcMain.handle("profiles:default-env", () => envFiles.getDefaultProfileEnvFile());
    ipcMain.handle("profiles:list", () => service.listProfiles());
    ipcMain.handle("profiles:cli-info", (_event, id, refreshPath) => { if (refreshPath) cliRegistrations++; return service.getProfileCliInfo(id, refreshPath); });
    ipcMain.handle("profiles:create", async (_event, input) => {
      const result = await service.createProfile({ ...input, codexAppPath });
      if (runtime) await runtime.refresh(true);
      return result;
    });
    await app.whenReady();
    win = new BrowserWindow({
      show: false, width: 1180, height: 760,
      webPreferences: { preload: path.resolve(__dirname, "../dist-electron/preload/index.cjs"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    });
    await win.loadFile(path.resolve(__dirname, "../dist/index.html"));
    await evaluate('localStorage.setItem("codex-profile-manager-language", "en")');
    await win.loadFile(path.resolve(__dirname, "../dist/index.html"));
    await waitFor('document.querySelector(".sidebar-add-button")');
    await evaluate('document.querySelector(".sidebar-add-button").click()');
    await nextStep("Provider");
    if (officialApi) {
      await evaluate(`(() => {
        const provider = document.querySelector(".form select");
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(provider, "official_openai");
        provider.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
      await waitFor('document.querySelector(".form .field-note")?.textContent.includes("Choose an official model")');
      assert.equal(await evaluate('document.querySelector(".form .input-action-row")'), null, "official API must not ask for a model");
      await evaluate(`(() => {
        const apiKey = document.querySelector('.form input[type="password"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(apiKey, "sk-test-official-wizard");
        apiKey.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
    } else {
      await evaluate('document.querySelectorAll(".auth-mode-option")[2].click()');
    }
    await nextStep(".env file");
    await waitFor('document.querySelector(".env-file-editor") && !document.querySelector(".env-file-editor").disabled');
    assert.equal(await evaluate('document.querySelector(".env-file-editor").value'), original.replace(/\r\n/g, "\n"));
    await evaluate(`(() => {
      const editor = document.querySelector(".env-file-editor");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(editor, ${JSON.stringify(edited)});
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await nextStep("Test");
    await evaluate('document.querySelector(".wizard-actions .secondary").click()');
    await waitFor('document.querySelector(".env-file-editor")');
    assert.equal(await evaluate('document.querySelector(".env-file-editor").value'), edited, "edits must survive navigation");
    const screenshotPath = process.argv.find((arg) => arg.startsWith("--screenshot="))?.slice("--screenshot=".length);
    if (screenshotPath) {
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await fs.mkdir(path.dirname(path.resolve(screenshotPath)), { recursive: true });
      await fs.writeFile(path.resolve(screenshotPath), (await win.webContents.capturePage()).toPNG());
    }
    await nextStep("Test");
    await nextStep("Launcher");
    await nextStep("Generate");
    await evaluate('document.querySelector(".wizard-actions .primary").click()');
    await waitFor('!document.querySelector(".env-file-editor") && !document.querySelector(".wizard-nav")');
    const profiles = await service.listProfiles();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].provider.model, undefined, "official profiles must not store a model preset");
    const config = parse(await fs.readFile(path.join(profiles[0].paths.codexHome, "config.toml"), "utf8"));
    assert.equal(config.model, undefined);
    assert.equal(config.model_reasoning_effort, undefined);
    if (officialApi) {
      await waitFor('Array.from(document.querySelectorAll(".edit-box .field-note")).some(note => note.textContent.includes("Choose an official model"))');
      assert.equal(await evaluate('document.querySelector(".edit-box .input-action-row")'), null);
      assert.equal(await evaluate('document.querySelector(".edit-box .button-row button:last-child").disabled'), false, "official API save must not require a model");
    }
    assert.equal(await fs.readFile(path.join(profiles[0].paths.codexHome, ".env"), "utf8"), edited);
    assert.equal(await fs.readFile(defaultEnvPath, "utf8"), original);
    await waitFor('document.querySelector(".profile-cli-box .path-row")');
    assert.equal(await evaluate('document.querySelector(".profile-cli-command code").textContent'), `codex-${profiles[0].id}`);
    await evaluate('window.__copiedCliValues = []; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { window.__copiedCliValues.push(value); } } })');
    await evaluate('document.querySelectorAll(".profile-cli-command button")[0].click(); document.querySelectorAll(".profile-cli-command button")[1].click()');
    await waitFor('window.__copiedCliValues.length === 2');
    assert.deepEqual(await evaluate('window.__copiedCliValues'), [`codex-${profiles[0].id}`, profiles[0].paths.cliLauncherPath]);
    await evaluate('document.querySelector(".profile-cli-box > button").click()');
    await waitFor('!document.querySelector(".profile-cli-box > button").disabled');
    assert.equal(cliRegistrations, 1, "PATH action must request backend re-registration");
    const cliScreenshot = process.argv.find(arg => arg.startsWith("--cli-screenshot="))?.slice("--cli-screenshot=".length);
    if (cliScreenshot) {
      await evaluate('document.querySelector(".profile-cli-box").scrollIntoView({block:"center"}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await fs.mkdir(path.dirname(path.resolve(cliScreenshot)), { recursive: true });
      await fs.writeFile(path.resolve(cliScreenshot), (await win.webContents.capturePage()).toPNG());
    }
    console.log("Profile CLI UI verification passed (command, copy command/path, PATH re-registration).");
    if (runtimeMode) {
      await waitFor('document.querySelector(".detail-actions .primary")?.textContent.trim() === "Start"');
      const before = environmentReads;
      await evaluate('document.querySelector(".detail-actions .primary").click()');
      await waitFor('document.querySelector(".profile-row .runtime-badge.running") && document.querySelector(".detail-actions .primary")?.textContent.includes("Open window") && !document.querySelector(".detail-actions .primary").disabled');
      assert.equal(launches, 1);
      if (screenshotPath) {
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        await fs.writeFile(path.resolve(screenshotPath), (await win.webContents.capturePage()).toPNG());
      }
      await evaluate('document.querySelector(".detail-actions .primary").click()');
      await waitFor('!document.querySelector(".detail-actions .primary").disabled');
      assert.equal(launches, 1, "Open window must reuse the running instance");
      assert.deepEqual(nativeActions.at(-1), [7001, "focus"]);
      await evaluate('document.querySelector(".detail-actions .secondary").click()');
      await waitFor('document.querySelector(".profile-row .runtime-badge.not_running") && document.querySelector(".detail-actions .primary")?.textContent.trim() === "Start"');
      assert.deepEqual(nativeActions.at(-1), [7001, "close"]);
      runtimeRows = [{ pid: 7002, command: `"${codexAppPath}" --user-data-dir="${profiles[0].paths.userDataDir}"`, executable: codexAppPath, startTime: "external-process", hasWindow: true }];
      await runtime.refresh(true);
      await waitFor('document.querySelector(".profile-row .runtime-badge.running")');
      runtimeRows = [];
      await runtime.refresh();
      await waitFor('document.querySelector(".profile-row .runtime-badge.not_running")');
      const stale = { ...runtime.getSnapshot(), revision: 0, profiles: runtime.getSnapshot().profiles.map(row => ({ ...row, status: "running" })) };
      win.webContents.send("profiles:runtime-changed", stale);
      await evaluate('new Promise(resolve => setTimeout(resolve, 30))');
      assert.equal(await evaluate('Boolean(document.querySelector(".profile-row .runtime-badge.running"))'), false, "stale events must not overwrite a newer state");
      assert.equal(environmentReads, before, "runtime events must not rerun environment diagnostics");
      console.log("Runtime UI verification passed (IPC events, state badges, start/focus/close buttons, external exit, stale snapshots).");
    }
    console.log(`Profile .env wizard verification passed (${officialApi ? "official API" : "account"}, no model preset, editing, navigation, generation, source isolation).`);
  } finally {
    runtime?.dispose();
    if (win && !win.isDestroyed()) win.destroy();
  }
}

run().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
}
