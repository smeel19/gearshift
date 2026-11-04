// Rewrites a Workflow script so each agent() call gets a routed model.
// Workflow prompts are often built at run time, so the classifier itself is
// injected into the script and runs inside the workflow, per agent call.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const MARKER = '__sarAgent';

// agent( at a call site: not a property (x.agent), not part of a longer name.
const CALL = /(?<![\w$.])agent(\s*\()/g;

const classifierSource = () =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'classify.mjs'), 'utf8')
    .replace(/^export /gm, '');

// Index just past the `export const meta = {...}` literal (and a trailing `;`), or -1.
export function endOfMeta(script) {
  const start = script.search(/export\s+const\s+meta\s*=\s*\{/);
  if (start < 0) return -1;
  let i = script.indexOf('{', start);
  let depth = 0;
  for (; i < script.length; i++) {
    const c = script[i];
    if (c === '"' || c === "'" || c === '`') {
      // Skip a string literal. meta must be a pure literal, so no ${} nesting to track.
      for (i++; i < script.length && script[i] !== c; i++) if (script[i] === '\\') i++;
    } else if (c === '/' && script[i + 1] === '/') {
      i = script.indexOf('\n', i);
      if (i < 0) return -1;
    } else if (c === '/' && script[i + 1] === '*') {
      i = script.indexOf('*/', i);
      if (i < 0) return -1;
      i++;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      let end = i + 1;
      while (script[end] === ' ' || script[end] === '\t') end++;
      if (script[end] === ';') end++;
      return end;
    }
  }
  return -1;
}

// Returns { script, sites } with agent() calls routed, or { skip } when it can't or shouldn't.
export function rewriteWorkflowScript(script, config = {}) {
  if (!script || script.includes(MARKER)) return { skip: 'already-routed' };
  const at = endOfMeta(script);
  if (at < 0) return { skip: 'no-meta' };

  const head = script.slice(0, at);
  const body = script.slice(at);
  let sites = 0;
  const routedBody = body.replace(CALL, (_, paren) => {
    sites++;
    return `${MARKER}${paren}`;
  });
  if (!sites) return { skip: 'no-agent-calls' };

  const settings = {
    respectExplicitModel: config.respectExplicitModel !== false,
    routable: ['', 'general-purpose', 'claude', 'Explore', 'Plan', ...(config.routeCustomAgents || [])],
    // Tier -> family alias the account has; tierMap from config wins.
    tierMap: {
      ...Object.fromEntries(Object.entries(config.registry?.resolve || {}).map(([t, v]) => [t, v.family])),
      ...(config.tierMap || {}),
    },
    show: !!config.workflowLog,
  };
  const { registry, ...cfgForScript } = config;

  const prelude = `
// --- gearshift: picks a model per agent() call (remove this block to disable) ---
const ${MARKER} = (() => {
${classifierSource()}
const cfg = ${JSON.stringify(cfgForScript)};
const s = ${JSON.stringify(settings)};
return (prompt, opts) => {
  const o = opts || {};
  if (o.model && s.respectExplicitModel) return agent(prompt, opts);
  if (!s.routable.includes(o.agentType || '')) return agent(prompt, opts);
  const r = classify({ description: o.label || '', prompt: String(prompt), subagentType: o.agentType || '' }, cfg);
  const model = s.tierMap[r.tier] || r.tier;
  if (s.show) log('gearshift: ' + (o.label || 'agent') + ' -> ' + model + ' (' + r.reason + ')');
  return agent(prompt, { ...o, model });
};
})();
// --- end gearshift ---
`;
  return { script: head + prelude + routedBody, sites };
}
