const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain } = require("electron");

app.disableHardwareAcceleration();
let win;

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
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-env-wizard-"));
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
      "profiles:backups": []
    };
    for (const [channel, result] of Object.entries(responses)) ipcMain.handle(channel, () => result);
    ipcMain.handle("profiles:default-env", () => envFiles.getDefaultProfileEnvFile());
    ipcMain.handle("profiles:list", () => service.listProfiles());
    ipcMain.handle("profiles:create", (_event, input) => service.createProfile({ ...input, codexAppPath }));
    await app.whenReady();
    win = new BrowserWindow({
      show: false, width: 1180, height: 760,
      webPreferences: { preload: path.resolve(__dirname, "../dist-electron/preload/index.cjs"), contextIsolation: true, nodeIntegration: false }
    });
    await win.loadFile(path.resolve(__dirname, "../dist/index.html"));
    await evaluate('localStorage.setItem("codex-profile-manager-language", "en")');
    await win.loadFile(path.resolve(__dirname, "../dist/index.html"));
    await waitFor('document.querySelector(".sidebar-add-button")');
    await evaluate('document.querySelector(".sidebar-add-button").click()');
    await nextStep("Provider");
    await evaluate('document.querySelectorAll(".auth-mode-option")[2].click()');
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
    assert.equal(await fs.readFile(path.join(profiles[0].paths.codexHome, ".env"), "utf8"), edited);
    assert.equal(await fs.readFile(defaultEnvPath, "utf8"), original);
    console.log("Profile .env wizard verification passed (preload, full preview, editing, navigation, generation, source isolation).");
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
}

run().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
