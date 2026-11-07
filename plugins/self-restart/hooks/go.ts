// This plugin's trampoline: the final command of a restart, through a command of its own whose handler
// checks again when it is dequeued (goStep, in the shared machine code). GO_VIA ships as 'direct'; the
// flip is one commit, after the live checks M17a-d.
import { goStep } from './machine'

export const go = goStep('self-restart-go')
