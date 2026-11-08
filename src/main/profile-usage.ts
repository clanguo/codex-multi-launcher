import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { parseEnv } from "node:util";
import { resolveCliTarget } from "./cli-runner.js";
import { defaultExecutablePathEnv } from "./executable-lookup.js";
import { findProfile } from "./registry.js";
import { getApiKey, getUsageCredential } from "./secrets.js";
import type { ManagedProfile, ProfileUsageResult } from "../shared/types.js";

export async function queryProfileUsage(profileId: string): Promise<ProfileUsageResult> {
  const profile = await findProfile(profileId);
  if (!profile || profile.status !== "active") throw new Error("Profile is missing, removed, or disabled.");
  const config = profile.usageQuery;
  if (!config?.enabled) throw new Error("Usage query is not enabled for this profile.");
  if (config.mode === "codex_account") return queryCodexAccount(profile);

  const url = config.url?.trim();
  if (!url) throw new Error("Enter a usage query URL first.");
  const parsedUrl = new URL(url);
  if (!["https:", "http:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) throw new Error("Usage URL must use HTTP(S) and must not contain embedded credentials.");
  const credential = await getUsageCredential(profileId) || await getApiKey(profileId, profile.provider.id) || "";
  const baseUrl = profile.provider.baseUrl ?? "https://api.openai.com/v1";
  let headers: Record<string, string> = {};
  try { headers = config.headers?.trim() ? JSON.parse(config.headers) : {}; }
  catch { throw new Error("Request headers must be a JSON object."); }
  if (!headers || Array.isArray(headers) || typeof headers !== "object" || Object.values(headers).some(value => typeof value !== "string")) throw new Error("Request headers must be a JSON object with string values.");
  const expanded = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, (value as string).replaceAll("{{apiKey}}", credential).replaceAll("{{credential}}", credential).replaceAll("{{baseUrl}}", baseUrl)]));
  if (Object.keys(expanded).some(key => /^(host|content-length|connection)$/i.test(key))) throw new Error("Host, Content-Length, and Connection headers cannot be overridden.");
  const method = config.method ?? "GET";
  const requestBody = method === "POST" && config.body ? config.body.replaceAll("{{apiKey}}", credential).replaceAll("{{credential}}", credential).replaceAll("{{baseUrl}}", baseUrl) : undefined;
  const response = await fetch(parsedUrl, { method, headers: expanded, body: requestBody, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Usage endpoint returned HTTP ${response.status}. Check the URL and credential.`);
  const body: unknown = await response.json();
  const remaining = numberAt(body, config.remainingPath);
  const total = numberAt(body, config.totalPath);
  const used = numberAt(body, config.usedPath);
  if (remaining === undefined && total === undefined && used === undefined) throw new Error("Response did not contain a numeric value at the configured JSON path.");
  return { profileId, mode: config.mode, queriedAt: new Date().toISOString(), remaining, total, used, unit: config.unit?.trim() || "" };
}

async function queryCodexAccount(profile: ManagedProfile): Promise<ProfileUsageResult> {
  let profileEnv: NodeJS.ProcessEnv = {};
  try { profileEnv = parseEnv(await fs.readFile(path.join(profile.paths.codexHome, ".env"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read this profile's .env file."); }
  const home = path.dirname(profile.paths.codexHome);
  let target;
  try { target = await resolveCliTarget({ ...process.env, ...profileEnv }, { home, fallbackPath: defaultExecutablePathEnv(), cliExecutablePath: null }); }
  catch { throw new Error("Could not find the Codex CLI for this profile. Install it or set CODEX_PROFILE_CLI_PATH in the profile's .env file."); }
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: profile.paths.codexHome };
  for (const key of ["CODEX_ACCESS_TOKEN", "CODEX_HOME", "OPENAI_API_KEY", "CODEX_API_KEY", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"]) delete env[key];
  Object.assign(env, profileEnv);
  env.CODEX_HOME = profile.paths.codexHome;
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"]) delete env[key];
  if (target.extraPath?.length) env.PATH = [...target.extraPath, env.PATH ?? ""].join(path.delimiter);
  if (target.managedByNpm) env.CODEX_MANAGED_BY_NPM = "1";
  if (target.args.length && target.file === process.execPath && process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  const data = await readAppServerUsage(target.file, [...target.args, "app-server"], env);
  const rate = data.rateLimits ?? data;
  const limits = Object.values(rate.rateLimitsByLimitId ?? {}) as any[];
  const rows = limits.length ? limits : [rate];
  const windows = rows.flatMap((limit: any) => [
    { name: limit.limitName || limit.limitId || "Primary", value: limit.primary },
    { name: `${limit.limitName || limit.limitId || ""} · Secondary`, value: limit.secondary }
  ].flatMap(({ name, value }) => typeof value?.usedPercent === "number" ? [{ name: name.trim().replace(/^· /, ""), usedPercent: value.usedPercent, resetsAt: typeof value.resetsAt === "number" ? new Date(value.resetsAt * 1000).toISOString() : undefined }] : []));
  if (!windows.length) throw new Error("Codex returned usage data in an unrecognized format.");
  return { profileId: profile.id, mode: "codex_account", queriedAt: new Date().toISOString(), planName: typeof data.planType === "string" ? data.planType : undefined, windows };
}

function readAppServerUsage(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: "pipe", windowsHide: true, shell: false });
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => { child.kill(); finish(new Error("Codex usage query timed out. Try again.")); }, 20000);
    let settled = false;
    let initializeSent = false;
    const finish = (error?: Error, value?: any) => {
      if (settled) return;
      settled = true; clearTimeout(timer); lines.close();
      child.kill();
      if (error) reject(error); else resolve(value);
    };
    child.once("error", () => finish(new Error("Could not start Codex app-server for this profile.")));
    lines.on("line", (line) => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) {
        if (message.error) return finish(new Error("Codex app-server could not initialize this profile's account. Sign in to the profile first."));
        if (!initializeSent) {
          initializeSent = true;
          child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
          child.stdin.write(`${JSON.stringify({ method: "account/rateLimits/read", id: 2, params: {} })}\n`);
        }
      } else if (message.id === 2) {
        if (message.error) return finish(new Error("Codex could not read subscription usage. Sign in again in this profile, then retry."));
        finish(undefined, message.result);
      }
    });
    child.once("exit", (code) => { if (!settled) finish(new Error(code === 0 ? "Codex app-server closed before returning usage data." : "Codex app-server failed. Sign in to this profile and try again.")); });
    child.stdin.write(`${JSON.stringify({ method: "initialize", id: 1, params: { clientInfo: { name: "codex-profile-manager", title: "Codex Profile Manager", version: "0.1.9" }, capabilities: { experimentalApi: true } } })}\n`);
  });
}

function numberAt(value: unknown, pointer?: string): number | undefined {
  if (!pointer) return undefined;
  const parts = pointer.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let current: any = value;
  for (const part of parts) current = current?.[part];
  const numeric = typeof current === "number" ? current : typeof current === "string" && current.trim() ? Number(current) : NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}
