import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-official-inheritance-"));
process.env.CODEX_PROFILE_MANAGER_HOME_OVERRIDE = testRoot;
process.env.CODEX_PROFILE_MANAGER_PLATFORM_OVERRIDE = "win32";
process.env.APPDATA = path.join(testRoot, "AppData", "Roaming");

const { createProfile, updateProfile } = await import("../dist-electron/main/profile-service.js");
const { listConfigBackups, writeCodexConfig } = await import("../dist-electron/main/codex-config.js");
const { testProvider } = await import("../dist-electron/main/provider-test.js");
const defaultHome = path.join(testRoot, ".codex");
const sourcePath = path.join(defaultHome, "config.toml");
const codexAppPath = path.join(testRoot, "Codex.exe");
const apiKey = "sk-test-official-inheritance";
const sourceLines = [
  'model = "old-model"',
  'model_reasoning_effort = "high"',
  'model_provider = "proxy"',
  'profile = "legacy.proxy"',
  'openai_base_url = "https://old-proxy.invalid/v1"',
  'chatgpt_base_url = "https://old-login.invalid"',
  'forced_login_method = "api"',
  'forced_chatgpt_workspace_id = "old-workspace"',
  'model_catalog_json = "old-model-catalog.json"',
  'approval_policy = "on-request"',
  '',
  '[model_providers.openai]',
  'name = "Old OpenAI override"',
  'base_url = "https://old-proxy.invalid/v1"',
  'requires_openai_auth = false',
  '',
  '[model_providers."proxy"] # quoted provider, with a comment',
  'base_url = "https://other-proxy.invalid/v1"',
  'experimental_bearer_token = "old-provider-token"',
  '',
  '[profiles."legacy.proxy"] # retain general settings in named profiles',
  'model = "old-profile-model"',
  'model_provider = "proxy"',
  'openai_base_url = "https://old-proxy.invalid/v1"',
  'forced_login_method = "api"',
  'approval_policy = "untrusted"',
  '',
  '[mcp_servers.example]',
  'command = "node"',
  'args = ["server.js"]',
  '[mcp_servers.example.env]',
  'model_provider = "keep-this-mcp-variable"',
  '',
  '[features]',
  'multi_agent = true',
  '',
  '[projects."C:/workspace"]',
  'trust_level = "trusted"',
  ''
];

function assertOfficialConfig(raw, label, inherit = true) {
  const config = parse(raw);
  assert.equal(config.model, undefined, label);
  assert.equal(config.model_reasoning_effort, undefined, label);
  const forbiddenKeys = ["model_provider", "model_providers", "profile", "openai_base_url",
    "chatgpt_base_url", "forced_login_method", "forced_chatgpt_workspace_id", "model_catalog_json", "model", "model_reasoning_effort"];
  for (const table of [config, ...Object.values(config.profiles ?? {})]) {
    for (const key of forbiddenKeys) {
      assert.equal(Object.hasOwn(table, key), false, `${label}: inherited ${key}`);
    }
  }
  if (inherit) {
    assert.equal(config.approval_policy, "on-request", label);
    assert.equal(config.profiles["legacy.proxy"].approval_policy, "untrusted", label);
    assert.equal(config.mcp_servers.example.command, "node", label);
    assert.deepEqual(config.mcp_servers.example.args, ["server.js"], label);
    assert.equal(config.mcp_servers.example.env.model_provider, "keep-this-mcp-variable", label);
    assert.equal(config.features.multi_agent, true, label);
    assert.equal(config.projects["C:/workspace"].trust_level, "trusted", label);
  } else {
    assert.equal(config.mcp_servers, undefined, label);
  }
}

try {
  await fs.writeFile(codexAppPath, "test executable placeholder\n");
  await fs.mkdir(path.join(defaultHome, "skills", "sample"), { recursive: true });
  await fs.writeFile(path.join(defaultHome, "skills", "sample", "SKILL.md"), "Sample skill\n");
  await fs.writeFile(path.join(defaultHome, "auth.json"), '{"old_account":"do-not-copy"}\n');
  for (const [lineEnding, syntax] of [["\n", "tables"], ["\r\n", "tables"], ["\r\n", "inline"]]) {
    let source = sourceLines.join(lineEnding);
    if (syntax === "inline") {
      source = source.replace(/model_provider = "proxy"/g, '"model_provider" = "proxy"')
        .replace(/\[model_providers\.openai\]\r\nname = "Old OpenAI override"\r\nbase_url = "https:\/\/old-proxy.invalid\/v1"\r\nrequires_openai_auth = false/,
          '[model_providers]\r\nopenai = { base_url = "https://old-proxy.invalid/v1", requires_openai_auth = false }');
    }
    await fs.writeFile(sourcePath, source);
    for (const authMode of ["chatgpt_account", "api_key"]) {
      const label = `${authMode}-${syntax}-${lineEnding.length}`;
      const result = await createProfile({
        name: label,
        authMode,
        inheritDefaultConfig: true,
        codexAppPath,
        provider: { type: "official_openai", displayName: "OpenAI", model: "gpt-5.2", apiKey }
      });
      const { profile, configPath } = result;
      assert.equal(profile.provider.model, undefined, "official presets from stale clients must be ignored");
      assertOfficialConfig(await fs.readFile(configPath, "utf8"), label);
      assert.equal(await fs.readFile(path.join(profile.paths.codexHome, "skills", "sample", "SKILL.md"), "utf8"), "Sample skill\n");
      const authPath = path.join(profile.paths.codexHome, "auth.json");
      if (authMode === "chatgpt_account") {
        await assert.rejects(fs.access(authPath), { code: "ENOENT" });
        await fs.writeFile(authPath, '{"tokens":{"access_token":"keep-account-session"}}\n');
      }
      const authBefore = await fs.readFile(authPath, "utf8");
      // Existing affected profiles go through this path on both update and launch.
      await fs.writeFile(configPath, source);
      await updateProfile({ profileId: profile.id, provider: { displayName: "OpenAI", model: "gpt-5.2" } });
      const repaired = await fs.readFile(configPath, "utf8");
      assertOfficialConfig(repaired, `${label}: repaired`);
      const backups = await listConfigBackups(profile);
      assert.equal(await fs.readFile(backups[0].backupPath, "utf8"), source);
      await writeCodexConfig(profile, { preserveExistingConfig: true });
      assert.equal(await fs.readFile(configPath, "utf8"), repaired, `${label}: repeated writes`);
      assert.equal(await fs.readFile(authPath, "utf8"), authBefore, `${label}: account/API auth unchanged`);

      await fs.writeFile(configPath, 'model = "chosen-in-app"\nmodel_reasoning_effort = "high"\n');
      await writeCodexConfig(profile, { preserveExistingConfig: true });
      await updateProfile({ profileId: profile.id, provider: { displayName: "OpenAI" } });
      const appConfig = parse(await fs.readFile(configPath, "utf8"));
      assert.equal(appConfig.model, "chosen-in-app", "App model choices must survive launch/update writes");
      assert.equal(appConfig.model_reasoning_effort, "high");

      await fs.writeFile(configPath, '# --- Codex Profile Manager managed settings ---\nmodel = "old-managed-model"\nmodel_reasoning_effort = "medium"\n# --- End Codex Profile Manager managed settings ---\n');
      await writeCodexConfig(profile, { preserveExistingConfig: true });
      assert.equal(parse(await fs.readFile(configPath, "utf8")).model, undefined, "legacy managed presets must be removed");
    }
    assert.equal(await fs.readFile(sourcePath, "utf8"), source, "default config unchanged");
  }
  for (const authMode of ["chatgpt_account", "api_key"]) {
    const result = await createProfile({
      name: `fresh-${authMode}`,
      authMode,
      inheritDefaultConfig: false,
      codexAppPath,
      provider: { type: "official_openai", displayName: "OpenAI", apiKey }
    });
    assertOfficialConfig(await fs.readFile(result.configPath, "utf8"), `fresh-${authMode}`, false);
  }

  await fs.writeFile(sourcePath, [
    'model = "old-model"',
    'model_provider = "proxy"',
    '[model_providers.proxy]',
    'name = "Old proxy"',
    'base_url = "https://old-proxy.invalid/v1"',
    '[features]',
    'multi_agent = true',
    ''
  ].join("\r\n"));
  const proxy = await createProfile({
    name: "proxy-crlf",
    inheritDefaultConfig: true,
    codexAppPath,
    provider: { type: "third_party_responses", displayName: "New proxy", baseUrl: "https://new-proxy.invalid/v1", model: "gpt-5.2", apiKey }
  });
  const proxyConfig = parse(await fs.readFile(proxy.configPath, "utf8"));
  assert.equal(proxyConfig.model_provider, "proxy");
  assert.equal(proxyConfig.model_providers.proxy.base_url, "https://new-proxy.invalid/v1");
  assert.equal(proxyConfig.features.multi_agent, true);

  let status = 200;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "model-one" }, { id: "model-two" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const connection = await testProvider({ baseUrl, apiKey });
    assert.equal(connection.ok, true);
    assert.equal(connection.testedResponsesEndpoint, false, "official connection tests must not select a Responses model");
    assert.deepEqual(requests, ["/models"]);
    status = 401;
    assert.equal((await testProvider({ baseUrl, apiKey })).status, "auth_failed");
    status = 503;
    assert.equal((await testProvider({ baseUrl, apiKey })).ok, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log("Official config inheritance verification passed (account/API, LF/CRLF, quoted/inline TOML, repair, backups, auth isolation).");
} finally {
  await fs.rm(testRoot, { recursive: true, force: true });
}
