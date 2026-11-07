// A console executable, rather than a .cmd, is accepted by exec/spawn callers.
// Arguments never pass through cmd.exe, including JSON and protocol flags.
export const WINDOWS_CLI_SHIM = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

public static class CodexProfileCli {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long processTime, jobTime;
    public uint flags;
    public UIntPtr minimumWorkingSet, maximumWorkingSet;
    public uint activeProcessLimit;
    public UIntPtr affinity;
    public uint priorityClass, schedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits basic;
    public IoCounters io;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int info, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static string Quote(string value) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); }
      else { result.Append('\\', slashes); result.Append(c); }
      slashes = 0;
    }
    result.Append('\\', slashes * 2); result.Append('"');
    return result.ToString();
  }
  static IntPtr CleanupJob() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("Could not create the CLI cleanup job.");
    var limits = new ExtendedLimits();
    limits.basic.flags = 0x2000;
    bool inJob;
    using (var current = Process.GetCurrentProcess()) {
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)) || !AssignProcessToJobObject(job, current.Handle)) {
        CloseHandle(job);
        if (IsProcessInJob(current.Handle, IntPtr.Zero, out inJob) && inJob) return IntPtr.Zero;
        throw new Exception("Could not establish CLI process cleanup.");
      }
    }
    return job;
  }
  public static int Main(string[] args) {
    IntPtr job = IntPtr.Zero;
    try {
      string manifestPath = Assembly.GetExecutingAssembly().Location + ".json";
      var manifest = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(manifestPath, Encoding.UTF8));
      job = CleanupJob();
      var arguments = new List<string>();
      arguments.Add(Quote((string)manifest["runnerPath"]));
      arguments.Add(Quote(manifestPath));
      foreach (string arg in args) arguments.Add(Quote(arg));
      var start = new ProcessStartInfo((string)manifest["runtimeExecutable"], String.Join(" ", arguments));
      start.UseShellExecute = false;
      start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
      start.EnvironmentVariables.Remove("NODE_OPTIONS");
      Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; };
      using (var child = Process.Start(start)) {
        child.WaitForExit();
        int result = child.ExitCode;
        // End remaining tool descendants as well; preserve the CLI exit code.
        if (job != IntPtr.Zero) TerminateJobObject(job, unchecked((uint)result));
        return result;
      }
    } catch (Exception error) {
      Console.Error.WriteLine("Codex profile CLI: " + error.Message);
      return 1;
    } finally { if (job != IntPtr.Zero) CloseHandle(job); }
  }
}
`;
