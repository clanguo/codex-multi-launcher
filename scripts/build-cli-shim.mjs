import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WINDOWS_CLI_SHIM } from "../dist-electron/main/cli-windows-shim.js";

if (process.platform === "win32") {
  const output = path.resolve("dist-electron/main/profile-cli.exe");
  const hash = crypto.createHash("sha256").update(WINDOWS_CLI_SHIM).digest("hex");
  if (await fs.readFile(`${output}.sha256`, "utf8").catch(() => "") !== hash || !await fs.stat(output).catch(() => null)) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cli-build-"));
    try {
      const source = path.join(root, "shim.cs");
      const compiled = path.join(root, "shim.exe");
      await fs.writeFile(source, WINDOWS_CLI_SHIM);
      const script = "Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:CODEX_PROFILE_SHIM_SOURCE)) -OutputAssembly $env:CODEX_PROFILE_SHIM_OUTPUT -OutputType ConsoleApplication -ReferencedAssemblies System.Web.Extensions.dll -ErrorAction Stop";
      await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        env: { ...process.env, CODEX_PROFILE_SHIM_SOURCE: source, CODEX_PROFILE_SHIM_OUTPUT: compiled }, windowsHide: true, timeout: 30000
      });
      await fs.copyFile(compiled, output);
      await fs.writeFile(`${output}.sha256`, hash);
    } finally {
      if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("codex-cli-build-")) throw new Error("Unexpected build cleanup path");
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}
