// Where secret-run keeps what is the person's own: one folder, the state folder, which holds the
// profiles file (secret-profiles.json), the holds (secret-run/holds/) and the stable copy of the
// command the self-secret plugin writes (secret-run.mjs). It is the folder the self-tools plugins keep
// their state in, so it stays where it is across the plugin's updates:
//
//   SELF_SECRET_HOME, when it is set (tests, or a person who keeps them elsewhere);
//   on Windows, %LOCALAPPDATA%\claude-self-tools;
//   elsewhere, $XDG_STATE_HOME/claude-self-tools when that is an absolute path, else
//   ~/.local/state/claude-self-tools.
//
// The plugin works the folder out by the same rule (hooks/shim.ts, from the engine's environment);
// invocation.test.mjs holds the two together.
//
// What is in it decides where a paste goes (a profile's check) and what runs (a check's command), so
// secret-run uses the folder, and a profiles file, only when no other account can change them
// (trustRefusal): on POSIX, owned by this user (or root) and writable by neither its group nor others,
// as OpenSSH holds its own files; on Windows, owned by this user (or SYSTEM, or Administrators, which
// control the machine already), and writable by no other account.

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

/** The profiles file's name, in the state folder. */
export const PROFILES_NAME = "secret-profiles.json";

/** A path as Git Bash writes it (/c/Users/...) in the form Node's file APIs read. */
export function nativePath(p, platform = process.platform) {
  if (platform === "win32") {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (m) return `${m[1].toUpperCase()}:${m[2] ?? "/"}`;
  }
  return p;
}

/**
 * The state folder, or null when the rule finds none (Windows without
 * %LOCALAPPDATA%). Pure: it reads only what it is given.
 */
export function stateFolder(
  env = process.env,
  platform = process.platform,
  home = homedir(),
) {
  if (env.SELF_SECRET_HOME) return nativePath(env.SELF_SECRET_HOME, platform);
  if (platform === "win32")
    return env.LOCALAPPDATA
      ? win32.join(env.LOCALAPPDATA, "claude-self-tools")
      : null;
  const base = env.XDG_STATE_HOME?.startsWith("/")
    ? env.XDG_STATE_HOME
    : posix.join(home, ".local", "state");
  return posix.join(base, "claude-self-tools");
}

/**
 * A Windows tool by its own path: on PATH, Git Bash's coreutils come
 * first, and its whoami is not Windows' whoami.
 */
export const system32 = (exe) =>
  join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);

/** The accounts that control a Windows machine already: SYSTEM, and the Administrators group. */
const MACHINE = new Set(["S-1-5-18", "S-1-5-32-544"]);
/** Grants that stand for a file's owner, never another account: CREATOR OWNER and OWNER RIGHTS. */
const OWNER_STANDINS = new Set(["S-1-3-0", "S-1-3-4"]);

/**
 * Why a file or folder can't be trusted as the person's own, from what is
 * known of it, or null when no other account can change it. On POSIX facts
 * is { uid, mode } and me this user's uid: refused when another user than
 * this one or root owns it, or its group or others can write it. On Windows
 * facts is { owner, writers } (security identifiers: its owner, and each
 * account an allow grant lets write it) and me this user's: refused when
 * another account than this one, SYSTEM or Administrators owns it, or any
 * other can write it. Pure.
 */
export function untrusted(facts, me, platform = process.platform) {
  if (platform === "win32") {
    if (facts.owner !== me && !MACHINE.has(facts.owner))
      return `it is owned by ${facts.owner}, not by you (${me})`;
    const others = [
      ...new Set(
        facts.writers.filter(
          (sid) => sid !== me && !MACHINE.has(sid) && !OWNER_STANDINS.has(sid),
        ),
      ),
    ];
    return others.length ? `${others.join(", ")} can write it` : null;
  }
  if (facts.uid !== me && facts.uid !== 0)
    return `it belongs to uid ${facts.uid}, not to you (uid ${me})`;
  const open = facts.mode & 0o022;
  if (!open) return null;
  const who =
    open === 0o022
      ? "its group and others"
      : open === 0o020
        ? "its group"
        : "others";
  return `${who} can write it (mode ${(facts.mode & 0o7777).toString(8).padStart(4, "0")}; chmod go-w makes it yours alone)`;
}

/**
 * The one Windows PowerShell call that reads, for each path in
 * SECRET_RUN_TRUST_PATHS, its owner and the accounts an allow grant that
 * applies to it lets write it (write data, append, write attributes, delete
 * a child, delete, change its permissions or owner, or the generic write and
 * all), by security identifier; and first this user's own. .NET alone, no
 * module: a Windows PowerShell started from PowerShell 7 can't load its own
 * modules through the PSModulePath it inherits.
 */
const ACL_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.SecurityIdentifier]
'me' + [char]9 + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($p in ($env:SECRET_RUN_TRUST_PATHS -split [char]10)) {
  try {
    if ([IO.Directory]::Exists($p)) { $acl = [IO.Directory]::GetAccessControl($p) }
    elseif ([IO.File]::Exists($p)) { $acl = [IO.File]::GetAccessControl($p) }
    else { 'missing'; continue }
    $writers = @()
    foreach ($r in $acl.GetAccessRules($true, $true, $sid)) {
      if ([int]$r.AccessControlType -ne 0) { continue }
      if (([int]$r.PropagationFlags -band 2) -ne 0) { continue }
      if (([int64]$r.FileSystemRights -band 0x500D0156) -ne 0) { $writers += $r.IdentityReference.Value }
    }
    'ok' + [char]9 + $acl.GetOwner($sid).Value + [char]9 + ($writers -join ',')
  } catch {
    'error' + [char]9 + ($_.Exception.Message -replace '\s+', ' ')
  }
}`;

/**
 * Each path's owner and writers on Windows, by ACL_SCRIPT: { me, facts },
 * facts in the paths' order, each { owner, writers }, { missing: true } or
 * { error }. Throws when Windows PowerShell gives no answer.
 */
export function windowsAcl(paths) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^psmodulepath$/i.test(k)),
  );
  const r = spawnSync(
    system32(join("WindowsPowerShell", "v1.0", "powershell.exe")),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(ACL_SCRIPT, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
      env: { ...env, SECRET_RUN_TRUST_PATHS: paths.join("\n") },
    },
  );
  const lines = (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
  const me = /^me\t(S-1-[\d-]+)$/.exec(lines[0] ?? "")?.[1];
  if (r.status !== 0 || !me || lines.length !== paths.length + 1)
    throw new Error(
      `Windows PowerShell didn't say (${r.error?.code ?? `exit ${r.status}`}${r.stderr ? `: ${r.stderr.replace(/\s+/g, " ").trim().slice(0, 200)}` : ""})`,
    );
  const facts = lines.slice(1).map((line) => {
    const [kind, a = "", b = ""] = line.split("\t");
    if (kind === "missing") return { missing: true };
    if (kind === "ok") return { owner: a, writers: b ? b.split(",") : [] };
    return { error: a || line };
  });
  return { me, facts };
}

/**
 * Why secret-run won't use these, or null: entries is [{ path, what }],
 * what naming each ("the state folder"). Each that exists must be the
 * person's own to change (untrusted); one that doesn't exist holds nothing
 * yet. io gives the facts: { platform, stat, uid } on POSIX (stat as
 * statSync), { platform, acl } on Windows (acl as windowsAcl); a test gives
 * its own.
 */
export function trustRefusal(
  entries,
  {
    platform = process.platform,
    stat = statSync,
    uid = process.getuid?.(),
    acl = windowsAcl,
  } = {},
) {
  const refuse = ({ path, what }, why) =>
    `secret-run won't use ${what} ${path}: ${why}. The state folder and the profiles file must be yours alone to change (the self-secret README, Profiles).`;
  if (platform !== "win32") {
    for (const entry of entries) {
      let s;
      try {
        s = stat(entry.path);
      } catch (err) {
        if (err.code === "ENOENT") continue;
        return refuse(
          entry,
          `it couldn't be looked at (${err.code ?? err.message})`,
        );
      }
      const why = untrusted({ uid: s.uid, mode: s.mode }, uid, platform);
      if (why) return refuse(entry, why);
    }
    return null;
  }
  let read;
  try {
    read = acl(entries.map((e) => e.path));
  } catch (err) {
    return refuse(entries[0], `who owns it couldn't be read: ${err.message}`);
  }
  for (const [i, entry] of entries.entries()) {
    const facts = read.facts[i];
    if (facts?.missing) continue;
    if (!facts || facts.error !== undefined)
      return refuse(
        entry,
        `who owns it couldn't be read (${facts?.error ?? "no answer"})`,
      );
    const why = untrusted(facts, read.me, platform);
    if (why) return refuse(entry, why);
  }
  return null;
}

/** The paths found the person's own in this process: each is looked at once. */
const trusted = new Set();

/** Throws, saying why, unless each entry that exists is the person's own to change (trustRefusal). */
export function assertOwn(entries) {
  const left = entries.filter((e) => !trusted.has(e.path));
  if (!left.length) return;
  // Nothing there holds nothing yet, and costs Windows no PowerShell.
  if (!left.some((e) => existsSync(e.path))) return;
  const why = trustRefusal(left);
  if (why) throw new Error(why);
  for (const e of left) trusted.add(e.path);
}
