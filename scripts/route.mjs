#!/usr/bin/env node
// PreToolUse hook for the Agent tool: picks haiku/sonnet/opus for each subagent
// and rewrites the call's `model` field. Never blocks: on any error it exits 0
// with no output, so the call runs exactly as Claude wrote it.

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classify } from './classify.mjs';
import { rewriteWorkflowScript } from './workflow.mjs';
import { loadRegistry } from './models.mjs';
import { isPausedInTranscript } from './pause.mjs';

// Agent types whose model we may set. Custom and plugin agents usually pin a
// model in their own frontmatter, and setting it here would override that.
const ROUTABLE_TYPES = new Set(['', 'general-purpose', 'claude', 'Explore', 'Plan']);

function loadConfig(cwd) {
  const paths = [
    join(homedir(), '.claude', 'gearshift.json'),
    cwd && join(cwd, '.claude', 'gearshift.json'),
  ].filter(Boolean);
  let config = {};
  for (const p of paths) {
    try {
      config = { ...config, ...(JSON.parse(readFileSync(p, 'utf8')).subagents || {}) };
    } catch {
      // Missing or unreadable config: keep defaults.
    }
  }
  return config;
}

function log(config, entry) {
  if (config.log === false) return;
  try {
    const dir = join(homedir(), '.claude', 'gearshift');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'log.jsonl'), JSON.stringify(entry) + '\n');
  } catch {
    // Logging is best effort.
  }
}

export function decide(event, config) {
  const input = event.tool_input || {};
  const type = input.subagent_type || '';

  if (config.enabled === false) return { skip: 'disabled' };
  if (type === 'fork') return { skip: 'fork' };
  if (input.model && config.respectExplicitModel !== false) return { skip: 'explicit-model' };
  if (!ROUTABLE_TYPES.has(type) && !(config.routeCustomAgents || []).includes(type)) {
    return { skip: 'custom-agent' };
  }

  const result = classify(
    { description: input.description, prompt: input.prompt, subagentType: type },
    config,
  );
  const tier = available(result.tier, config);
  return { ...result, tier, updatedInput: { ...input, model: tier } };
}

// Maps a tier to a model family the account has (the Agent tool and workflow agent()
// take family aliases). tierMap from config wins; else the nearest available family.
export function available(tier, config, registry = config.registry) {
  const mapped = (config.tierMap || {})[tier];
  if (mapped) return mapped;
  return registry?.resolve?.[tier]?.family || tier;
}

// Workflow agents don't go through the Agent tool, so route them by rewriting the script.
export function decideWorkflow(event, config) {
  const input = event.tool_input || {};
  if (config.enabled === false || config.routeWorkflows === false) return { skip: 'disabled' };

  let script = input.script;
  // scriptPath wins over script in the Workflow tool, so read it and pass the routed text inline.
  if (input.scriptPath) {
    try {
      script = readFileSync(input.scriptPath, 'utf8');
    } catch {
      return { skip: 'unreadable-script' };
    }
  }
  if (!script) return { skip: 'named-workflow' };

  const r = rewriteWorkflowScript(script, config);
  if (r.skip) return r;
  const { scriptPath, ...rest } = input;
  return { reason: `workflow:${r.sites}-sites`, updatedInput: { ...rest, script: r.script } };
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw);
  const isWorkflow = event.tool_name === 'Workflow';
  if (!isWorkflow && event.tool_name !== 'Agent' && event.tool_name !== 'Task') return;

  const config = { ...loadConfig(event.cwd), registry: loadRegistry() };
  if (isPausedInTranscript(event.transcript_path)) config.enabled = false;
  const d = isWorkflow ? decideWorkflow(event, config) : decide(event, config);

  log(config, {
    ts: new Date().toISOString(),
    session: event.session_id,
    from_agent: event.agent_type || 'main',
    subagent_type: isWorkflow ? 'workflow' : event.tool_input?.subagent_type || '',
    description: isWorkflow ? event.tool_input?.name || event.tool_input?.scriptPath || 'inline' : event.tool_input?.description || '',
    tier: d.tier || null,
    reason: d.reason || d.skip,
    scores: d.scores || null,
  });

  if (!d.updatedInput) return;
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: d.updatedInput,
    },
  };
  // Off by default so your normal permission rules still apply to every subagent.
  if (config.autoApprove) {
    out.hookSpecificOutput.permissionDecision = 'allow';
    out.hookSpecificOutput.permissionDecisionReason = `gearshift: ${d.tier || 'workflow'} (${d.reason})`;
  }
  process.stdout.write(JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}
