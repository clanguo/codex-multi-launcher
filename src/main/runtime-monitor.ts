import path from "node:path";
import { listProfiles } from "./registry.js";
import { createRuntimePlatform, type RuntimePlatform, type RuntimeProcess } from "./runtime-platform.js";
import type { CloseProfileResult, ManagedProfile, OpenProfileResult, ProfileRuntimeInfo, RuntimeSnapshot } from "../shared/types.js";

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function matchesProfileProcess(row: RuntimeProcess, profile: ManagedProfile, platform: RuntimePlatform["platform"]): boolean {
  if (!row.pid || !row.startTime || /(?:^|\s)--type(?:=|\s)/.test(row.command)) return false;
  const isWindows = platform === "win32";
  const command = isWindows ? row.command.replace(/\\/g, "/").toLowerCase() : row.command;
  const directory = isWindows ? path.win32.normalize(profile.paths.userDataDir).replace(/\\/g, "/").toLowerCase() : path.posix.normalize(profile.paths.userDataDir);
  const match = new RegExp(`(?:^|\\s)--user-data-dir(?:=|\\s+)(?:"${escapeRegExp(directory)}"|'${escapeRegExp(directory)}'|${escapeRegExp(directory)})(?=$|\\s+--)`);
  if (!match.test(command)) return false;
  const executable = row.executable.replace(/\\/g, "/");
  const configured = profile.paths.codexAppPath.replace(/\\/g, "/");
  if (isWindows) {
    const name = path.posix.basename(executable).toLowerCase();
    if (name !== "codex.exe" && name !== "chatgpt.exe" && executable.toLowerCase() !== configured.toLowerCase()) return false;
    return !/\/(?:resources|bin)\//i.test(executable);
  }
  return executable === configured || (configured.endsWith(".app") && executable.startsWith(`${configured}/Contents/MacOS/`) && /\/(?:ChatGPT|Codex)$/.test(executable)) || /\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/(?:ChatGPT|Codex)$/.test(executable);
}

interface Transition { kind: "starting" | "closing"; deadline: number; pid: number | null }
interface MonitorOptions {
  platform: RuntimePlatform;
  readProfiles: () => Promise<ManagedProfile[]>;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export class ProfileRuntimeMonitor {
  private platform: RuntimePlatform;
  private readProfiles: MonitorOptions["readProfiles"];
  private now: () => number;
  private onError: (error: unknown) => void;
  private instances = new Map<string, RuntimeProcess[]>();
  private transitions = new Map<string, Transition>();
  private errors = new Map<string, string>();
  private forceAllowed = new Set<string>();
  private actions = new Map<string, { kind: "open" | "close"; promise: Promise<OpenProfileResult | CloseProfileResult> }>();
  private snapshot: RuntimeSnapshot = { revision: 0, profiles: [] };
  private listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  private refreshing: Promise<RuntimeSnapshot> | null = null;
  private lastDiscovery = -Infinity;
  private discoveryRevision = 0;
  private profileSignature = "";
  private timer: NodeJS.Timeout | null = null;
  private monitoring = false;
  private disposed = false;
  private foreground = true;

  constructor(options: MonitorOptions) {
    this.platform = options.platform;
    this.readProfiles = options.readProfiles;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => {});
  }

  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  getSnapshot(): RuntimeSnapshot { return this.snapshot; }
  getPollInterval(): number { return this.transitions.size ? 1000 : this.foreground ? 3000 : 15000; }
  start(): void { if (this.disposed || this.monitoring) return; this.monitoring = true; this.schedule(0); }
  setForeground(foreground: boolean): void {
    const changed = this.foreground !== foreground;
    this.foreground = foreground;
    if (this.monitoring && changed) this.schedule(foreground ? 0 : this.getPollInterval());
  }
  requestRefresh(discover = true): void {
    if (this.disposed) return;
    if (discover) { this.lastDiscovery = -Infinity; this.discoveryRevision += 1; }
    if (this.monitoring) this.schedule(0);
  }
  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().catch(this.onError).finally(() => { if (this.monitoring) this.schedule(this.getPollInterval()); });
    }, delay);
    this.timer.unref();
  }

  async refresh(discover = false): Promise<RuntimeSnapshot> {
    if (this.disposed) return this.snapshot;
    if (this.refreshing) {
      const result = await this.refreshing;
      return discover ? this.refresh(true) : result;
    }
    const pending = this.inspect(discover);
    this.refreshing = pending;
    try { return await pending; }
    finally { if (this.refreshing === pending) this.refreshing = null; }
  }

  private publish(profiles: ProfileRuntimeInfo[]): RuntimeSnapshot {
    const signature = (rows: ProfileRuntimeInfo[]) => JSON.stringify(rows.map(({ checkedAt: _checkedAt, ...row }) => row));
    if (signature(profiles) !== signature(this.snapshot.profiles)) {
      this.snapshot = { revision: this.snapshot.revision + 1, profiles };
      for (const listener of this.listeners) {
        try { listener(this.snapshot); } catch (error) { this.onError(error); }
      }
    }
    return this.snapshot;
  }

  private async inspect(discover: boolean): Promise<RuntimeSnapshot> {
    const profiles = (await this.readProfiles()).filter((profile) => profile.status !== "deleted");
    const profileIds = new Set(profiles.map((profile) => profile.id));
    for (const id of this.transitions.keys()) if (!profileIds.has(id)) this.transitions.delete(id);
    for (const id of this.errors.keys()) if (!profileIds.has(id)) this.errors.delete(id);
    for (const id of this.forceAllowed) if (!profileIds.has(id)) this.forceAllowed.delete(id);
    if (!profiles.length) {
      this.instances.clear();
      this.profileSignature = "";
      this.platform.dispose();
      return this.publish([]);
    }
    const signature = JSON.stringify(profiles.map((profile) => [profile.id, profile.paths.userDataDir, profile.paths.codexAppPath]));
    try {
      let processes: RuntimeProcess[];
      if (discover || signature !== this.profileSignature || this.now() - this.lastDiscovery >= 30000) {
        const discoveryRevision = this.discoveryRevision;
        processes = await this.platform.scan(profiles);
        this.lastDiscovery = discoveryRevision === this.discoveryRevision ? this.now() : -Infinity;
        this.profileSignature = signature;
      } else {
        processes = await this.platform.inspect([...this.instances.values()].flat());
      }
      if (this.disposed) return this.snapshot;
      this.instances.clear();
      const rows = profiles.map((profile): ProfileRuntimeInfo => {
        const matches = processes.filter((row) => matchesProfileProcess(row, profile, this.platform.platform));
        matches.sort((a, b) => Number(b.hasWindow) - Number(a.hasWindow));
        this.instances.set(profile.id, matches);
        const process = matches[0];
        const pending = this.transitions.get(profile.id);
        let status: ProfileRuntimeInfo["status"] = process ? process.hasWindow === false ? "background" : "running" : "not_running";
        let detail = process ? "Profile process verified by user-data-dir and process identity." : "No process found for this profile.";
        if (pending) {
          if (pending.kind === "starting" && process) {
            if (process.hasWindow !== false || this.now() >= pending.deadline) this.transitions.delete(profile.id);
            else status = "starting";
          } else if (pending.kind === "closing" && !process) {
            this.transitions.delete(profile.id);
            this.forceAllowed.delete(profile.id);
          } else if (this.now() < pending.deadline) status = pending.kind;
          else {
            this.transitions.delete(profile.id);
            if (pending.kind === "starting") {
              status = "error";
              this.errors.set(profile.id, "The profile did not start. Check its launch log.");
            } else {
              detail = "The profile is still running. It may be waiting for confirmation in its window.";
              this.forceAllowed.add(profile.id);
            }
          }
        }
        if (process && status !== "starting") this.errors.delete(profile.id);
        if (!process && this.errors.has(profile.id)) { status = "error"; detail = this.errors.get(profile.id)!; }
        if (!process) this.forceAllowed.delete(profile.id);
        return { profileId: profile.id, status, pid: process?.pid ?? (status === "starting" ? pending?.pid ?? null : null), hasWindow: process?.hasWindow ?? null, canForceClose: this.forceAllowed.has(profile.id), detail, checkedAt: this.now() };
      });
      return this.publish(rows);
    } catch (error) {
      this.lastDiscovery = -Infinity;
      this.onError(error);
      return this.publish(profiles.map((profile) => ({
        profileId: profile.id, status: "unknown", pid: null, hasWindow: null, canForceClose: false,
        detail: error instanceof Error ? error.message : "Could not inspect profile processes.", checkedAt: this.now()
      })));
    }
  }

  private transition(profileId: string, kind: Transition["kind"], pid: number | null): void {
    this.errors.delete(profileId);
    this.forceAllowed.delete(profileId);
    this.transitions.set(profileId, { kind, pid, deadline: this.now() + (kind === "starting" ? 45000 : 8000) });
    this.publish(this.snapshot.profiles.map((row) => row.profileId === profileId ? { ...row, status: kind, pid, canForceClose: false } : row));
    this.requestRefresh();
  }

  private action<T extends OpenProfileResult | CloseProfileResult>(profileId: string, kind: "open" | "close", run: () => Promise<T>): Promise<T> {
    const existing = this.actions.get(profileId);
    if (existing) {
      if (existing.kind === kind) return existing.promise as Promise<T>;
      return Promise.reject(new Error("This profile is busy. Wait for its current operation to finish."));
    }
    const promise = run();
    this.actions.set(profileId, { kind, promise });
    void promise.finally(() => { if (this.actions.get(profileId)?.promise === promise) this.actions.delete(profileId); }).catch(() => {});
    return promise;
  }

  open(profile: ManagedProfile, launch: () => Promise<{ pid: number | null }>): Promise<OpenProfileResult> {
    return this.action(profile.id, "open", async () => {
      await this.refresh(true);
      const state = this.snapshot.profiles.find((row) => row.profileId === profile.id);
      if (!state || state.status === "unknown") throw new Error("Could not verify whether this profile is already running. Refresh and retry.");
      if (state.status === "closing") throw new Error("This profile is closing. Wait for it to exit.");
      const existing = this.instances.get(profile.id)?.[0];
      if (existing) {
        const result = await this.platform.act(existing, "focus");
        if (result.hasWindow === false) throw new Error("This profile is running in the background and has no window to open. Close it before starting again.");
        return { pid: existing.pid, action: result.performed ? "focused" : "attention" };
      }
      if (state.status === "starting") return { pid: state.pid, action: "starting" };
      this.transition(profile.id, "starting", null);
      try {
        const result = await launch();
        const pending = this.transitions.get(profile.id);
        if (pending?.kind === "starting") pending.pid = result.pid;
        this.requestRefresh();
        return { ...result, action: "started" };
      } catch (error) {
        this.transitions.delete(profile.id);
        this.errors.set(profile.id, error instanceof Error ? error.message : "Profile launch failed.");
        await this.refresh(true);
        throw error;
      }
    });
  }

  close(profile: ManagedProfile, force = false): Promise<CloseProfileResult> {
    return this.action(profile.id, "close", async () => {
      await this.refresh(true);
      const state = this.snapshot.profiles.find((row) => row.profileId === profile.id);
      if (!state || state.status === "unknown") throw new Error("Could not verify this profile's process identity. Refresh and retry.");
      const instances = this.instances.get(profile.id) ?? [];
      if (!instances.length) {
        if (state.status === "starting") throw new Error("This profile is starting. Wait for its process to appear.");
        return { action: "not_running" };
      }
      this.transition(profile.id, "closing", instances[0].pid);
      try {
        for (const instance of instances) {
          const result = await this.platform.act(instance, force ? "force" : "close");
          if (!result.performed) throw new Error("The profile did not accept the close request. Open its window to check, or use Force stop.");
        }
        this.requestRefresh();
        return { action: "closing" };
      } catch (error) {
        this.transitions.delete(profile.id);
        this.forceAllowed.add(profile.id);
        await this.refresh(true);
        throw error;
      }
    });
  }

  processSpawned(profileId: string, pid: number | undefined): void {
    const pending = this.transitions.get(profileId);
    if (pending?.kind === "starting") pending.pid = pid ?? null;
    this.requestRefresh();
  }
  processExited(profileId: string, pid: number | undefined): void {
    const pending = this.transitions.get(profileId);
    if (pending?.kind === "starting" && pending.pid === pid) {
      this.transitions.delete(profileId);
      this.errors.set(profileId, "The desktop process exited before its window was ready. Check its launch log.");
    }
    this.requestRefresh();
  }
  dispose(): void {
    this.disposed = true;
    this.monitoring = false;
    if (this.timer) clearTimeout(this.timer);
    this.platform.dispose();
    this.listeners.clear();
  }
}

let monitor: ProfileRuntimeMonitor | null = null;
export function getProfileRuntime(): ProfileRuntimeMonitor {
  return monitor ??= new ProfileRuntimeMonitor({ platform: createRuntimePlatform(), readProfiles: listProfiles });
}
export async function getRuntimeStatus(_profiles?: ManagedProfile[]): Promise<ProfileRuntimeInfo[]> {
  return (await getProfileRuntime().refresh(true)).profiles;
}
