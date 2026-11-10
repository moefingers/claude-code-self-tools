// self-secret: a session runs a command with a secret that the person pastes at this machine and the
// session never sees. The command is secret-run (tools/secret-run.mjs; the README is the whole account):
// a form on 127.0.0.1 in the person's browser, a check before anything runs, the value handed to the
// one command in its variable and masked in everything it prints, and holds for later commands.
//
// The plugin runs none of it. It keeps a stable copy of the command in the state folder (the shim,
// secret-run.mjs, written at each session start and before each answer, naming the copy this load of
// the plugin carries), and its one tool hands the session the exact line to run through Bash, where the
// person's permission rules and the transcript see it. No value passes through the plugin: it reads no
// secret and no variable but the five that place the state folder (and the update check's own), starts
// no process, and its answers hold only paths, the words the session gave, and fixed text.
import type { EngineInterface, Register } from 'claude-code'
import { askedOf, BASH_TIMEOUT_MS, bashLine, inFolder, powershellLine, PROFILES_NAME, SHIM_NAME, shimText, stateFolder } from './shim'
import type { Asked } from './shim'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const TOOL = 'mcp__self-secret__secret_run_command'

const DESCRIPTION = [
  'Gives the exact command line that runs a command with a secret (an API key, a token, a password) the person pastes at this machine, which you never see: secret-run, the local paste.',
  'Call it when a command needs a secret you do not have and must not see. Never ask the person to paste a secret into the chat, and never put one in a command yourself.',
  `Run the line it returns with the Bash tool, in the foreground, with timeout ${BASH_TIMEOUT_MS}: it opens a form in the person's browser on this machine, checks the value before anything runs, hands it to the command in an environment variable, and masks it in everything the command prints.`,
  'Tell the person first what to paste and why: the form shows only its title and prompt.',
  'profile: one of the person\'s profiles (mode list shows them) or generic, which takes options --prompt <text> and one of --check-url <url>, --check-cmd <shell command> or --no-check, and gives the value in SECRET unless --env-var names another variable.',
  'mode hold keeps the value in memory for up to 120 minutes, so later commands run with mode use-hold without another paste; end-hold ends it, hold-status lists the holds.',
  'It runs nothing itself, and its answer never holds a value.',
].join(' ')

const SUBAGENT =
  "A subagent doesn't ask for secrets: the person pastes at the main session's request, and should know which session asks. Finish your piece and return your result, saying which command needs which secret; the main session asks for it."

/** Where the plugin's files go on this machine: the state folder, the shim and profiles file in it, and the plugin's own copy of the command. */
type Where = { isWindows: boolean; shim: string; profiles: string; target: string }

/** The state folder, from the engine's environment, by the rule tools/secret-run/where.mjs keeps; or why there is none. */
async function where($: EngineInterface): Promise<Where | { refusal: string }> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const env = {
    SELF_SECRET_HOME: await $.env.get('SELF_SECRET_HOME'),
    LOCALAPPDATA: isWindows ? await $.env.get('LOCALAPPDATA') : undefined,
    XDG_STATE_HOME: isWindows ? undefined : await $.env.get('XDG_STATE_HOME'),
    HOME: isWindows ? undefined : await $.env.get('HOME'),
  }
  const state = stateFolder(env, isWindows)
  if (state === undefined) {
    return { refusal: isWindows ? 'self-secret: %LOCALAPPDATA% is not set, so there is no state folder for secret-run.' : 'self-secret: $HOME is not set, so there is no state folder for secret-run.' }
  }
  const tools = inFolder($.plugin.root, 'tools', isWindows)
  return { isWindows, shim: inFolder(state, SHIM_NAME, isWindows), profiles: inFolder(state, PROFILES_NAME, isWindows), target: inFolder(tools, 'secret-run.mjs', isWindows) }
}

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim().slice(0, 300)

/** Writes the shim unless it already names this copy. Says why when it can't. */
async function placeShim($: EngineInterface, at: Where): Promise<{ isPlaced: true } | { isPlaced: false; why: string }> {
  const text = shimText(at.target)
  const now = await $.fs.read(at.shim).catch(() => undefined)
  if (now === text) return { isPlaced: true }
  try {
    await $.fs.write(at.shim, text)
    return { isPlaced: true }
  } catch (err) {
    return { isPlaced: false, why: why(err) }
  }
}

/** What each mode does, after the lines. */
function whatHappens(asked: Asked): string {
  const after =
    'Exit 1: nothing ran (cancelled, timed out, or no hold). Exit 64: a usage mistake, said on stderr; nothing ran. Otherwise the exit code is the command\'s own.'
  switch (asked.mode) {
    case 'once':
    case 'hold': {
      const held =
        asked.mode === 'hold'
          ? ` Once it passes, the value stays held in memory for ${asked.minutes} ${asked.minutes === 1 ? 'minute' : 'minutes'}: later commands for ${asked.profile} run with mode use-hold, without another paste, until it ends (end-hold ends it sooner).`
          : ''
      return `It opens a form in the person's browser on this machine and waits for the paste: 300 seconds, unless --timeout <seconds> says otherwise. Tell the person first what to paste and why: the form shows only its title and prompt. The value is checked before anything runs, handed to the command in its variable, and masked as [redacted] in everything the command prints; you never see it.${held} ${after}`
    }
    case 'use-hold':
      return `It runs the command through the live hold for ${asked.profile}: no form, no paste. ${after}`
    case 'end-hold':
      return `It ends the hold for ${asked.profile} at once; a command still running through it finishes.`
    case 'hold-status':
      return 'It lists the live holds: each profile, the time left and its uses by command name. Never a value.'
    case 'list':
      return 'It lists the profiles (each name, its variable and its title) and the file they come from; generic is built in. Never a value.'
  }
}

/** The tool's answer: the lines, where they come from, and what happens. */
function answer(asked: Asked, at: Where, shim: { isPlaced: true } | { isPlaced: false; why: string }): string {
  const program = shim.isPlaced ? at.shim : at.target
  const waits = asked.mode === 'once' || asked.mode === 'hold'
  const how = waits ? `Run it with the Bash tool, in the foreground, with timeout ${BASH_TIMEOUT_MS}:` : 'Run it with the Bash tool:'
  const stale = shim.isPlaced
    ? ''
    : `\n\n(The stable copy at ${at.shim} couldn't be written: ${shim.why}. These lines name the plugin's own copy, whose path changes with its version.)`
  return [
    how,
    '',
    bashLine(program, asked.args, at.isWindows),
    '',
    `From PowerShell 7.3 or later: ${powershellLine(program, asked.args)}`,
    '',
    whatHappens(asked),
    '',
    `The person's profiles are in ${at.profiles} (mode list shows them); generic is built in.${stale}`,
  ].join('\n')
}

export const register: Register = (on, options) => {
  configureUpdateCheck('self-secret', options)

  // First, so it is outermost on this plugin's tools: it sees each answer, and adds the update
  // notice when one is due. It never waits on the check; see update-check.ts.
  on('tool.call', { tool: /^mcp__self-secret__/ }, async ($, e, next) => withUpdateNotice($, e, await next(e))).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'secret_run_command',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['once', 'hold', 'use-hold', 'end-hold', 'hold-status', 'list'],
            description:
              'once (the default): one paste, one command. hold: one paste, then the value stays held for `minutes`, the first command running at once. use-hold: a command through the live hold, no paste. end-hold: end the hold now. hold-status: list the holds. list: list the profiles.',
          },
          profile: {
            type: 'string',
            description: "For once, hold, use-hold and end-hold: a profile of the person's (mode list shows them), or generic, whose prompt and check come from `options`. A hold is for a named profile, never generic.",
          },
          minutes: { type: 'number', description: 'For mode hold: how long the value stays held, more than 0 and at most 120.' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description:
              'More options for secret-run, one word each, before the command. For generic: --prompt <text>, and one of --check-url <https url> (with --check-header "Authorization: Bearer {value}" and --check-status <code> as it needs), --check-cmd <shell command that reads the value on stdin> or --no-check; and as it fits --shape <regex> --shape-says <words>, --url <https page where the key is made>, --env-var <NAME> (SECRET by default), --spaces-inside. For any: --redact <regex>, --timeout <seconds>, --profiles <file>.',
          },
          command: {
            type: 'array',
            items: { type: 'string' },
            description: 'For once, hold and use-hold: the command to run with the secret, one word each, as its argv (no shell): ["gh", "secret", "set", "NAME"]. It reads the secret from its variable.',
          },
        },
        additionalProperties: false,
      },
      isDeferred: false,
    })
    loadUpdateCheck($)
    const at = await where($).catch(() => undefined)
    if (at !== undefined && !('refusal' in at)) {
      const shim = await placeShim($, at)
      if (!shim.isPlaced) $.ui.log(`self-secret: couldn't write ${at.shim}: ${shim.why}`, { to: 'debug' })
    }
    return started
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const asked = askedOf(e as unknown as Readonly<Record<string, unknown>>)
    if ('refusal' in asked) return { deny: asked.refusal }
    const at = await where($)
    if ('refusal' in at) return { deny: at.refusal }
    return { result: answer(asked, at, await placeShim($, at)) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-secret: working out the command line failed; nothing ran.' }))
}
