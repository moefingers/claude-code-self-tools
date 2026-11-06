// self-check's env dedupe, against real Git Bash: for each case of a corpus, the env script Claude
// Code would build from the files as they are, and from the files as the dedupe leaves them, are run
// in Git Bash the way Claude Code runs them (one `bash -c` string, each file trimmed, the non-empty
// ones joined by a newline, then the command). The variables each run ends with (`declare -p`: the
// value and whether it is exported), what it printed and its exit must be the same. The plugin's own
// tests model the shell; this asks the shell.
//
// Fakes only: FAKE_* variables with low-entropy values built here, in files written to a new folder
// under the system's temp folder and deleted after. Nothing under ~/.claude is read or written.
// Skipped off Windows, and where Git Bash isn't found (CLAUDE_CODE_GIT_BASH_PATH, else
// C:\Program Files\Git\bin\bash.exe).
//
//   node --test scripts/env-guard-bash.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { ROOT } from './sync-shared.mjs'

const rules = await import(pathToFileURL(join(ROOT, 'plugins', 'self-check', 'hooks', 'env-rules.ts')).href)

const BASH = process.env.CLAUDE_CODE_GIT_BASH_PATH || 'C:\\Program Files\\Git\\bin\\bash.exe'
const skip = process.platform !== 'win32' ? 'not Windows' : existsSync(BASH) ? false : `no Git Bash at ${BASH}`

/** The folder the cases' files are written to: new, under the system's temp folder. */
const TEMP = tmpdir()
const DIR = skip === false ? mkdtempSync(join(TEMP, 'env-guard-bash-')) : ''
after(() => {
  if (DIR !== '') rmSync(DIR, { recursive: true, force: true })
})

/** What prints the FAKE_* variables a run ends with, each with its attributes (`-x`: exported). */
const PROBE = 'for v in $(compgen -v FAKE_); do declare -p "$v"; done'

/** The process environment for Git Bash, with no FAKE_* variable of its own. */
const ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('FAKE_')))

/** Runs an env script as Claude Code puts it into a Bash call, then the probe. */
function run(script) {
  const command = script === '' ? `: && ${PROBE}` : `: && ${script}\n: && ${PROBE}`
  assert.ok(command.length < rules.GIT_BASH_LIMIT, `the case is too long for one Bash call (${command.length})`)
  const done = spawnSync(BASH, ['-c', command], { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: ENV })
  assert.equal(done.error, undefined, String(done.error))
  return { status: done.status, stdout: done.stdout, stderr: done.stderr }
}

/** A case's files written under DIR, read back as the plugin reads them, and deduped as the plugin would: rewritten only when shorter. */
function texts(name, files) {
  const folder = join(DIR, name)
  mkdirSync(folder)
  assert.ok(!relative(TEMP, folder).startsWith('..'), 'the case folder is under the temp folder')
  return files.map(([file, text]) => {
    writeFileSync(join(folder, file), text, 'utf8')
    const before = readFileSync(join(folder, file), 'utf8')
    const result = rules.dedupe(before)
    const isRewritten = !('refused' in result) && result.text.length < before.length
    return { before, after: isRewritten ? result.text : before, isRewritten }
  })
}

/** Low-entropy fake values. */
const v = n => 'v'.repeat(n)
/** One session start's appends, as the Vercel plugin appends its own. */
const start = n => `export FAKE_HINTS="${v(n)}"\nexport FAKE_RESOURCES="${v(n + 1)}"\nexport FAKE_MODE="${v(n + 2)}"\n`

/**
 * The corpus: a name, the files in the order Claude Code reads them, and how many of them the
 * dedupe rewrites (so a case can't pass by leaving everything alone).
 */
const CASES = [
  ['starts appended five times', [['sessionstart-hook-1.sh', [3, 4, 5, 6, 7].map(start).join('')]], 1],
  ['single quotes and every escape inside double quotes', [['sessionstart-hook-1.sh', String.raw`export FAKE_Q='a b $c'
export FAKE_Q='a "b" $d'
export FAKE_D="a\"b\\c\$d\e"
export FAKE_D="x\"y\\"
`]], 1],
  ['plain characters, and empty values', [['sessionstart-hook-1.sh', 'export FAKE_W=a@b%c+d=e:f,g./h-i\nexport FAKE_W=j@k\nexport FAKE_Z=\nexport FAKE_Z=""\nexport FAKE_Z=\'\'\n']], 1],
  ['export and declare -x mixed', [['sessionstart-hook-1.sh', 'declare -x FAKE_M=1\nexport FAKE_M=2\ndeclare -x FAKE_M=3\n']], 1],
  ['unexported, then exported', [['sessionstart-hook-1.sh', 'FAKE_U=1\nFAKE_U=2\nexport FAKE_U=3\n']], 1],
  ['unexported only', [['sessionstart-hook-1.sh', 'FAKE_P=1\nFAKE_P=2\n']], 1],
  ['exported, unexported, exported again', [['sessionstart-hook-1.sh', 'export FAKE_E=1\nFAKE_E=2\nexport FAKE_E=3\n']], 1],
  ['exported, then set without export twice: refused', [['sessionstart-hook-1.sh', 'export FAKE_F=1\nFAKE_F=2\nFAKE_F=3\n']], 0],
  ['exported, another variable, then set without export: refused', [['sessionstart-hook-1.sh', 'export FAKE_G=1\nFAKE_H=1\nFAKE_G=2\n']], 0],
  ['comments holding an =', [['sessionstart-hook-1.sh', '# FAKE_C=9\nexport FAKE_C=1\n# FAKE_C=8\nexport FAKE_C=2\n# the end\n']], 1],
  ['CRLF lines', [['sessionstart-hook-1.sh', 'export FAKE_R=1\r\nexport FAKE_R=2\r\n']], 1],
  // The CR the dedupe allows at a line's end: once the comment goes, the kept line is the file's last,
  // and only Git Bash dropping CR from a `-c` string keeps the two runs alike.
  ['CRLF lines before a trailing comment', [['sessionstart-hook-1.sh', 'export FAKE_R=1\r\nexport FAKE_R=2\r\n# a note\r\n']], 1],
  ['a BOM before a comment on line 1', [['sessionstart-hook-1.sh', '\uFEFF# a note\nexport FAKE_B=1\nexport FAKE_B=2\n']], 1],
  ['a BOM before an assignment on line 1: refused', [['sessionstart-hook-1.sh', '\uFEFFexport FAKE_B=1\nexport FAKE_B=2\n']], 0],
  [
    'an empty file, a comment-only one, a newline',
    [['setup-hook-0.sh', ''], ['sessionstart-hook-1.sh', '# only a note\n'], ['sessionstart-hook-2.sh', '\n'], ['sessionstart-hook-3.sh', 'export FAKE_K=1\n']],
    2,
  ],
  ['a no-break space before a trailing comment: refused', [['sessionstart-hook-1.sh', 'export FAKE_N=1\nexport FAKE_N=2\u00A0\n# a note\n']], 0],
  ['a vertical tab before a trailing comment: refused', [['sessionstart-hook-1.sh', 'export FAKE_N=1\nexport FAKE_N=2\v\n# a note\n']], 0],
  ['spaces and tabs before a trailing comment', [['sessionstart-hook-1.sh', 'export FAKE_S=1 \t\nexport FAKE_S=2 \t\n# a note\n']], 1],
  ['non-ASCII text in quotes', [['sessionstart-hook-1.sh', 'export FAKE_V="\u00e9\u00e9 \u00e8"\nexport FAKE_V="\u00e8\u00e8"\n']], 1],
  ['two files that set the same variable', [['sessionstart-hook-1.sh', 'export FAKE_T=1\nexport FAKE_T=2\n'], ['sessionstart-hook-2.sh', 'FAKE_T=3\nFAKE_T=4\n']], 2],
  [
    'a refused file between two deduped ones',
    [
      ['setup-hook-0.sh', 'export FAKE_X=1\nexport FAKE_X=2\n'],
      ['sessionstart-hook-1.sh', 'export FAKE_X=3\necho refused-line\nexport FAKE_X=4\n'],
      ['sessionstart-hook-2.sh', 'export FAKE_Y=1\nexport FAKE_X=5\nexport FAKE_Y=2\n'],
    ],
    2,
  ],
]

for (const [name, files, rewrites] of CASES) {
  test(`Git Bash ends with the same variables: ${name}`, { skip }, () => {
    const read = texts(name.replace(/[^A-Za-z0-9]+/g, '-'), files)
    const before = run(rules.inlinedScript(read.map(f => f.before)))
    const deduped = run(rules.inlinedScript(read.map(f => f.after)))
    assert.match(before.stdout, /declare /, 'the probe printed the variables')
    assert.deepEqual(deduped, before, 'Git Bash ends differently after the dedupe')
    assert.equal(read.filter(f => f.isRewritten).length, rewrites, 'how many files the dedupe rewrites')
  })
}
