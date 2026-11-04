#!/usr/bin/env node
// Summarise subagent routing decisions from ~/.claude/gearshift/log.jsonl.
// Usage: node stats.mjs [--since 2026-11-04]

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sinceIdx = process.argv.indexOf('--since');
const since = sinceIdx > -1 ? process.argv[sinceIdx + 1] : '';

let lines = [];
try {
  lines = readFileSync(join(homedir(), '.claude', 'gearshift', 'log.jsonl'), 'utf8').trim().split('\n');
} catch {
  console.log('No routing log yet.');
  process.exit(0);
}

const tiers = {};
const reasons = {};
let total = 0;
for (const line of lines) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  if (since && e.ts < since) continue;
  total++;
  const t = e.tier || 'untouched';
  tiers[t] = (tiers[t] || 0) + 1;
  reasons[e.reason] = (reasons[e.reason] || 0) + 1;
}

console.log(`Subagent calls: ${total}`);
for (const [t, n] of Object.entries(tiers)) console.log(`  ${t.padEnd(10)} ${n} (${Math.round((100 * n) / total)}%)`);
console.log('Reasons:');
for (const [r, n] of Object.entries(reasons)) console.log(`  ${r.padEnd(16)} ${n}`);
