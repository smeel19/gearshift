import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rewriteWorkflowScript, endOfMeta, MARKER } from '../scripts/workflow.mjs';
import { decideWorkflow } from '../scripts/route.mjs';

const META = `export const meta = {
  name: 'demo',
  description: 'has { braces } and a } in a string',
  phases: [{ title: 'Find' }, { title: 'Fix' }], // trailing } comment
}`;

// Runs a workflow script the way the runtime would, with stand-in agent() and log().
async function run(script) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, opts });
    return 'ok';
  };
  const log = () => {};
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  await new AsyncFunction('agent', 'log', script.replace(/export\s+const\s+meta/, 'const meta'))(agent, log);
  return calls;
}

test('finds the end of meta despite braces in strings and comments', () => {
  const at = endOfMeta(META + '\nphase("Find")');
  assert.equal(META.length, at);
});

test('routes each agent call by its label and prompt', async () => {
  const script = `${META}
const files = await agent('Find and list every config file', { label: 'find' })
await agent(\`Debug the root cause of the crash in \${files}\`, { label: 'debug' })
await agent('Implement the settings endpoint with tests')`;
  const r = rewriteWorkflowScript(script);
  assert.equal(r.sites, 3);
  const calls = await run(r.script);
  assert.deepEqual(calls.map((c) => c.opts.model), ['haiku', 'opus', 'sonnet']);
  assert.equal(calls[0].opts.label, 'find');
});

test('keeps explicit models and custom agent types', async () => {
  const script = `${META}
await agent('Find files', { model: 'opus' })
await agent('Find files', { agentType: 'qamaster:ui-dsm-agent' })`;
  const calls = await run(rewriteWorkflowScript(script).script);
  assert.equal(calls[0].opts.model, 'opus');
  assert.equal(calls[1].opts.model, undefined);
});

test('works inside pipeline-style callbacks and leaves .agent( alone', async () => {
  const script = `${META}
const obj = { agent: (x) => x }
obj.agent('not a call site')
const out = await Promise.all(['a', 'b'].map((f) => agent('Search for ' + f)))`;
  const r = rewriteWorkflowScript(script);
  assert.equal(r.sites, 1);
  const calls = await run(r.script);
  assert.deepEqual(calls.map((c) => c.opts.model), ['haiku', 'haiku']);
});

test('is idempotent and skips scripts it cannot place', () => {
  const once = rewriteWorkflowScript(`${META}\nawait agent('x')`).script;
  assert.equal(rewriteWorkflowScript(once).skip, 'already-routed');
  assert.equal(rewriteWorkflowScript(`await agent('x')`).skip, 'no-meta');
  assert.equal(rewriteWorkflowScript(`${META}\nlog('hi')`).skip, 'no-agent-calls');
  assert.ok(once.includes(MARKER));
});

test('tierMap and routeCustomAgents apply inside workflows', async () => {
  const script = `${META}
await agent('Debug the root cause', { agentType: 'my-agent' })`;
  const calls = await run(rewriteWorkflowScript(script, { routeCustomAgents: ['my-agent'], tierMap: { opus: 'fable' } }).script);
  assert.equal(calls[0].opts.model, 'fable');
});

test('decideWorkflow inlines a scriptPath and skips named workflows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sar-wf-'));
  const p = join(dir, 'wf.js');
  writeFileSync(p, `${META}\nawait agent('Find files')`);
  const d = decideWorkflow({ tool_input: { scriptPath: p, resumeFromRunId: 'wf_abc123' } }, {});
  assert.equal(d.updatedInput.scriptPath, undefined);
  assert.equal(d.updatedInput.resumeFromRunId, 'wf_abc123');
  assert.ok(d.updatedInput.script.includes(MARKER));
  assert.equal(decideWorkflow({ tool_input: { name: 'review-changes' } }, {}).skip, 'named-workflow');
  assert.equal(decideWorkflow({ tool_input: { script: 'x' } }, { routeWorkflows: false }).skip, 'disabled');
});
