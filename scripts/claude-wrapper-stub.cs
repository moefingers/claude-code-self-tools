// A stub claude.exe for scripts/claude-wrapper.test.mjs and scripts/claude-launch.test.mjs, compiled
// there by Windows PowerShell's Add-Type into a temporary folder. It never runs Claude Code. Each run
// appends one JSON line to %STUB_LOG%: its arguments, its folder, the NAMES of its environment variables
// (never a value), whether CLAUDE_CODE_FORCE_SESSION_PERSISTENCE and
// CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP are "1", whether the wrapper's ticket was still there when it
// started, and the wrapper's pane file. Then, as self-restart or self-switch would, it writes the
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
// %STUB_CHILD_OUT% and %STUB_CHILD_ERR%. The script can so be written once this process is known.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

public static class ClaudeStub {
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

  static void RunChild(string exe) {
    string input = Environment.GetEnvironmentVariable("STUB_CHILD_STDIN");
    string output = Environment.GetEnvironmentVariable("STUB_CHILD_OUT");
    string error = Environment.GetEnvironmentVariable("STUB_CHILD_ERR");
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
    string childExe = Environment.GetEnvironmentVariable("STUB_CHILD_EXE");
    if (!string.IsNullOrEmpty(childExe)) RunChild(childExe);
    string log = Environment.GetEnvironmentVariable("STUB_LOG");
    string plan = Environment.GetEnvironmentVariable("STUB_PLAN");
    string token = Environment.GetEnvironmentVariable("CLAUDE_PANE_TOKEN");
    string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
    string panes = local == null ? null : Path.Combine(local, "claude-self-tools", "panes");
    string ticket = token == null || panes == null ? null : Path.Combine(panes, token + ".next.json");
    string pane = token == null || panes == null ? null : Path.Combine(panes, token + ".json");
    List<string> names = new List<string>();
    foreach (DictionaryEntry e in Environment.GetEnvironmentVariables()) names.Add((string)e.Key);
    names.Sort(StringComparer.OrdinalIgnoreCase);
    int run = File.Exists(log) ? File.ReadAllLines(log).Length + 1 : 1;
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
