import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRegistry, compareIds, discover } from '../scripts/models.mjs';
import { decide, available } from '../scripts/route.mjs';
import { rewriteWorkflowScript } from '../scripts/workflow.mjs';

test('newest ID per family wins', () => {
  assert.deepEqual(
    ['claude-sonnet-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-5-20250929'].sort(compareIds)[0],
    'claude-sonnet-5-5',
  );
});

test('used models beat account cache, pinned beats both', () => {
  const reg = buildRegistry({
    pinned: { opus: 'claude-opus-5-1' },
    proven: ['claude-sonnet-4-6', 'claude-opus-5-5'],
    offered: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
  });
  assert.equal(reg.families.sonnet.id, 'claude-sonnet-4-6');
  assert.equal(reg.families.sonnet.source, 'used');
  assert.equal(reg.families.haiku.source, 'account');
  assert.equal(reg.resolve.opus.id, 'claude-opus-5-1');
});

test('a missing family falls back to the nearest one, upward first', () => {
  const reg = buildRegistry({ proven: ['claude-sonnet-5-5', 'claude-opus-5-5'] });
  assert.deepEqual(reg.resolve.haiku, { family: 'sonnet', id: 'claude-sonnet-5-5' });
  const onlyHaiku = buildRegistry({ proven: ['claude-haiku-5-5'] });
  assert.equal(onlyHaiku.resolve.opus.family, 'haiku');
});

test('1m suffix is stripped from resolved IDs', () => {
  const reg = buildRegistry({ offered: ['claude-fable-5-1[1m]', 'claude-opus-5-5'] });
  assert.equal(reg.resolve.fable.id, 'claude-fable-5-1');
});

test('discover reads transcripts and the account cache', () => {
  const home = mkdtempSync(join(tmpdir(), 'sar-models-'));
  mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'projects', 'p', 's.jsonl'),
    [
      JSON.stringify({ message: { model: 'claude-sonnet-5-5' }, type: 'assistant' }),
      JSON.stringify({ type: 'user', message: { content: 'try claude-opus-9-9' } }),
    ].join('\n'),
  );
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ additionalModelOptionsCache: [{ value: 'claude-fable-5-1[1m]' }] }));
  const reg = discover(home);
  assert.equal(reg.families.sonnet.source, 'used');
  assert.equal(reg.families.opus, undefined, 'a model named in a user message is not proof of access');
  assert.equal(reg.families.fable.source, 'account');
});

test('subagent calls only get families the account has', () => {
  const registry = buildRegistry({ proven: ['claude-sonnet-5-5', 'claude-opus-5-5'] });
  const d = decide({ tool_name: 'Agent', tool_input: { prompt: 'Find and list config files' } }, { registry });
  assert.equal(d.updatedInput.model, 'sonnet');
  assert.equal(available('opus', { tierMap: { opus: 'fable' } }, registry), 'fable');
});

test('workflow agents only get families the account has', async () => {
  const registry = buildRegistry({ proven: ['claude-sonnet-5-5'] });
  const script = `export const meta = { name: 'x', description: 'y' }
await agent('Debug the root cause')`;
  const out = rewriteWorkflowScript(script, { registry }).script;
  assert.ok(!out.includes('"families"'), 'registry itself is not embedded');
  const calls = [];
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  await new AsyncFunction('agent', 'log', out.replace('export const meta', 'const meta'))(
    async (p, o) => calls.push(o),
    () => {},
  );
  assert.equal(calls[0].model, 'sonnet');
});
