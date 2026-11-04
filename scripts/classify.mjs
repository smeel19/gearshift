// Pure classifier: decides which model tier a subagent task needs.
// No I/O here so it can be unit-tested and reused.

export const TIERS = ['haiku', 'sonnet', 'opus'];

// Keyword signals per tier. Each entry is [regex, weight].
// Same tiers as the main-session router (lib/main-classifier.js): mechanical / implementation / debugging+design.
export const DEFAULT_SIGNALS = {
  haiku: [
    [/\b(find|search|grep|locate|list|look ?up|where is|which files?)\b/, 3],
    [/\b(read|summari[sz]e|skim|count|inventory|enumerate)\b/, 2],
    [/\b(rename|reformat|format|lint|typo|sort imports?|bump version)\b/, 3],
    [/\b(run (the )?(tests?|build|linter)|check (the )?(status|output))\b/, 2],
    [/\b(extract|collect|gather|fetch|grab)\b/, 1],
  ],
  sonnet: [
    [/\b(implement|add|build|create|write|update|wire ?up|hook ?up)\b/, 2],
    [/\b(refactor|migrate|port|convert|integrate)\b/, 2],
    [/\b(tests?|spec|fixture|mock)\b/, 1],
    [/\b(fix|patch|handle|support)\b/, 1],
    [/\b(endpoint|component|function|module|feature|plugin|hook|command|skill)\b/, 1],
  ],
  opus: [
    [/\b(debug|root ?cause|why (does|is|did)|investigate|diagnos\w*|flaky|race condition|deadlock|memory leak)\b/, 3],
    [/\b(architect\w*|design|trade-?offs?|strategy|plan the|system design)\b/, 3],
    [/\b(security|vulnerab\w*|auth[nz]?\w*|threat|exploit|injection|cve)\b/, 3],
    [/\b(review|audit|verify|adversarial|critique)\b/, 2],
    [/\b(concurren\w*|distributed|consisten\w*|performance|optimi[sz]e)\b/, 2],
  ],
};

// Built-in agent types with a sensible default tier when the text is ambiguous.
export const DEFAULT_AGENT_TYPES = {
  Explore: 'haiku',
  Plan: 'opus',
};

const OVERRIDE = /(?:^|\s)[!\[](haiku|sonnet|opus)\]?(?=\s|$)/i;

export function classify({ description = '', prompt = '', subagentType = '' }, config = {}) {
  const text = `${description}\n${prompt}`;

  // 1. Explicit override typed by the caller: "!haiku" or "[opus]".
  const forced = text.match(OVERRIDE);
  if (forced) return { tier: forced[1].toLowerCase(), reason: 'override', scores: null };

  // 2. Keyword scoring. Description counts double: it is the caller's own summary of the task.
  const signals = mergeSignals(DEFAULT_SIGNALS, config.extraKeywords);
  const scores = { haiku: 0, sonnet: 0, opus: 0 };
  const desc = description.toLowerCase();
  const body = prompt.toLowerCase();
  for (const tier of TIERS) {
    for (const [re, weight] of signals[tier]) {
      if (re.test(desc)) scores[tier] += weight * 2;
      if (re.test(body)) scores[tier] += weight;
    }
  }

  // 3. Size: long, multi-step briefs never go to Haiku; a failed cheap run costs more than it saves.
  const steps = (prompt.match(/^\s*(\d+[.)]|[-*])\s+/gm) || []).length;
  if (prompt.length > 4000 || steps >= 6) {
    scores.sonnet += scores.haiku;
    scores.haiku = 0;
  }

  const ranked = TIERS.map((t) => [t, scores[t]]).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  const agentTypes = { ...DEFAULT_AGENT_TYPES, ...(config.agentTypes || {}) };
  const typeTier = agentTypes[subagentType];

  // 4. No clear winner: fall back to the agent type's tier, then the default tier.
  if (top[1] <= 0 || top[1] - second[1] < (config.minMargin ?? 2)) {
    // On a near tie, take the more capable tier rather than risk a failed cheap run.
    const tied = ranked.filter(([, s]) => s > 0 && top[1] - s < (config.minMargin ?? 2)).map(([t]) => t);
    if (typeTier) return { tier: typeTier, reason: `agent-type:${subagentType}`, scores };
    if (tied.length) return { tier: highest(tied), reason: 'tie-up', scores };
    return { tier: config.defaultTier || 'sonnet', reason: 'default', scores };
  }
  return { tier: top[0], reason: 'keywords', scores };
}

function highest(tiers) {
  return tiers.sort((a, b) => TIERS.indexOf(b) - TIERS.indexOf(a))[0];
}

function mergeSignals(base, extra) {
  if (!extra) return base;
  const out = {};
  for (const tier of TIERS) {
    const added = (extra[tier] || []).map((w) => [new RegExp(`\\b${escape(w.toLowerCase())}\\b`), 2]);
    out[tier] = [...base[tier], ...added];
  }
  return out;
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
