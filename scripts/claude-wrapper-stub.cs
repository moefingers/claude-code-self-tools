// A stub claude.exe for scripts/claude-wrapper.test.mjs, compiled there by Windows PowerShell's
// Add-Type into a temporary folder. It never runs Claude Code. Each run appends one JSON line to
// %STUB_LOG%: its arguments, its folder, the NAMES of its environment variables (never a value), whether
// CLAUDE_CODE_FORCE_SESSION_PERSISTENCE is "1", whether the wrapper's ticket was still there when it
// started, and the wrapper's pane file. Then, as self-restart or self-switch would, it writes the
// ticket for its run from %STUB_PLAN%\<run>.json, if there is one, with {TOKEN} replaced by its
// CLAUDE_PANE_TOKEN and "{NOW}", "{OLD}" and "{AHEAD}" by the time now, 200 s ago and 60 s ahead, in
// milliseconds. It sleeps %STUB_SLEEP_MS% and exits with %STUB_EXIT%, when they are set.
using System;
using System.Collections;
using System.Collections.Generic;
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

  public static int Main(string[] args) {
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
