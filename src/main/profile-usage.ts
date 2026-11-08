import fs from "node:fs/promises";
import path from "node:path";
import { findProfile } from "./registry.js";
import { getApiKey, getUsageCredential } from "./secrets.js";
import type { ManagedProfile, ProfileUsageResult } from "../shared/types.js";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

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
  const authPath = path.join(profile.paths.codexHome, "auth.json");
  let auth: any;
  try { auth = JSON.parse(await fs.readFile(authPath, "utf8")); }
  catch { throw new Error("No readable Codex account login was found for this profile. Sign in to the profile first."); }
  const accessToken = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!accessToken || !accountId) throw new Error("This profile does not contain a ChatGPT account token. Sign in to the profile first.");
  const response = await fetch(CODEX_USAGE_URL, { headers: { Authorization: `Bearer ${accessToken}`, "ChatGPT-Account-Id": accountId, Accept: "application/json", originator: "Codex Desktop" }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Codex account session expired. Sign in again in this profile." : `Codex usage endpoint returned HTTP ${response.status}.`);
  const data = await response.json() as any;
  const rate = data.rate_limit ?? data;
  const windows = [
    { name: "Primary", value: rate.primary_window ?? rate.primary },
    { name: "Secondary", value: rate.secondary_window ?? rate.secondary }
  ].flatMap(({ name, value }) => typeof value?.used_percent === "number" ? [{ name, usedPercent: value.used_percent, resetsAt: typeof value.reset_at === "number" ? new Date(value.reset_at * 1000).toISOString() : undefined }] : []);
  if (!windows.length) throw new Error("Codex returned usage data in an unrecognized format.");
  return { profileId: profile.id, mode: "codex_account", queriedAt: new Date().toISOString(), planName: typeof data.plan_type === "string" ? data.plan_type : undefined, windows };
}

function numberAt(value: unknown, pointer?: string): number | undefined {
  if (!pointer) return undefined;
  const parts = pointer.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let current: any = value;
  for (const part of parts) current = current?.[part];
  const numeric = typeof current === "number" ? current : typeof current === "string" && current.trim() ? Number(current) : NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}
