// The one process self-restart starts, and everything it is given: the launcher, version 2, from the
// shared machine code (machine.ts, a copy of shared/hooks/machine.ts, which self-switch shares).
//
// The plugin runs Windows PowerShell by its known path under the Windows folder, with one fixed
// script, launcherScript(<this session's id>), on its standard input under the fixed bootstrap of
// powershellCall (a script on the command line passed Windows' limit on one). The id must be a UUID
// (SESSION_ID) before it gets here: no text from the tool's input reaches the script, the argv or a
// command line.
//
// The script finds the session's own claude.exe above it (a parent counts only while it is older
// than its child), then takes the claim lock on the conversation, with CreateNew, so that a switch
// moving it at the same time can't also resume it. Then one of two things:
// - When the claude.exe runs in a slot (its parent is Windows PowerShell running claude-slot.ps1 with
//   the shipped hash), it leaves the slot a record and opens no window: once the session exits, the
//   slot resumes it in the same pane.
// - Otherwise it opens a new console window with Start-Process. A probe found that `cmd /c start`
//   hands its inheritable handles on, so the plugin's $.process.run, which reads the child's output to
//   its end, would wait out the whole new session; Start-Process doesn't, and its window outlives the
//   session it came from.
// The window waits for the claude.exe to exit, so two copies never write one session (and Remote
// Control, which a second copy leaves off, connects in the new one). Then, right before claude runs,
// it reads the session registry and the process table again and resumes nothing if another process
// holds the conversation by then; checks that the claim lock still names this window; clears the
// markers Claude Code sets in the processes it starts (SESSION_MARKERS: CLAUDE_CODE_CHILD_SESSION among
// them makes a claude nested, and a nested session saves no transcript); and runs
// `claude --resume <id>` from PATH, in the folder the session started in, with no other flag: no
// permission flag of any kind. If the old process is still there after 10 minutes, the window says
// so and resumes nothing.
//
// When Claude Code ends with an error, or within seconds (the resume didn't take), the window shows
// the command to resume by hand and waits for Enter, rather than closing on the message; a resume
// that ran and ended closes as a terminal does. Not -NoExit: that would leave every window at a
// PowerShell prompt after a normal exit.
export {
  CLAIMED,
  encodeCommand,
  FALLBACK,
  LAUNCHED,
  launcherScript,
  powershellPath,
  RELEASED,
  releaseScript,
  SESSION_ID,
  SESSION_MARKERS,
  SHORT_RUN_SECONDS,
  SLOTTED,
  stateFolder,
  SYSTEM_ROOT,
  WAIT_SECONDS,
} from './machine'
