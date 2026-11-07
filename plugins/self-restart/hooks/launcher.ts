// The one process self-restart starts, and everything it is given: the shared launcher, launch(), from
// the shared machine code (machine.ts, a copy of shared/hooks/machine.ts, which self-switch shares).
//
// The plugin runs Windows PowerShell by its known path under the Windows folder, with the one script
// launch() builds on its standard input under the fixed bootstrap of powershellCall (a script on the
// command line passed Windows' limit on one). Its inputs are this session's id (a UUID, SESSION_ID),
// the folder it started in, its config folder and the plugins' state folder (each an absolute folder
// without quotes, checked), its own claude.exe by pid and start (from the probe that judged the safe
// point), and a fresh claim (`launch:<uuid>`): no text from the tool's input reaches the script, the
// argv or a command line.
//
// The script finds the session's own claude.exe above it and checks it is the one the probe judged;
// then, in one run, takes the claim lock on the conversation, with CreateNew, so that a switch moving it
// at the same time can't also resume it, and places the restart:
// - this tab, when the session runs right under the claude wrapper (`{ pane }`): a ticket the wrapper
//   resumes it from in the same tab once this process has exited;
// - else this pane's slot (`'auto'`), when the claude.exe runs under a slot runner with the shipped hash
//   and the folder is the conversation's own: a record, and no window;
// - else a new window (Start-Process, Windows PowerShell): `cmd /c start` would hand its inheritable
//   handles on, so the plugin's $.process.run would wait out the whole new session; Start-Process
//   doesn't, and its window outlives the session it came from.
// The window waits for the claude.exe to exit, so two copies never write one session (and Remote
// Control, which a second copy leaves off, connects in the new one). Then, right before claude runs,
// it reads the session registry and the process table again and resumes nothing if another process
// holds the conversation by then; checks that the claim lock still names this window and that the
// folder is there; checks claude-launch.ps1's SHA-256; and runs it. claude-launch.ps1 sets the launch
// environment (Claude Code's markers and NO_COLOR removed: CLAUDE_CODE_CHILD_SESSION among them makes
// a claude nested, and a nested session saves no transcript; transcripts forced on; the REAP setting
// kept on; WT_SESSION and WT_PROFILE_ID untouched) and runs `claude --resume <id>` in the folder the
// session started in, with no other flag: no permission flag of any kind. If the old process is still
// there after 10 minutes, the window says so and resumes nothing.
//
// When Claude Code ends with an error, or within seconds (the resume didn't take), the window shows
// the command to resume by hand and waits for Enter, rather than closing on the message; a resume
// that ran and ended closes as a terminal does. Not -NoExit: that would leave every window at a
// PowerShell prompt after a normal exit. self-restart writes no left record: it resumes its own
// conversation, so there is no return trip to speed up.
export {
  CLAIMED,
  encodeCommand,
  FALLBACK,
  launch,
  LAUNCH_SCRIPT_SHA256,
  launchScriptPath,
  launchScriptText,
  parseLaunch,
  powershellPath,
  RELEASED,
  releaseScript,
  SESSION_ID,
  SESSION_MARKERS,
  SHORT_RUN_SECONDS,
  stateFolder,
  SYSTEM_ROOT,
  WAIT_SECONDS,
} from './machine'
