const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const electron = require("electron");

if (typeof electron !== "string") {
  const { app, BrowserWindow } = electron;
  let window;
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(() => {
    window = new BrowserWindow({ show: false, opacity: 0, skipTaskbar: true, x: -10000, y: -10000, title: "Profile Runtime Test", width: 400, height: 240 });
    window.webContents.on("destroyed", () => {});
    console.log(JSON.stringify({ ready: true, pid: process.pid }));
  });
  process.on("message", request => {
    if (request.action === "minimize") { window.showInactive(); window.minimize(); }
    if (request.action === "hide") window.hide();
    process.send({ id: request.id, minimized: window.isMinimized() });
  });
} else {
  async function run() {
    const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-runtime-"));
    const children = [];
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const { createRuntimePlatform } = await import(pathToFileURL(path.resolve(__dirname, "../dist-electron/main/runtime-platform.js")));
    const { ProfileRuntimeMonitor } = await import(pathToFileURL(path.resolve(__dirname, "../dist-electron/main/runtime-monitor.js")));
    const profiles = ["A", "B"].map(id => ({ id, status: "active", paths: { codexAppPath: electron, userDataDir: path.join(testRoot, id) } }));
    const adapter = createRuntimePlatform();
    const monitor = new ProfileRuntimeMonitor({ platform: adapter, readProfiles: async () => profiles });
    const waitExit = child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once("exit", resolve));
    let messageId = 0;
    function message(child, action) {
      const id = ++messageId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.off("message", receive); reject(new Error("Fixture command timed out")); }, 5000);
        function receive(response) {
          if (response.id !== id) return;
          clearTimeout(timer); child.off("message", receive); resolve(response);
        }
        child.on("message", receive);
        child.send({ id, action });
      });
    }
    async function fixture(profile) {
      const child = spawn(electron, [__filename, `--user-data-dir=${profile.paths.userDataDir}`], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      children.push(child);
      child.stderr.resume();
      await new Promise((resolve, reject) => {
        const reader = createInterface({ input: child.stdout });
        const timer = setTimeout(() => { reader.close(); reject(new Error("Fixture startup timed out")); }, 20000);
        reader.on("line", line => {
          try { if (JSON.parse(line).ready) { clearTimeout(timer); reader.close(); resolve(); } } catch {}
        });
        child.once("error", error => { clearTimeout(timer); reader.close(); reject(error); });
        child.once("exit", () => { clearTimeout(timer); reader.close(); reject(new Error("Fixture exited before ready")); });
      });
      return child;
    }
    try {
      const a = await fixture(profiles[0]);
      const b = await fixture(profiles[1]);
      const started = performance.now();
      const snapshot = await monitor.refresh(true);
      const discoveryMs = performance.now() - started;
      assert.equal(snapshot.profiles.find(row => row.profileId === "A").pid, a.pid);
      assert.equal(snapshot.profiles.find(row => row.profileId === "B").pid, b.pid);
      const rows = await adapter.scan(profiles);
      const identity = rows.find(row => row.pid === a.pid);
      assert.ok(identity);
      await assert.rejects(adapter.act({ ...identity, startTime: "stale-identity" }, "close"), /identity changed/);
      assert.equal(a.exitCode, null, "stale identities must not close a process");
      await message(a, "minimize");
      const opened = await monitor.open(profiles[0], async () => { throw new Error("An existing instance must never be relaunched"); });
      assert.equal(opened.pid, a.pid);
      assert.ok(["focused", "attention"].includes(opened.action));
      if (process.platform === "win32") {
        const deadline = Date.now() + 3000;
        while ((await message(a, "state")).minimized && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal((await message(a, "state")).minimized, false, "Open window must restore a minimized window");
      }
      await message(a, "hide");
      const samples = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        await monitor.refresh();
        samples.push(performance.now() - start);
      }
      await monitor.close(profiles[0]);
      await Promise.race([waitExit(a), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Normal close did not exit fixture A")), 10000); timer.unref(); })]);
      await monitor.refresh();
      assert.equal(monitor.getSnapshot().profiles.find(row => row.profileId === "A").status, "not_running");
      assert.equal(monitor.getSnapshot().profiles.find(row => row.profileId === "B").pid, b.pid, "closing A must preserve B");
      await monitor.close(profiles[1], true);
      await waitExit(b);
      await monitor.refresh();
      assert.equal(monitor.getSnapshot().profiles.find(row => row.profileId === "B").status, "not_running");
      console.log(JSON.stringify({ platform: process.platform, discoveryMs: Math.round(discoveryMs), averageTargetedCheckMs: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length), passed: "native discovery, focus existing window, stale identity rejection, normal close, force stop, A/B isolation" }));
    } finally {
      monitor.dispose();
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.all(children.map(waitExit));
      const resolved = path.resolve(testRoot);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("codex-native-runtime-")) throw new Error("Unexpected cleanup path");
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  run().catch(error => { console.error(error); process.exitCode = 1; });
}
