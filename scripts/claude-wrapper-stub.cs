// A stub claude.exe for scripts/claude-wrapper.test.mjs and scripts/claude-launch.test.mjs, compiled
// there by Windows PowerShell's Add-Type into a temporary folder. It never runs Claude Code. Each run
// appends one JSON line to %STUB_LOG%: its arguments, its folder, the NAMES of its environment variables
// (never a value, but the tab's token below), whether CLAUDE_CODE_FORCE_SESSION_PERSISTENCE and
// CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP are "1", whether the wrapper's ticket was still there when it
// started, the wrapper's pane file, CLAUDE_PANE_TOKEN when it is a lowercase UUID (the claude wrapper's
// token, no secret: it names the pane file), and its parent process: its id, its start (a FILETIME) and
// its program's path, as the probe and the pane file name it; and the ids of the Windows PowerShell
// processes under that same parent (shellSiblings). Then, as self-restart or self-switch would, it writes the
// ticket for its run from %STUB_PLAN%\<run>.json, if there is one, with {TOKEN} replaced by its
// CLAUDE_PANE_TOKEN and "{NOW}", "{OLD}" and "{AHEAD}" by the time now, 200 s ago and 60 s ahead, in
// milliseconds. It sleeps %STUB_SLEEP_MS% and exits with %STUB_EXIT%, when they are set.
//
// For the scripts a plugin runs under its own claude.exe (scripts/launch-live.test.mjs and
// scripts/left-record.test.mjs), before all that: with %STUB_SELF%, it first writes there its process id
// and its creation time, a FILETIME as the probe reads one (`{"pid":..,"created":".."}`); with
// %STUB_CHILD_EXE%, it runs that program with %STUB_CHILD_ARGS% as its own child, as Claude Code runs a
// plugin's script: it waits (up to 30 s) for %STUB_CHILD_STDIN% to be there, hands the child that file's
// bytes on standard input, and writes the child's standard output and error, as UTF-8, to
// %STUB_CHILD_OUT% and %STUB_CHILD_ERR% ({RUN} in either is this run's number). The script can so be
// written once this process is known.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public static class ClaudeStub {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicInfo { public IntPtr ExitStatus; public IntPtr PebBaseAddress; public IntPtr AffinityMask; public IntPtr BasePriority; public IntPtr UniqueProcessId; public IntPtr InheritedFromUniqueProcessId; }

  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref BasicInfo info, int size, out int returned);

  // A process's parent's id; -1 when it can't be read.
  static int ParentId(Process process) {
    try {
      BasicInfo info = new BasicInfo();
      int returned;
      if (NtQueryInformationProcess(process.Handle, 0, ref info, Marshal.SizeOf(info), out returned) != 0) return -1;
      return info.InheritedFromUniqueProcessId.ToInt32();
    } catch { return -1; }
  }

  // The Windows PowerShell processes beside this one, under the same parent, by id: a PowerShell 7 window
  // that loaded a module through Windows PowerShell's compatibility keeps one such child all its life.
  static string ShellSiblings() {
    int parent = ParentId(Process.GetCurrentProcess());
    List<string> found = new List<string>();
    if (parent < 0) return "null";
    foreach (Process p in Process.GetProcessesByName("powershell")) {
      try { if (ParentId(p) == parent) found.Add(p.Id.ToString()); } finally { p.Dispose(); }
    }
    return "[" + string.Join(",", found.ToArray()) + "]";
  }

  // This process's parent, as JSON: its id, its start (a FILETIME, as the probe reads one) and its program's path; null when it can't be read.
  static string Parent() {
    try {
      int parentId = ParentId(Process.GetCurrentProcess());
      if (parentId < 0) return "null";
      using (Process parent = Process.GetProcessById(parentId)) {
        string path = null;
        try { path = parent.MainModule.FileName; } catch { path = null; }
        return "{\"pid\":" + parent.Id + ",\"created\":\"" + parent.StartTime.ToFileTimeUtc() + "\",\"path\":" + Q(path) + "}";
      }
    } catch { return "null"; }
  }

  static string Q(string s) {
    if (s == null) return "null";
    StringBuilder b = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '\\' || c == '"') b.Append('\\').Append(c);
      else if (c < ' ') b.AppendFormat("\\u{0:x4}", (int)c);
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  static void RunChild(string exe, int run) {
    string input = Environment.GetEnvironmentVariable("STUB_CHILD_STDIN");
    string output = (Environment.GetEnvironmentVariable("STUB_CHILD_OUT") ?? "").Replace("{RUN}", run.ToString());
    string error = (Environment.GetEnvironmentVariable("STUB_CHILD_ERR") ?? "").Replace("{RUN}", run.ToString());
    for (int i = 0; i < 600 && !string.IsNullOrEmpty(input) && !File.Exists(input); i++) Thread.Sleep(50);
    ProcessStartInfo info = new ProcessStartInfo(exe, Environment.GetEnvironmentVariable("STUB_CHILD_ARGS") ?? "");
    info.UseShellExecute = false;
    info.CreateNoWindow = true;
    info.RedirectStandardInput = true;
    info.RedirectStandardOutput = true;
    info.RedirectStandardError = true;
    info.StandardOutputEncoding = new UTF8Encoding(false);
    info.StandardErrorEncoding = new UTF8Encoding(false);
    using (Process child = Process.Start(info)) {
      string err = "";
      Thread reader = new Thread(() => { err = child.StandardError.ReadToEnd(); });
      reader.Start();
      byte[] bytes = string.IsNullOrEmpty(input) || !File.Exists(input) ? new byte[0] : File.ReadAllBytes(input);
      child.StandardInput.BaseStream.Write(bytes, 0, bytes.Length);
      child.StandardInput.Close();
      string got = child.StandardOutput.ReadToEnd();
      reader.Join();
      child.WaitForExit();
      if (!string.IsNullOrEmpty(output)) File.WriteAllText(output, got, new UTF8Encoding(false));
      if (!string.IsNullOrEmpty(error)) File.WriteAllText(error, err, new UTF8Encoding(false));
    }
  }

  public static int Main(string[] args) {
    string self = Environment.GetEnvironmentVariable("STUB_SELF");
    if (!string.IsNullOrEmpty(self)) {
      Process me = Process.GetCurrentProcess();
      // Whole, by a move: the test reads it as soon as it is there.
      File.WriteAllText(self + ".tmp", "{\"pid\":" + me.Id + ",\"created\":\"" + me.StartTime.ToFileTimeUtc() + "\"}");
      File.Move(self + ".tmp", self);
    }
    string log = Environment.GetEnvironmentVariable("STUB_LOG");
    int run = File.Exists(log) ? File.ReadAllLines(log).Length + 1 : 1;
    string childExe = Environment.GetEnvironmentVariable("STUB_CHILD_EXE");
    if (!string.IsNullOrEmpty(childExe)) RunChild(childExe, run);
    string plan = Environment.GetEnvironmentVariable("STUB_PLAN");
    string token = Environment.GetEnvironmentVariable("CLAUDE_PANE_TOKEN");
    string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
    string panes = local == null ? null : Path.Combine(local, "claude-self-tools", "panes");
    string ticket = token == null || panes == null ? null : Path.Combine(panes, token + ".next.json");
    string pane = token == null || panes == null ? null : Path.Combine(panes, token + ".json");
    List<string> names = new List<string>();
    foreach (DictionaryEntry e in Environment.GetEnvironmentVariables()) names.Add((string)e.Key);
    names.Sort(StringComparer.OrdinalIgnoreCase);
    StringBuilder line = new StringBuilder("{");
    line.Append("\"run\":" + run);
    line.Append(",\"exe\":" + Q(System.Reflection.Assembly.GetExecutingAssembly().Location));
    line.Append(",\"args\":[" + string.Join(",", Array.ConvertAll(args, new Converter<string, string>(Q))) + "]");
    line.Append(",\"cwd\":" + Q(Environment.CurrentDirectory));
    line.Append(",\"env\":[" + string.Join(",", names.ConvertAll(new Converter<string, string>(Q)).ToArray()) + "]");
    line.Append(",\"forceIsOne\":" + (Environment.GetEnvironmentVariable("CLAUDE_CODE_FORCE_SESSION_PERSISTENCE") == "1" ? "true" : "false"));
    line.Append(",\"reapIsOne\":" + (Environment.GetEnvironmentVariable("CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP") == "1" ? "true" : "false"));
    line.Append(",\"ticketPresent\":" + (ticket != null && File.Exists(ticket) ? "true" : "false"));
    line.Append(",\"pane\":" + (pane != null && File.Exists(pane) ? Q(File.ReadAllText(pane)) : "null"));
    line.Append(",\"token\":" + (token != null && Regex.IsMatch(token, "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$") ? Q(token) : "null"));
    line.Append(",\"parent\":" + Parent());
    line.Append(",\"shellSiblings\":" + ShellSiblings());
    line.Append("}");
    File.AppendAllText(log, line.ToString() + "\n");
    string next = plan == null ? null : Path.Combine(plan, run + ".json");
    if (next != null && File.Exists(next) && ticket != null) {
      long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
      string text = File.ReadAllText(next)
        .Replace("{TOKEN}", token)
        .Replace("\"{NOW}\"", now.ToString())
        .Replace("\"{OLD}\"", (now - 200000).ToString())
        .Replace("\"{AHEAD}\"", (now + 60000).ToString());
      File.WriteAllText(ticket, text);
    }
    string sleep = Environment.GetEnvironmentVariable("STUB_SLEEP_MS");
    if (!string.IsNullOrEmpty(sleep)) Thread.Sleep(int.Parse(sleep));
    string code = Environment.GetEnvironmentVariable("STUB_EXIT");
    return string.IsNullOrEmpty(code) ? 0 : int.Parse(code);
  }
}
