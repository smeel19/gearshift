// Per-session pause state for subagent routing.
//
// "/gear off" and "/gear on" are handled by the main-session router, and Claude Code records
// each as a system entry in the session transcript:
//   {"type":"system","subtype":"local_command","commandRun":{"command":"gear","args":"off"}}
// The hook is given the transcript path, so the latest such entry says whether this session
// is paused. No ids or flag files, and nothing carries over to other sessions.

import { readFileSync } from 'node:fs';

const OFF = new Set(['off', 'pause']);
const ON = new Set(['on', 'resume']);

export function isPausedInTranscript(path) {
  if (!path) return false;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  let paused = false;
  for (const line of text.split('\n')) {
    if (!line.includes('"commandRun"')) continue;
    try {
      const e = JSON.parse(line);
      // Only the harness's own system entries count, never text typed or quoted elsewhere.
      if (e.type !== 'system' || e.commandRun?.command !== 'gear') continue;
      const arg = String(e.commandRun.args || '').trim().toLowerCase();
      if (OFF.has(arg)) paused = true;
      else if (ON.has(arg)) paused = false;
    } catch {
      // Partial line at the end of a file still being written: ignore.
    }
  }
  return paused;
}
