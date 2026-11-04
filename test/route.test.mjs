import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from '../scripts/classify.mjs';
import { decide } from '../scripts/route.mjs';

const tier = (description, prompt = '', subagentType = '') =>
  classify({ description, prompt, subagentType }).tier;

test('mechanical work goes to haiku', () => {
  assert.equal(tier('Find usages of loadConfig', 'Search the repo and list every file that calls loadConfig.'), 'haiku');
  assert.equal(tier('Rename helper', 'Rename formatDate to formatIsoDate across src/.'), 'haiku');
});

test('implementation goes to sonnet', () => {
  assert.equal(tier('Implement settings endpoint', 'Add a GET /settings endpoint with tests.'), 'sonnet');
  assert.equal(tier('Write tests for parser', 'Create unit tests covering the parser module.'), 'sonnet');
});

test('debugging, design and security go to opus', () => {
  assert.equal(tier('Debug flaky test', 'Investigate the root cause of the race condition in queue.test.js.'), 'opus');
  assert.equal(tier('Security review of auth', 'Audit the auth middleware for injection and bypass.'), 'opus');
  assert.equal(tier('Design plugin architecture', 'Lay out trade-offs for the hook system design.'), 'opus');
});

test('override wins', () => {
  assert.equal(tier('Find files !opus', 'search'), 'opus');
  assert.equal(tier('[haiku] Implement feature', 'implement'), 'haiku');
});

test('ambiguous text uses agent type, then default', () => {
  assert.equal(tier('Look around', 'Get familiar with the codebase.', 'Explore'), 'haiku');
  assert.equal(tier('Do the thing', 'Handle it.'), 'sonnet');
});

test('long multi-step briefs never go to haiku', () => {
  const steps = Array.from({ length: 8 }, (_, i) => `${i + 1}. search and list file ${i}`).join('\n');
  assert.notEqual(tier('Find things', steps), 'haiku');
});

test('decide leaves explicit models, forks and custom agents alone', () => {
  const ev = (tool_input) => ({ tool_name: 'Agent', tool_input });
  assert.equal(decide(ev({ prompt: 'find x', model: 'opus' }), {}).skip, 'explicit-model');
  assert.equal(decide(ev({ prompt: 'find x', subagent_type: 'fork' }), {}).skip, 'fork');
  assert.equal(decide(ev({ prompt: 'find x', subagent_type: 'qamaster:ui-dsm-agent' }), {}).skip, 'custom-agent');
  assert.equal(
    decide(ev({ prompt: 'find x', subagent_type: 'qamaster:ui-dsm-agent' }), { routeCustomAgents: ['qamaster:ui-dsm-agent'] }).tier,
    'haiku',
  );
});

test('hook script rewrites the model and keeps other fields', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'route.mjs');
  const event = {
    session_id: 's1',
    cwd: mkdtempSync(join(tmpdir(), 'sar-')),
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { description: 'Find config files', prompt: 'Search for every *.json config and list them.', subagent_type: 'general-purpose' },
  };
  const home = mkdtempSync(join(tmpdir(), 'sar-home-'));
  const r = spawnSync('node', [script], { input: JSON.stringify(event), env: { ...process.env, HOME: home } });
  assert.equal(r.status, 0, r.stderr.toString());
  const out = JSON.parse(r.stdout.toString());
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.deepEqual(out.hookSpecificOutput.updatedInput, { ...event.tool_input, model: 'haiku' });
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
});

test('hook script stays silent on bad input', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'route.mjs');
  const r = spawnSync('node', [script], { input: 'not json' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.toString(), '');
});
