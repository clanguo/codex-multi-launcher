import assert from "node:assert/strict";
import vm from "node:vm";
import { ProfileRuntimeMonitor, matchesProfileProcess } from "../dist-electron/main/runtime-monitor.js";
import { MAC_RUNTIME_ACTION_SCRIPT, parseMacProcesses } from "../dist-electron/main/runtime-platform.js";

function profile(id, platform = "win32") {
  return { id, name: id, status: "active", paths: {
    userDataDir: platform === "win32" ? `C:\\Profiles\\${id}\\user-data` : `/Users/test/Library/Application Support/${id}/user-data`,
    codexAppPath: platform === "win32" ? "C:\\Apps\\Codex.exe" : "/Applications/ChatGPT.app",
  } };
}
function processFor(profile, pid, overrides = {}) {
  const executable = profile.paths.codexAppPath.endsWith(".app") ? `${profile.paths.codexAppPath}/Contents/MacOS/ChatGPT` : profile.paths.codexAppPath;
  return { pid, executable, command: `"${executable}" --user-data-dir="${profile.paths.userDataDir}"`, startTime: `identity-${pid}`, hasWindow: true, ...overrides };
}
const a = profile("A"), b = profile("B");
const pa = processFor(a, 101), pb = processFor(b, 102);
assert.equal(matchesProfileProcess(pa, a, "win32"), true);
assert.equal(matchesProfileProcess({ ...pa, command: pa.command.toLowerCase() }, a, "win32"), true);
assert.equal(matchesProfileProcess(pa, b, "win32"), false);
for (const suffix of ["-copy", " Extra"]) {
  assert.equal(matchesProfileProcess({ ...pa, command: pa.command.replace('user-data"', `user-data${suffix}"`) }, a, "win32"), false);
}
assert.equal(matchesProfileProcess({ ...pa, command: `${pa.command} --type=renderer` }, a, "win32"), false);
assert.equal(matchesProfileProcess({ ...pa, executable: "C:/Apps/resources/Codex.exe" }, a, "win32"), false);
const mac = profile("Mac", "darwin");
const macRow = parseMacProcesses(`  501 Fri Nov  6 10:00:00 2026 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --user-data-dir=${mac.paths.userDataDir}\n`)[0];
assert.equal(matchesProfileProcess(macRow, mac, "darwin"), true);
assert.equal(matchesProfileProcess({ ...macRow, command: `${macRow.command} Extra` }, mac, "darwin"), false);
assert.equal(matchesProfileProcess({ ...macRow, command: macRow.command.replace("/Users/test", "/users/test") }, mac, "darwin"), false);

let now = 0, processes = [], fail = false, launches = 0, closeRemoves = true;
let scans = 0, inspections = 0, disposed = 0;
const actions = [], events = [];
let profiles = [a, b];
const platform = {
  platform: "win32",
  async scan() { scans++; if (fail) throw new Error("inspection failed"); return [...processes]; },
  async inspect(known) { inspections++; if (fail) throw new Error("inspection failed"); return processes.filter(row => known.some(previous => previous.pid === row.pid)); },
  async act(row, action) {
    const current = processes.find(candidate => candidate.pid === row.pid);
    if (!current || current.startTime !== row.startTime || current.command !== row.command) throw new Error("process identity changed");
    actions.push([row.pid, action]);
    if (action === "force" || (action === "close" && closeRemoves)) processes = processes.filter(candidate => candidate.pid !== row.pid);
    return { performed: true, hasWindow: row.hasWindow };
  },
  dispose() { disposed++; }
};
const monitor = new ProfileRuntimeMonitor({ platform, readProfiles: async () => profiles, now: () => now });
monitor.subscribe(snapshot => events.push(snapshot));
const state = id => monitor.getSnapshot().profiles.find(row => row.profileId === id);
try {
  await monitor.refresh(true);
  assert.equal(state(a.id).status, "not_running");
  const revision = monitor.getSnapshot().revision;
  await monitor.refresh();
  assert.equal(monitor.getSnapshot().revision, revision, "unchanged polls must not notify/render again");
  assert.equal(scans, 1);
  assert.equal(inspections, 1);
  assert.equal(monitor.getPollInterval(), 3000);
  monitor.setForeground(false);
  assert.equal(monitor.getPollInterval(), 15000);

  let finishLaunch;
  const launch = () => { launches++; return new Promise(resolve => { finishLaunch = resolve; }); };
  const first = monitor.open(a, launch);
  const second = monitor.open(a, launch);
  assert.equal(first, second, "concurrent opens must share a single launch");
  while (!finishLaunch) await new Promise(resolve => setImmediate(resolve));
  assert.equal(state(a.id).status, "starting");
  assert.equal(monitor.getPollInterval(), 1000);
  finishLaunch({ pid: pa.pid });
  assert.equal((await first).action, "started");
  assert.equal((await monitor.open(a, launch)).action, "starting");
  assert.equal(launches, 1, "a delayed window must not cause a second launch");

  processes = [pa, pb];
  await monitor.refresh(true);
  assert.equal(state(a.id).status, "running");
  assert.equal((await monitor.open(a, launch)).action, "focused");
  assert.equal(launches, 1);
  assert.deepEqual(actions.at(-1), [101, "focus"]);
  await monitor.close(a);
  assert.equal(state(a.id).status, "closing");
  await monitor.refresh();
  assert.equal(state(a.id).status, "not_running");
  assert.equal(state(b.id).status, "running", "closing A must leave B running");

  closeRemoves = false;
  await monitor.close(b);
  now += 9000;
  await monitor.refresh();
  assert.equal(state(b.id).status, "running");
  assert.equal(state(b.id).canForceClose, true, "unconfirmed exits must offer explicit force stop");
  await monitor.close(b, true);
  await monitor.refresh();
  assert.equal(state(b.id).status, "not_running");

  processes = [{ ...pa, hasWindow: false }];
  await monitor.refresh(true);
  assert.equal(state(a.id).status, "background");
  await assert.rejects(monitor.open(a, launch), /background/);
  assert.equal(launches, 1, "background processes must not be duplicated");
  processes = [{ ...pb, pid: pa.pid, startTime: "reused-pid" }];
  await monitor.refresh();
  assert.equal(state(a.id).status, "not_running", "a recycled PID must not identify the former profile");
  assert.equal(state(b.id).status, "running");

  fail = true;
  await monitor.refresh(true);
  assert.equal(state(b.id).status, "unknown");
  assert.equal(state(b.id).pid, null);
  await assert.rejects(monitor.open(a, launch), /verify/);
  await assert.rejects(monitor.close(b), /verify/);
  assert.equal(launches, 1, "failed inspections must never trigger another instance");
  fail = false;
  const beforeRecoveryScans = scans;
  await monitor.refresh();
  assert.equal(state(b.id).status, "running", "failed inspections must recover through discovery");
  assert.equal(scans, beforeRecoveryScans + 1);
  processes = [];
  await monitor.refresh(true);
  await assert.rejects(monitor.open(a, async () => { throw new Error("spawn failed"); }), /spawn failed/);
  assert.equal(state(a.id).status, "error");
  profiles = [];
  await monitor.refresh(true);
  assert.equal(disposed, 1);
  assert.deepEqual(monitor.getSnapshot().profiles, []);
  assert.ok(events.length > 5);
} finally { monitor.dispose(); }

let releaseScan, activeQueries = 0, maxQueries = 0, scanCount = 0;
const serial = new ProfileRuntimeMonitor({ readProfiles: async () => [a], platform: {
  ...platform,
  async scan() {
    scanCount++;
    activeQueries++;
    maxQueries = Math.max(maxQueries, activeQueries);
    if (scanCount === 1) await new Promise(resolve => { releaseScan = resolve; });
    activeQueries--;
    return [];
  }
} });
const firstScan = serial.refresh(true);
const joinedScan = serial.refresh();
const freshScan = serial.refresh(true);
while (!releaseScan) await new Promise(resolve => setImmediate(resolve));
releaseScan();
await Promise.all([firstScan, joinedScan, freshScan]);
assert.equal(maxQueries, 1, "polls and explicit refreshes must never overlap");
assert.equal(scanCount, 2, "explicit actions must receive a fresh result after an in-flight poll");
serial.dispose();

// Exercise the macOS adapter's JXA entry point against AppKit-shaped doubles.
const nativeCalls = [];
const app = {
  isNil: () => false, isTerminated: false,
  launchDate: { timeIntervalSince1970: Date.parse(macRow.startTime) / 1000 },
  executableURL: { path: macRow.executable },
  activateWithOptions(options) { nativeCalls.push(["focus", options]); return true; },
  get terminate() { nativeCalls.push(["close"]); return true; },
  get forceTerminate() { nativeCalls.push(["force"]); return true; }
};
const context = vm.createContext({ ObjC: { import() {}, unwrap: value => value }, $: {
  NSRunningApplication: { runningApplicationWithProcessIdentifier: pid => pid === macRow.pid ? app : null },
  NSTask: { alloc: { get init() { return { terminationStatus: 0 }; } } },
  NSProcessInfo: { processInfo: { environment: { get mutableCopy() { return { setObjectForKey() {} }; } } } },
  NSPipe: { get pipe() { return { fileHandleForReading: { readDataToEndOfFile: `${macRow.startTime} ${macRow.command}\n` } }; } },
  NSString: { alloc: { initWithDataEncoding: value => value } }, NSUTF8StringEncoding: 4
} });
vm.runInContext(MAC_RUNTIME_ACTION_SCRIPT, context);
for (const action of ["focus", "close", "force"]) {
  assert.equal(JSON.parse(context.run([JSON.stringify({ process: macRow, action })])).performed, true);
}
assert.deepEqual(nativeCalls, [["focus", 3], ["close"], ["force"]]);
assert.throws(() => context.run([JSON.stringify({ process: { ...macRow, startTime: "Fri Nov 6 11:00:00 2026" }, action: "close" })]), /identity changed/);
app.isTerminated = true;
assert.throws(() => context.run([JSON.stringify({ process: macRow, action: "close" })]), /exited/);
console.log("Profile runtime verification passed (Windows/macOS matching, events, focus, close isolation, double-clicks, PID reuse, failures, polling).");
