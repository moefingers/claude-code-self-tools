// self-desktop on a real desktop, Windows only, and only in a guarded run: each test opens ONE small window of its own
// (a plain form with a title made at run time, a text box, a password box and a button, shown without taking the
// focus), or a console of its own, points the plugin's own scripts at it, and closes it in a `finally`. The window is
// on the screen for a few seconds, so these run only with SELF_DESKTOP_LIVE=1; elsewhere, and without it, each is
// skipped, saying why. Run with `SELF_DESKTOP_LIVE=1 node --test scripts/desktop-live.test.mjs`.
//
// The tools take no window: these call the plugin's internal scripts with the handle of the window the test opened
// (desktop.ts's Target `window`, gateScript), the way no tool can. The console test runs the tools' own read script
// (ReadOwn) under a process whose console the test made, so it shows what the tool's own route reads.
//
// What each shows is in its name. The checks that nothing moved or took the focus compare the window's own rectangle,
// its activations and its place among the windows before and after; a person using the machine in those seconds can
// change the window in front, and that check then fails for them, not for the plugin.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { ROOT } from './sync-shared.mjs'

const desktop = await import(pathToFileURL(join(ROOT, 'plugins', 'self-desktop', 'hooks', 'desktop.ts')).href)
const isWindows = process.platform === 'win32'
const SKIP = !isWindows
  ? 'self-desktop reads a Windows desktop: Windows only'
  : process.env.SELF_DESKTOP_LIVE !== '1'
    ? 'puts a window on the screen for a few seconds: runs only in a guarded run, with SELF_DESKTOP_LIVE=1'
    : false
const POWERSHELL = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

/** Runs one script as the plugin does (Windows PowerShell, the script on standard input), hidden: its output. */
function runScript(script, ms = 90_000) {
  const call = desktop.powershellCall(POWERSHELL, script)
  const run = spawnSync(call.argv[0], call.argv.slice(1), { input: call.stdin, encoding: 'utf8', windowsHide: true, timeout: ms })
  assert.equal(run.status, 0, `the script failed: ${run.stderr}`)
  return run.stdout
}

const json = text => JSON.parse(text.replace(/^\uFEFF/, '').trim())

/** Whether two rectangles agree to a pixel, edge by edge. */
function near(seen, expected, what) {
  assert.ok(Array.isArray(seen) && seen.length === 4, `${what}: a rectangle was read`)
  for (let i = 0; i < 4; i += 1) assert.ok(Math.abs(seen[i] - expected[i]) <= 1, `${what}: ${JSON.stringify(seen)} is ${JSON.stringify(expected)}`)
}

// ---------------------------------------------------------------------------------------------
// The test's own window.

/** The form, in C#: it shows without taking the focus, counts any activation, and reports itself on standard input's "report". */
const FORM_CS = String.raw`using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public class SelfDesktopTestForm : Form {
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Box box);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  struct Box { public int Left; public int Top; public int Right; public int Bottom; }
  int activations;
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override void OnActivated(EventArgs e) { activations++; base.OnActivated(e); }
  static string Rect(IntPtr window) { Box b; GetWindowRect(window, out b); return "[" + b.Left + "," + b.Top + "," + b.Right + "," + b.Bottom + "]"; }
  string Report() {
    return "{\"rect\":" + Rect(Handle) + ",\"activations\":" + activations + ",\"visible\":" + (IsWindowVisible(Handle) ? "true" : "false") + ",\"minimized\":" + (IsIconic(Handle) ? "true" : "false") + ",\"foreground\":" + GetForegroundWindow().ToInt64() + "}";
  }
  public static void Run(string title, string textName, string textValue, string maskedValue, string buttonName, int red, int green, int blue) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    SelfDesktopTestForm form = new SelfDesktopTestForm();
    form.Text = title;
    form.StartPosition = FormStartPosition.Manual;
    form.Location = new Point(60, 60);
    form.Size = new Size(560, 420);
    form.BackColor = Color.FromArgb(red, green, blue);
    TabControl tabs = new TabControl();
    tabs.Location = new Point(10, 10);
    tabs.Size = new Size(300, 220);
    TabPage one = new TabPage("one");
    TabPage two = new TabPage("two");
    tabs.TabPages.Add(one);
    tabs.TabPages.Add(two);
    TextBox text = new TextBox();
    text.Location = new Point(10, 10);
    text.Width = 200;
    text.AccessibleName = textName;
    text.Text = textValue;
    TextBox masked = new TextBox();
    masked.Location = new Point(10, 50);
    masked.Width = 200;
    masked.UseSystemPasswordChar = true;
    masked.Text = maskedValue;
    Button button = new Button();
    button.Location = new Point(10, 90);
    button.Width = 200;
    button.Text = buttonName;
    button.AccessibleName = buttonName;
    one.Controls.Add(text);
    one.Controls.Add(masked);
    one.Controls.Add(button);
    form.Controls.Add(tabs);
    System.Windows.Forms.Timer limit = new System.Windows.Forms.Timer();
    limit.Interval = 60000;
    limit.Tick += delegate { form.Close(); };
    limit.Start();
    form.Shown += delegate {
      // A window its launcher asked to start hidden is shown again, still without taking the focus: the test's own window.
      if (!IsWindowVisible(form.Handle)) ShowWindow(form.Handle, 4);
      Point probe = form.PointToScreen(new Point(form.ClientSize.Width - 30, form.ClientSize.Height - 30));
      Console.Out.WriteLine("{\"window\":" + form.Handle.ToInt64() + ",\"device\":\"" + Screen.FromHandle(form.Handle).DeviceName.Replace("\\", "\\\\") + "\",\"text\":" + Rect(text.Handle) + ",\"masked\":" + Rect(masked.Handle) + ",\"button\":" + Rect(button.Handle) + ",\"probe\":[" + probe.X + "," + probe.Y + "],\"report\":" + form.Report() + "}");
      Console.Out.Flush();
      Thread reader = new Thread(delegate () {
        string line;
        while ((line = Console.In.ReadLine()) != null) {
          if (line == "report") { string said = (string)form.Invoke(new Func<string>(form.Report)); Console.Out.WriteLine(said); Console.Out.Flush(); }
        }
        try { form.BeginInvoke(new MethodInvoker(form.Close)); } catch (Exception) { }
      });
      reader.IsBackground = true;
      reader.Start();
    };
    Application.Run(form);
  }
}`

/** The lines a stream writes, one at a time, as promises. */
function lineReader(stream) {
  let buffer = ''
  const ready = []
  const waiting = []
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).replace(/\r$/, '')
      buffer = buffer.slice(at + 1)
      if (line.trim() === '') continue
      const next = waiting.shift()
      if (next === undefined) ready.push(line)
      else next(line)
    }
  })
  return (ms = 30_000) =>
    new Promise((resolve, reject) => {
      if (ready.length > 0) return resolve(ready.shift())
      const timer = setTimeout(() => reject(new Error('the test window said nothing in time')), ms)
      waiting.push(line => {
        clearTimeout(timer)
        resolve(line)
      })
    })
}

/**
 * Opens the test's own window for `body`, and closes it in a finally: its standard input ends, which closes the form,
 * and its process is ended if it is still there. Every value it shows is made here, at run time.
 */
async function withWindow(body) {
  const look = {
    title: `self-desktop live ${randomUUID()}`,
    textName: `text ${randomUUID().slice(0, 8)}`,
    textValue: `typed ${randomUUID()}`,
    maskedValue: randomBytes(12).toString('base64url'),
    buttonName: `button ${randomUUID().slice(0, 8)}`,
    color: [randomInt(40, 216), randomInt(40, 216), randomInt(40, 216)],
  }
  const host = [
    "$ErrorActionPreference = 'Stop'",
    desktop.PSMODULEPATH_RESET,
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    '$references = @([System.Windows.Forms.Form].Assembly.Location, [System.Drawing.Point].Assembly.Location, [System.ComponentModel.Component].Assembly.Location)',
    `Add-Type -ReferencedAssemblies $references -TypeDefinition ${desktop.literal(FORM_CS)}`,
    `[SelfDesktopTestForm]::Run(${[look.title, look.textName, look.textValue, look.maskedValue, look.buttonName].map(desktop.literal).join(', ')}, ${look.color.join(', ')})`,
  ].join('\r\n')
  // The script on the command line, so standard input is free for the window's reports.
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', desktop.encodeCommand(host)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderr += chunk
  })
  const next = lineReader(child.stdout)
  try {
    let shown
    try {
      shown = JSON.parse(await next(60_000))
    } catch (error) {
      throw new Error(`the test window didn't open: ${error instanceof Error ? error.message : String(error)} ${stderr}`)
    }
    const report = async () => {
      child.stdin.write('report\n')
      return JSON.parse(await next())
    }
    await body({ look, shown, report })
  } finally {
    child.stdin.end()
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 5000)
      child.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

/** The test's window as the plugin's list finds it, and the list. */
function listed(window) {
  const listing = json(runScript(desktop.listScript(undefined)))
  return { listing, row: listing.windows.find(w => w.window === window), index: listing.windows.findIndex(w => w.window === window) }
}

test('the list finds the test window with its rectangle and its monitor, and gives it no title', { skip: SKIP }, async () => {
  await withWindow(async ({ look, shown }) => {
    const { listing, row } = listed(shown.window)
    assert.ok(row !== undefined, 'the test window is listed')
    assert.equal(row.program.toLowerCase(), 'powershell.exe')
    assert.deepEqual(row.rect, shown.report.rect)
    assert.equal(row.state, 'normal')
    assert.equal(row.terminal, false)
    assert.equal(row.own, false)
    assert.equal(listing.monitors[row.monitor - 1]?.device, shown.device)
    // The drawn frame lies within the window's own rectangle.
    assert.ok(row.frame[0] >= row.rect[0] && row.frame[1] >= row.rect[1] && row.frame[2] <= row.rect[2] && row.frame[3] <= row.rect[3])
    // No title: it is neither a Windows Terminal window nor this session's own; and nothing of its content.
    assert.equal('title' in row, false)
    const answer = desktop.listAnswer(desktop.parseListing(JSON.stringify(listing)))
    for (const shownText of [look.title, look.textName, look.textValue, look.buttonName]) assert.ok(!answer.includes(shownText), `the list doesn't hold ${shownText}`)
  })
})

test('the tree holds the text box and the button with their names and bounds, and the password box without its value', { skip: SKIP }, async () => {
  await withWindow(async ({ look, shown }) => {
    const out = runScript(desktop.readScript({ window: shown.window }))
    // No control's value is read: neither what the text box holds nor what the password box holds is anywhere in it.
    assert.ok(!out.includes(look.textValue), "the text box's value isn't read")
    assert.ok(!out.includes(look.maskedValue), "the password box's value isn't read")
    const read = json(out)
    assert.equal(read.window.kind, 'app')
    const nodes = read.tree.nodes
    const text = nodes.find(n => n.name === look.textName)
    assert.equal(text?.role, 'Edit')
    near(text.rect, shown.text, 'the text box')
    const button = nodes.find(n => n.name === look.buttonName)
    assert.equal(button?.role, 'Button')
    near(button.rect, shown.button, 'the button')
    const masked = nodes.filter(n => n.password === true)
    assert.equal(masked.length, 1, 'one password field')
    assert.equal(masked[0].name, undefined, 'a password field shows no name')
    near(masked[0].rect, shown.masked, 'the password box')
    // Each element carries a reference: its runtime id.
    for (const n of nodes) assert.match(n.ref, /^-?\d+(?:\.-?\d+)*$/)
  })
})

test("the capture is a PNG of the window's drawn size, holding the window's own pixels", { skip: SKIP }, async () => {
  await withWindow(async ({ look, shown }) => {
    const dir = mkdtempSync(join(tmpdir(), 'self-desktop-capture-'))
    try {
      const name = `capture-${randomUUID()}.png`
      const shot = json(runScript(desktop.captureScript({ window: shown.window }, { folder: dir, name })))
      assert.equal(shot.capture.file, join(dir, name))
      const { row } = listed(shown.window)
      const width = row.frame[2] - row.frame[0]
      const height = row.frame[3] - row.frame[1]
      assert.equal(shot.capture.width, width)
      assert.equal(shot.capture.height, height)
      // The file's own size, and the colour at a point of the form's own background.
      const x = shown.probe[0] - row.frame[0]
      const y = shown.probe[1] - row.frame[1]
      const seen = runScript(
        [
          'Add-Type -AssemblyName System.Drawing',
          `$picture = New-Object System.Drawing.Bitmap ${desktop.literal(shot.capture.file)}`,
          `try { $c = $picture.GetPixel(${x}, ${y}); [Console]::Out.Write([string]$picture.Width + ' ' + [string]$picture.Height + ' ' + [string]$c.R + ' ' + [string]$c.G + ' ' + [string]$c.B) } finally { $picture.Dispose() }`,
        ].join('\r\n'),
      )
      assert.equal(seen, `${width} ${height} ${look.color.join(' ')}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test("nothing moved, focused or closed the window: its rectangle, its activations and its place among the windows are the same after a read, a capture and the structure rule", { skip: SKIP }, async () => {
  await withWindow(async ({ shown, report }) => {
    const before = await report()
    const placeBefore = listed(shown.window).index
    const dir = mkdtempSync(join(tmpdir(), 'self-desktop-still-'))
    try {
      runScript(desktop.readScript({ window: shown.window }))
      runScript(desktop.captureScript({ window: shown.window }, { folder: dir, name: `capture-${randomUUID()}.png` }))
      runScript(desktop.gateScript(shown.window))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const after = await report()
    assert.deepEqual(after.rect, before.rect)
    assert.equal(after.activations, 0, 'the window was never activated')
    assert.equal(after.visible, true)
    assert.equal(after.minimized, false)
    assert.equal(after.foreground, before.foreground, 'the window in front is the same')
    assert.equal(listed(shown.window).index, placeBefore, 'its place among the windows is the same')
  })
})

test("the own-window capture refuses a window with more than one tab: the structure rule, on a window the test built", { skip: SKIP }, async () => {
  await withWindow(async ({ shown }) => {
    const gate = json(runScript(desktop.gateScript(shown.window)))
    // The test window's tab control has two tabs, and no terminal control: not one tab with one pane.
    assert.deepEqual(gate.shape, { tabs: 2, panes: 0 })
    assert.equal(gate.onePane, false)
    const said = desktop.captureAnswer({
      dpiAware: true,
      own: { found: true, window: shown.window, kind: 'terminal', program: 'WindowsTerminal.exe', title: '' },
      capture: { kind: 'shape', changed: false, tabs: gate.shape.tabs, panes: gate.shape.panes },
    })
    assert.match(said, /^Captured nothing: .* it has 2 tabs\. A picture could show another session's pane/)
  })
})

// ---------------------------------------------------------------------------------------------
// A console of the test's own.

/** The test's own console, written to by the test alone: the characters, and the alternate screen switched on and off. */
const CONSOLE_CS = String.raw`using System;
using System.Runtime.InteropServices;

public static class SelfDesktopTestConsole {
  [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList(uint[] ids, uint count);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool WriteConsoleW(IntPtr output, string text, uint length, out uint written, IntPtr reserved);
  [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr handle, out uint mode);
  [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr handle, uint mode);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Clients() { uint[] ids = new uint[16]; return (int)GetConsoleProcessList(ids, 16); }
  public static bool Write(string text) {
    IntPtr output = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (output == new IntPtr(-1)) return false;
    try {
      uint mode;
      if (GetConsoleMode(output, out mode)) SetConsoleMode(output, mode | 4);
      uint written;
      return WriteConsoleW(output, text, (uint)text.Length, out written, IntPtr.Zero);
    } finally {
      CloseHandle(output);
    }
  }
}`

/** A process id no process has, which the console's own process puts its id in place of. */
const STAND_IN = 4000000001

test("this session's own pane is read from its own console: the characters that show, and the alternate screen while it is up", { skip: SKIP }, () => {
  const main = `main screen ${randomUUID()}`
  const alternate = `alternate screen ${randomUUID()}`
  const read = desktop.readScript({ own: STAND_IN })
  assert.ok(read.includes(`[SelfDesktop]::ReadOwn([uint32]${STAND_IN}, $deny)`))
  const bootstrap = desktop.encodeCommand(desktop.STDIN_BOOTSTRAP)
  const owner = [
    "$ErrorActionPreference = 'Stop'",
    desktop.PSMODULEPATH_RESET,
    `Add-Type -TypeDefinition ${desktop.literal(CONSOLE_CS)}`,
    // Only a console no other process is attached to is written to: this process's own, made for it hidden.
    `if ([SelfDesktopTestConsole]::Clients() -ne 1) { [Console]::Out.Write('{"refused":"this process shares its console with another, so nothing was written to it"}'); return }`,
    `$read = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(read, 'utf8').toString('base64')}')).Replace('[uint32]${STAND_IN},', '[uint32]' + $PID + ',')`,
    'function Read-Own {',
    '  $start = New-Object System.Diagnostics.ProcessStartInfo',
    `  $start.FileName = ${desktop.literal(POWERSHELL)}`,
    `  $start.Arguments = '-NoProfile -NonInteractive -EncodedCommand ${bootstrap}'`,
    '  $start.UseShellExecute = $false',
    '  $start.CreateNoWindow = $false',
    '  $start.RedirectStandardInput = $true',
    '  $start.RedirectStandardOutput = $true',
    '  $child = [System.Diagnostics.Process]::Start($start)',
    '  $bytes = (New-Object System.Text.UTF8Encoding $false).GetBytes($read)',
    '  $child.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)',
    '  $child.StandardInput.Close()',
    '  $out = $child.StandardOutput.ReadToEnd()',
    '  $child.WaitForExit()',
    '  return $out',
    '}',
    '$escape = [string][char]27',
    `[void][SelfDesktopTestConsole]::Write($escape + '[2J' + $escape + '[H' + ${desktop.literal(main)})`,
    '$onMain = Read-Own',
    `[void][SelfDesktopTestConsole]::Write($escape + '[?1049h' + $escape + '[2J' + $escape + '[H' + ${desktop.literal(alternate)})`,
    '$onAlternate = Read-Own',
    "[void][SelfDesktopTestConsole]::Write($escape + '[?1049l')",
    '$back = Read-Own',
    `[Console]::Out.Write('{"main":' + $onMain + ',"alternate":' + $onAlternate + ',"back":' + $back + '}')`,
  ].join('\r\n')
  const seen = json(runScript(owner, 180_000))
  assert.equal(seen.refused, undefined, seen.refused)
  const lines = reading => (Array.isArray(reading.pane?.lines) ? reading.pane.lines : assert.fail(`the pane wasn't read: ${JSON.stringify(reading.pane)}`))
  assert.ok(lines(seen.main).includes(main), 'the main screen is read')
  assert.ok(lines(seen.alternate).includes(alternate), 'the alternate screen is read while it is up')
  assert.ok(!lines(seen.alternate).includes(main), "the main screen isn't, meanwhile")
  assert.ok(lines(seen.back).includes(main), 'the main screen is read again once the alternate is gone')
  // A console made hidden has no window, so no window of its own is named; or a hidden classic console's own.
  assert.ok(seen.main.own.why !== undefined || seen.main.own.kind === 'console', JSON.stringify(seen.main.own))
})
