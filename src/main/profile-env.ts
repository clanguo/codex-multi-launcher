import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "./fs-utils.js";
import { getDefaultCodexHome } from "./paths.js";
import type { DefaultProfileEnvFile, ManagedProfile, ProfileEnvFileInput } from "../shared/types.js";

async function readDefaultEnv(): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(getDefaultCodexHome(), ".env"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new Error(`Could not read the default Codex .env file (${code ?? "unknown error"}).`);
  }
}

export async function getDefaultProfileEnvFile(): Promise<DefaultProfileEnvFile> {
  const content = await readDefaultEnv();
  return { path: path.join(getDefaultCodexHome(), ".env"), content: content?.toString("utf8") ?? null };
}

export async function writeProfileEnvFile(profile: ManagedProfile, input?: ProfileEnvFileInput): Promise<void> {
  if (input?.copy === false) return;
  const content = input?.content !== undefined ? input.content : await readDefaultEnv();
  if (content === null) return;
  await ensureDir(profile.paths.codexHome);
  await fs.writeFile(path.join(profile.paths.codexHome, ".env"), content, { mode: 0o600 });
}
