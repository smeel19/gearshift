import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isPausedInTranscript } from '../scripts/pause.mjs';

const route = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'route.mjs');
const entry = (args) => JSON.stringify({ type: 'system', subtype: 'local_command', commandRun: { command: 'gear', args, plugin: 'gearshift' } });
const transcript = (...lines) => {
  const p = join(mkdtempSync(join(tmpdir(), 'sar-tr-')), 's.jsonl');
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
};

test('the latest /gear command in the transcript decides', () => {
  assert.equal(isPausedInTranscript(transcript('{"type":"user"}')), false);
  assert.equal(isPausedInTranscript(transcript(entry('off'))), true);
  assert.equal(isPausedInTranscript(transcript(entry('off'), entry('on'))), false);
  assert.equal(isPausedInTranscript(transcript(entry('pause'), entry('status'))), true);
  assert.equal(isPausedInTranscript(transcript(entry('off'), entry('resume'), entry('pause'))), true);
});

test('only system entries count, not quoted or typed text', () => {
  const fake = JSON.stringify({ type: 'user', message: { content: 'commandRun {"command":"gear","args":"off"}' }, commandRun: { command: 'gear', args: 'off' } });
  assert.equal(isPausedInTranscript(transcript(fake)), false);
  assert.equal(isPausedInTranscript(transcript(JSON.stringify({ type: 'system', commandRun: { command: 'other', args: 'off' } }))), false);
});

test('missing, empty or damaged transcripts mean not paused', () => {
  assert.equal(isPausedInTranscript(undefined), false);
  assert.equal(isPausedInTranscript('/nonexistent/file.jsonl'), false);
  assert.equal(isPausedInTranscript(transcript('{"commandRun": broken')), false);
});

const call = (tool_name, tool_input, transcript_path) =>
  spawnSync('node', [route], {
    input: JSON.stringify({ session_id: 's', cwd: tmpdir(), transcript_path, tool_name, tool_input }),
    env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'sar-home-')) },
  }).stdout.toString();

test('router hook leaves subagent calls alone while paused, per transcript', () => {
  const input = { description: 'Find files', prompt: 'Search and list config files' };
  assert.match(call('Agent', input, transcript(entry('on'))), /"model":"haiku"/);
  assert.equal(call('Agent', input, transcript(entry('off'))), '');
  assert.match(call('Agent', input, transcript(entry('off'), entry('on'))), /"model":"haiku"/);
});

test('router hook leaves workflows alone while paused', () => {
  const script = "export const meta = { name: 'x', description: 'y' }\nawait agent('Find files')";
  assert.match(call('Workflow', { script }, transcript()), /updatedInput/);
  assert.equal(call('Workflow', { script }, transcript(entry('off'))), '');
});
