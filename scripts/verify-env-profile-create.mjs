import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-profile-env-"));
process.env.CODEX_PROFILE_MANAGER_HOME_OVERRIDE = testRoot;
process.env.CODEX_PROFILE_MANAGER_PLATFORM_OVERRIDE = "win32";
process.env.APPDATA = path.join(testRoot, "AppData", "Roaming");

const { createProfile, updateProfile } = await import("../dist-electron/main/profile-service.js");
const { getDefaultProfileEnvFile } = await import("../dist-electron/main/profile-env.js");
const { getAppPaths } = await import("../dist-electron/main/paths.js");
const codexAppPath = path.join(testRoot, "Codex.exe");
const defaultEnvPath = path.join(testRoot, ".codex", ".env");
const original = '\uFEFF# 中文 comment\r\nOPENAI_API_KEY=keep-all-values\r\nDUPLICATE=one\r\nDUPLICATE=two\r\nSPACES="  value  "\r\n\r\n';

async function create(name, envFile, inheritDefaultConfig = false) {
  const result = await createProfile({
    name,
    authMode: "chatgpt_account",
    codexAppPath,
    inheritDefaultConfig,
    envFile,
    provider: { type: "official_openai", displayName: "OpenAI", model: "gpt-5.2" }
  });
  return { ...result, envPath: path.join(result.profile.paths.codexHome, ".env") };
}

try {
  await fs.writeFile(codexAppPath, "test executable\n");
  await fs.mkdir(path.dirname(defaultEnvPath));
  await fs.writeFile(defaultEnvPath, original);
  assert.deepEqual(await getDefaultProfileEnvFile(), { path: defaultEnvPath, content: original });
  for (const inherit of [false, true]) {
    const copied = await create(`default-${inherit}`, undefined, inherit);
    assert.deepEqual(await fs.readFile(copied.envPath), Buffer.from(original), "default copy must preserve every byte");
  }
  const editedContent = '# only the copy changes\nCUSTOM_KEY="edited value"\n\n';
  const edited = await create("edited", { copy: true, content: editedContent });
  assert.equal(await fs.readFile(edited.envPath, "utf8"), editedContent);
  await updateProfile({ profileId: edited.profile.id, provider: { displayName: "OpenAI", model: "gpt-5.2" } });
  assert.equal(await fs.readFile(edited.envPath, "utf8"), editedContent, "updates must not recopy .env");
  const empty = await create("empty", { copy: true, content: "" });
  assert.equal((await fs.stat(empty.envPath)).size, 0, "intentional empty contents must not fall back to the source");
  const skipped = await create("skipped", { copy: false, content: editedContent });
  await assert.rejects(fs.access(skipped.envPath), { code: "ENOENT" });
  assert.equal(await fs.readFile(defaultEnvPath, "utf8"), original, "source must remain unchanged");
  const registry = await fs.readFile(getAppPaths().profilesFile, "utf8");
  assert.equal(registry.includes("keep-all-values"), false);
  assert.equal(registry.includes("edited value"), false);

  await fs.unlink(defaultEnvPath);
  assert.deepEqual(await getDefaultProfileEnvFile(), { path: defaultEnvPath, content: null });
  const missing = await create("missing");
  await assert.rejects(fs.access(missing.envPath), { code: "ENOENT" });
  const newFile = await create("new-file", { copy: true, content: "NEW_KEY=new-value\n" });
  assert.equal(await fs.readFile(newFile.envPath, "utf8"), "NEW_KEY=new-value\n");

  await fs.mkdir(defaultEnvPath);
  await assert.rejects(getDefaultProfileEnvFile(), /Could not read the default Codex \.env file/);
  await create("skip-unreadable", { copy: false });
  console.log("Profile .env verification passed (full copy, edits, empty/missing files, skip, source isolation, no registry content).");
} finally {
  await fs.rm(testRoot, { recursive: true, force: true });
}
