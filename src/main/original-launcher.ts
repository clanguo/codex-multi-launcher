import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pathExists } from "./fs-utils.js";
import { findWindowsCodexAppxDesktopApp, getRuntimePlatform, isWindowsAppsPath, resolveCodexDesktopApp } from "./paths.js";

const execFileAsync = promisify(execFile);

export async function openOriginalCodex(preferredPath?: string): Promise<{ ok: true }> {
  const desktop = resolveCodexDesktopApp(preferredPath);
  const platform = getRuntimePlatform();
  const env = { ...process.env };
  // The manager may itself have been opened from an isolated profile.
  for (const key of Object.keys(env)) {
    if (/^(CODEX_HOME|USER_DATA_DIR|CODEX_EXE|ELECTRON_RUN_AS_NODE|OPENAI_API_KEY|OPENAI_BASE_URL)$/i.test(key) || /^CODEX_PROFILE_/i.test(key)) {
      delete env[key];
    }
  }

  if (platform === "win32" && (desktop.source === "missing" || isWindowsAppsPath(desktop.executablePath))) {
    const appx = findWindowsCodexAppxDesktopApp();
    if (appx) {
      await execFileAsync("explorer.exe", [`shell:AppsFolder\\${appx.packageFamilyName}!${appx.applicationId}`], { env, windowsHide: true });
      return { ok: true };
    }
  }

  if (!(await pathExists(desktop.executablePath))) {
    throw new Error(`未找到原始 Codex / ChatGPT App：${desktop.appPath}。请先安装桌面 App。`);
  }

  if (platform === "darwin" && desktop.appPath.toLowerCase().endsWith(".app")) {
    // Without -n, LaunchServices may focus an isolated profile of this same app.
    await execFileAsync("/usr/bin/open", ["-n", "-a", desktop.appPath], { env });
  } else {
    const child = spawn(desktop.executablePath, [], {
      cwd: path.dirname(desktop.executablePath),
      env,
      detached: true,
      stdio: "ignore"
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  }
  return { ok: true };
}
