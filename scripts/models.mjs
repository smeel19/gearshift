#!/usr/bin/env node
// Works out which Claude models this account can use, newest per family, and
// writes ~/.claude/gearshift/models.json for the main and subagent routers to read.
// Run directly to print the list: node models.mjs [--write]
//
// Sources, strongest first:
//   1. `models` pinned in ~/.claude/gearshift.json
//   2. model IDs your recent sessions actually ran on (proof of access)
//   3. models Claude Code caches for your account in ~/.claude.json
//   4. built-in latest IDs, used only for a family nothing else covers

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'];
// Routing tiers in order of capability; fable sits above opus.
const ORDER = ['haiku', 'sonnet', 'opus', 'fable'];
const BUILT_IN = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};
const ID = /claude-(haiku|sonnet|opus|fable)-(\d+)(?:-(\d+))?(?:-(\d{8}))?/g;

export function familyOf(id) {
  return FAMILIES.find((f) => String(id).toLowerCase().includes(f)) || null;
}

// Newer first: by major, minor, then date suffix.
export function compareIds(a, b) {
  const key = (id) => {
    const m = /-(\d+)(?:-(\d+))?(?:-(\d{8}))?$/.exec(id.replace(/\[.*\]$/, '')) || [];
    return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
  };
  const [ka, kb] = [key(a), key(b)];
  for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
  return 0;
}

function idsIn(text) {
  return [...String(text).matchAll(ID)].map((m) => m[0]);
}

function fromTranscripts(home, maxFiles = 60) {
  const root = join(home, '.claude', 'projects');
  const files = [];
  try {
    for (const dir of readdirSync(root)) {
      const p = join(root, dir);
      for (const f of readdirSync(p)) {
        if (f.endsWith('.jsonl')) files.push(join(p, f));
      }
    }
  } catch {
    return [];
  }
  const recent = files
    .map((f) => {
      try {
        return [f, statSync(f).mtimeMs];
      } catch {
        return [f, 0];
      }
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxFiles);
  const seen = new Set();
  for (const [f] of recent) {
    try {
      // Only assistant replies count: the API answered on that model.
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.includes('"type":"assistant"')) continue;
        const m = /"model":"(claude-[a-z0-9-]+)"/.exec(line);
        if (m) seen.add(m[1]);
      }
    } catch {
      // Unreadable transcript: skip.
    }
  }
  return [...seen];
}

function fromAccountCache(home) {
  try {
    const d = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    return idsIn(
      JSON.stringify([d.additionalModelOptionsCache, d.modelAccessCache, d.orgModelDefaultCache, d.clientDataCacheSlots]),
    );
  } catch {
    return [];
  }
}

export function buildRegistry({ pinned = {}, proven = [], offered = [] } = {}) {
  const families = {};
  for (const fam of FAMILIES) {
    const pick = (ids) => ids.filter((id) => familyOf(id) === fam).sort(compareIds)[0];
    if (pinned[fam]) families[fam] = { id: pinned[fam], source: 'pinned' };
    else if (pick(proven)) families[fam] = { id: pick(proven), source: 'used' };
    else if (pick(offered)) families[fam] = { id: pick(offered), source: 'account' };
  }
  // If the account shows no models at all, trust the built-ins rather than routing nowhere.
  const anyKnown = Object.keys(families).length > 0;
  for (const fam of ['haiku', 'sonnet', 'opus']) {
    if (!families[fam] && !anyKnown) families[fam] = { id: BUILT_IN[fam], source: 'built-in' };
  }

  // Each tier resolves to its own family, or the nearest available one: up first, then down.
  const resolve = {};
  for (const tier of ['haiku', 'sonnet', 'opus']) {
    const i = ORDER.indexOf(tier);
    const order = [...ORDER.slice(i, 3), ...ORDER.slice(0, i).reverse()];
    const fam = order.find((f) => families[f]);
    if (fam) resolve[tier] = { family: fam, id: families[fam].id.replace(/\[.*\]$/, '') };
  }
  if (families.fable) resolve.fable = { family: 'fable', id: families.fable.id.replace(/\[.*\]$/, '') };
  return { families, resolve };
}

export function discover(home = homedir()) {
  let pinned = {};
  try {
    pinned = JSON.parse(readFileSync(join(home, '.claude', 'gearshift.json'), 'utf8')).models || {};
  } catch {
    // No user config.
  }
  return buildRegistry({ pinned, proven: fromTranscripts(home), offered: fromAccountCache(home) });
}

export function registryPath(home = homedir()) {
  return join(home, '.claude', 'gearshift', 'models.json');
}

// Reads the saved registry; falls back to discovering now.
export function loadRegistry(home = homedir()) {
  try {
    return JSON.parse(readFileSync(registryPath(home), 'utf8'));
  } catch {
    return discover(home);
  }
}

export function writeRegistry(home = homedir()) {
  const reg = { ...discover(home), updatedAt: new Date().toISOString() };
  mkdirSync(join(home, '.claude', 'gearshift'), { recursive: true });
  writeFileSync(registryPath(home), JSON.stringify(reg, null, 2));
  return reg;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const reg = process.argv.includes('--write') ? writeRegistry() : discover();
    if (!process.argv.includes('--quiet')) {
      console.log('Models this account can use (newest per family):');
      for (const [fam, v] of Object.entries(reg.families)) console.log(`  ${fam.padEnd(7)} ${v.id}  [${v.source}]`);
      console.log('Routing tiers resolve to:');
      for (const [tier, v] of Object.entries(reg.resolve)) console.log(`  ${tier.padEnd(7)} -> ${v.id}`);
    }
  } catch {
    // Never fail session start.
  }
}
