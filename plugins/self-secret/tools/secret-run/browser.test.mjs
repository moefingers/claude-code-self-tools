// How the form opens: the default browser's app window on Windows when that
// is Chrome or Edge and installed, else the platform's own open, as before.
//
// The choice is a pure function (openCommand) of the platform, the
// environment, the default browser's ProgId and which programs are there;
// these tables hold it, each compared whole, with every place looked at and
// whether the ProgId was asked. Windows paths are text here, never Node's
// path, so the tables read the same on Linux, where they run. Nothing here
// starts a browser or reads the registry.
//
//   node --test plugins/self-secret/tools/secret-run/browser.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  HTTP_DEFAULT_KEY,
  REG_QUERY,
  agreedProgId,
  openBrowser,
  openCommand,
} from "./form.mjs";

/** A form's address, made up: what each command is handed. */
const ADDRESS = "http://127.0.0.1:5000/?n=made-up-nonce-for-the-table";

/** The folders as Windows names them, for a user named u. */
const WIN_ENV = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
};

const CHROME_PF = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CHROME_X86 =
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const CHROME_USER =
  "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
const EDGE_X86 =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const EDGE_PF = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe";

/** The app window of the browser at that path. */
const app = (program) => ({
  program,
  args: [`--app=${ADDRESS}`, "--window-size=520,560"],
  hide: false,
});
/** Today's open on Windows: cmd's start, its console hidden. */
const START = { program: "cmd", args: ["/c", "start", "", ADDRESS], hide: true };

/** openCommand for one row, with what it asked: how often the ProgId, and each path looked at, in order. */
function choose({ platform, progId = null, installed = [], env = WIN_ENV }) {
  const asked = { progId: 0, paths: [] };
  const command = openCommand({
    platform,
    env,
    url: ADDRESS,
    progId: () => {
      asked.progId += 1;
      return progId;
    },
    exists: (path) => {
      asked.paths.push(path);
      return installed.includes(path);
    },
  });
  return { command, asked };
}

test("the form opens in the default browser's app window on Windows when that is Chrome or Edge, else as before", () => {
  const rows = [
    [
      "Windows, ChromeHTML, Chrome in Program Files",
      { platform: "win32", progId: "ChromeHTML", installed: [CHROME_PF] },
      { command: app(CHROME_PF), asked: { progId: 1, paths: [CHROME_PF] } },
    ],
    [
      "Windows, ChromeHTML, Chrome in Program Files (x86) alone",
      { platform: "win32", progId: "ChromeHTML", installed: [CHROME_X86] },
      {
        command: app(CHROME_X86),
        asked: { progId: 1, paths: [CHROME_PF, CHROME_X86] },
      },
    ],
    [
      "Windows, ChromeHTML, Chrome installed for the user alone",
      { platform: "win32", progId: "ChromeHTML", installed: [CHROME_USER] },
      {
        command: app(CHROME_USER),
        asked: { progId: 1, paths: [CHROME_PF, CHROME_X86, CHROME_USER] },
      },
    ],
    [
      "Windows, ChromeHTML, Chrome in both Program Files folders: the first",
      {
        platform: "win32",
        progId: "ChromeHTML",
        installed: [CHROME_PF, CHROME_X86],
      },
      { command: app(CHROME_PF), asked: { progId: 1, paths: [CHROME_PF] } },
    ],
    [
      "Windows, MSEdgeHTM, Edge in Program Files (x86)",
      { platform: "win32", progId: "MSEdgeHTM", installed: [EDGE_X86] },
      { command: app(EDGE_X86), asked: { progId: 1, paths: [EDGE_X86] } },
    ],
    [
      "Windows, MSEdgeHTM, Edge in Program Files alone",
      { platform: "win32", progId: "MSEdgeHTM", installed: [EDGE_PF] },
      {
        command: app(EDGE_PF),
        asked: { progId: 1, paths: [EDGE_X86, EDGE_PF] },
      },
    ],
    [
      "Windows, Chrome's ProgId, no Chrome found (Edge is): never another browser",
      { platform: "win32", progId: "ChromeHTML", installed: [EDGE_X86] },
      {
        command: START,
        asked: { progId: 1, paths: [CHROME_PF, CHROME_X86, CHROME_USER] },
      },
    ],
    [
      "Windows, another default (Firefox's ProgId), Chrome installed",
      {
        platform: "win32",
        progId: "FirefoxURL-308046B0AF4A39CB",
        installed: [CHROME_PF, EDGE_X86],
      },
      { command: START, asked: { progId: 1, paths: [] } },
    ],
    [
      "Windows, Chrome's ProgId with a suffix: not the one named",
      {
        platform: "win32",
        progId: "ChromeHTML.ABCDEFGH",
        installed: [CHROME_PF],
      },
      { command: START, asked: { progId: 1, paths: [] } },
    ],
    [
      "Windows, a ProgId that is the name of an object's own property",
      { platform: "win32", progId: "constructor", installed: [CHROME_PF] },
      { command: START, asked: { progId: 1, paths: [] } },
    ],
    [
      "Windows, a read that fails",
      { platform: "win32", progId: null, installed: [CHROME_PF, EDGE_X86] },
      { command: START, asked: { progId: 1, paths: [] } },
    ],
    [
      "Windows, folders not on a drive are passed over, and a trailing backslash is taken off",
      {
        platform: "win32",
        progId: "ChromeHTML",
        installed: [CHROME_USER],
        env: {
          ProgramFiles: "Program Files",
          "ProgramFiles(x86)": "\\\\server\\share",
          LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local\\",
        },
      },
      { command: app(CHROME_USER), asked: { progId: 1, paths: [CHROME_USER] } },
    ],
    [
      "Windows, no folders in the environment",
      {
        platform: "win32",
        progId: "MSEdgeHTM",
        installed: [EDGE_X86],
        env: {},
      },
      { command: START, asked: { progId: 1, paths: [] } },
    ],
    [
      "macOS: open, as before, and no ProgId asked",
      { platform: "darwin", progId: "ChromeHTML", installed: [CHROME_PF] },
      {
        command: { program: "open", args: [ADDRESS], hide: true },
        asked: { progId: 0, paths: [] },
      },
    ],
    [
      "Linux: xdg-open, as before, and no ProgId asked",
      { platform: "linux", progId: "ChromeHTML", installed: [CHROME_PF] },
      {
        command: { program: "xdg-open", args: [ADDRESS], hide: true },
        asked: { progId: 0, paths: [] },
      },
    ],
    [
      "SECRET_PASTE_NO_BROWSER on Windows: nothing opens, nothing is read",
      {
        platform: "win32",
        progId: "ChromeHTML",
        installed: [CHROME_PF],
        env: { ...WIN_ENV, SECRET_PASTE_NO_BROWSER: "1" },
      },
      { command: null, asked: { progId: 0, paths: [] } },
    ],
    [
      "SECRET_PASTE_NO_BROWSER on Linux: nothing opens",
      {
        platform: "linux",
        env: { SECRET_PASTE_NO_BROWSER: "1" },
      },
      { command: null, asked: { progId: 0, paths: [] } },
    ],
  ];
  assert.deepEqual(
    rows.map(([name, input]) => [name, choose(input)]),
    rows.map(([name, , want]) => [name, want]),
  );
});

/** reg query's output for these keys under the http key, each with its one value line, as reg prints them. */
const regOutput = (...entries) =>
  [
    "",
    ...entries.flatMap(([subkey, line]) => [
      `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\${subkey}`,
      line,
      "",
    ]),
    `End of search: ${entries.length} match(es) found.`,
    "",
  ].join("\r\n");

test("reg query's ProgId values name the default only when they agree", () => {
  const rows = [
    [
      "UserChoice alone",
      regOutput(["UserChoice", "    ProgId    REG_SZ    ChromeHTML"]),
      "ChromeHTML",
    ],
    [
      "UserChoice and UserChoiceLatest, agreeing",
      regOutput(
        ["UserChoice", "    ProgId    REG_SZ    MSEdgeHTM"],
        ["UserChoiceLatest", "    ProgId    REG_SZ    MSEdgeHTM"],
      ),
      "MSEdgeHTM",
    ],
    [
      "UserChoice and UserChoiceLatest, differing",
      regOutput(
        ["UserChoice", "    ProgId    REG_SZ    ChromeHTML"],
        ["UserChoiceLatest", "    ProgId    REG_SZ    FirefoxURL-308046B0AF4A39CB"],
      ),
      null,
    ],
    [
      "lines broken by LF alone",
      regOutput(["UserChoice", "    ProgId    REG_SZ    ChromeHTML"]).replace(
        /\r\n/g,
        "\n",
      ),
      "ChromeHTML",
    ],
    [
      "a value of another name is not read",
      regOutput(
        ["UserChoice", "    ProgId    REG_SZ    ChromeHTML"],
        ["Other", "    ProgIdOld    REG_SZ    FirefoxURL-308046B0AF4A39CB"],
      ),
      "ChromeHTML",
    ],
    [
      "a ProgId of another type",
      regOutput(["UserChoice", "    ProgId    REG_EXPAND_SZ    ChromeHTML"]),
      null,
    ],
    [
      "an empty ProgId",
      regOutput(["UserChoice", "    ProgId    REG_SZ    "]),
      null,
    ],
    ["no ProgId at all", regOutput(), null],
    ["no output", "", null],
    ["nothing", undefined, null],
  ];
  assert.deepEqual(
    rows.map(([name, output]) => [name, agreedProgId(output)]),
    rows.map(([name, , want]) => [name, want]),
  );
});

test("the registry is read by one reg.exe call of fixed words, which changes nothing", () => {
  assert.equal(
    HTTP_DEFAULT_KEY,
    "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http",
  );
  assert.deepEqual(REG_QUERY, ["query", HTTP_DEFAULT_KEY, "/s", "/v", "ProgId"]);
  // LOAD-BEARING: held as text, since no test here may run reg.exe. The one
  // process started synchronously is reg.exe, by its System32 path, with
  // those words alone.
  const source = readFileSync(
    fileURLToPath(new URL("./form.mjs", import.meta.url)),
    "utf8",
  );
  assert.equal(source.match(/spawnSync\(/g)?.length, 1, "one spawnSync");
  assert.match(source, /spawnSync\(system32\("reg\.exe"\), REG_QUERY, \{/);
});

test("the open is detached, unwaited for, its output ignored, and hides a console program's window alone", () => {
  // LOAD-BEARING: held as text, since no test here may start a browser.
  const source = openBrowser.toString();
  assert.equal(source.match(/spawn\(/g)?.length, 1, "one spawn");
  assert.match(source, /spawn\(command\.program, command\.args, \{/);
  assert.match(source, /stdio: "ignore",/);
  assert.match(source, /detached: true,/);
  assert.match(source, /windowsHide: command\.hide,/);
  assert.match(source, /child\.unref\(\);/);
  assert.match(source, /if \(!command\) return false;/);
});
