// The plugin's small text rules, kept apart from the hooks so the tests can hold each to its words.

/** Trimmed text, or undefined when it is not a string or is blank. */
export function text(raw: unknown): string | undefined {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

/** Why a call was refused, as one line. */
export function why(err: unknown): string {
  const said = (err instanceof Error ? err.message : String(err)).trim()
  return said === '' ? 'no reason given' : said
}

/** One line: a command's output can run over several. */
export const oneLine = (said: string): string => said.replace(/\s*\n\s*/g, ' ')

/** A sentence's end: a full stop, unless it ends in one already, or in another mark. */
export const sentence = (said: string): string => (/[.!?]$/.test(said) ? said : `${said}.`)

/** The model's note when Claude Code refused to run /color: the reason, ending in one full stop. */
export const didntRun = (color: string, reason: string): string => `The prompt bar color change to ${color} you queued didn't run: ${sentence(reason)}`
