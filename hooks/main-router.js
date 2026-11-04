import { classify } from "../lib/main-classifier.js";
import { DEFAULT_ROUTING, mergeConfigs } from "../lib/main-config.js";

const TIER_RANK = {
  mechanical: 0,
  implementation: 1,
  debugging: 2
};

const state = {
  turnNumber: 0,
  lastSwitchTurn: -1,
  lastSwitchModel: null,
  lastDecision: null,
  sessionDecision: null,
  paused: false
};

const pending = [];
const byTurn = new Map();

function modelFamily(model) {
  const value = String(model || "").toLowerCase();
  if (value.includes("haiku")) return "haiku";
  if (value.includes("sonnet")) return "sonnet";
  if (value.includes("opus")) return "opus";
  return null;
}

function rankForTier(tier) {
  return TIER_RANK[tier] ?? TIER_RANK.implementation;
}

function rankForModel(model) {
  const family = modelFamily(model);
  return family ? rankForTier(family === "haiku" ? "mechanical" : family === "opus" ? "debugging" : "implementation") : -1;
}

async function readJson($, path) {
  try {
    if (!(await $.fs.exists(path))) return null;
    return JSON.parse(await $.fs.read(path));
  } catch {
    return null;
  }
}

// A bare alias such as "sonnet" is rejected as "model isn't available" in some
// clients, so switch to a full model ID the account is known to have.
// scripts/models.mjs writes this list at session start.
const FULL_IDS = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5"
};

async function resolveModel($, family) {
  const home = (await $.env.get("HOME")) || "";
  const reg = home
    ? await readJson($, `${home}/.claude/gearshift/models.json`)
    : null;
  return reg?.resolve?.[family]?.id || FULL_IDS[family] || family;
}

async function loadConfig($) {
  const cwd = await $.session.cwd();
  const home = (await $.env.get("HOME")) || "";
  const configDir =
    (await $.env.get("GEARSHIFT_CONFIG_DIR")) ||
    (home ? `${home}/.claude` : ".claude");
  const globalConfig = await readJson($, `${configDir}/gearshift.json`);
  const projectConfig = await readJson($, `${cwd}/.claude/gearshift.json`);
  return mergeConfigs(globalConfig?.main, projectConfig?.main);
}

function applyDecision(result, routing) {
  return {
    action: "apply",
    model: result.model,
    effort: result.effort,
    result
  };
}

function chooseDecision(result, config, currentModel) {
  const routing = config.routing || DEFAULT_ROUTING;

  if (routing.mode === "off") {
    return { action: "keep", result, reason: "routing off" };
  }

  if (routing.mode === "session" && state.sessionDecision) {
    return state.sessionDecision;
  }

  const current = modelFamily(currentModel);
  const recommended = modelFamily(result.model);
  if (!recommended) {
    return { action: "keep", result, reason: "unknown model" };
  }

  if (!current || current === recommended) {
    const decision = applyDecision({ ...result, model: recommended }, routing);
    if (routing.mode === "session") state.sessionDecision = decision;
    return decision;
  }

  if (!routing.cacheAware) {
    const decision = applyDecision({ ...result, model: recommended }, routing);
    if (routing.mode === "session") state.sessionDecision = decision;
    return decision;
  }

  const currentRank = rankForModel(current);
  const recommendedRank = rankForTier(result.tier);
  const turnsSinceSwitch = state.turnNumber + 1 - state.lastSwitchTurn;
  const enoughTurns =
    turnsSinceSwitch >= (routing.minTurnsBetweenSwitches ?? 2);
  const confident =
    (result.confidence ?? 0) >= (routing.minConfidence ?? 0.5);

  if (recommendedRank > currentRank) {
    const decision = applyDecision({ ...result, model: recommended }, routing);
    if (routing.mode === "session") state.sessionDecision = decision;
    return decision;
  }

  if (recommendedRank < currentRank && enoughTurns && confident) {
    const decision = applyDecision({ ...result, model: recommended }, routing);
    if (routing.mode === "session") state.sessionDecision = decision;
    return decision;
  }

  return {
    action: "keep",
    result,
    reason: recommendedRank < currentRank ? "cache-aware cooldown" : "same tier"
  };
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    state.turnNumber = 0;
    state.lastSwitchTurn = -1;
    state.lastSwitchModel = null;
    state.lastDecision = null;
    state.sessionDecision = null;
    state.paused = false;
    pending.length = 0;
    byTurn.clear();

    await $.command
      .register({
        name: "gear",
        description: "Show gearshift's last decision; /gear off or /gear on pauses or resumes it for this session"
      })
      .catch(() => {});

    return next(e);
  });

  on("prompt.submit", async ($, e, next) => {
    if (!e.text || /^\s*\//.test(e.text)) return next(e);
    if (state.paused) return next(e);

    const config = await loadConfig($);
    const result = classify(e.text, config);
    const currentModel = await $.session.model().catch(() => undefined);
    const decision = chooseDecision(result, config, currentModel);
    pending.push({ text: e.text, result, decision });
    return next(e);
  }).catch(async ($, e, next) => {
    // The router only observes prompts. If it fails, let the prompt through.
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    state.turnNumber += 1;

    let index = pending.findIndex((item) => item.text === e.text);
    if (index === -1) index = 0;
    const item = pending.splice(index, 1)[0];
    byTurn.set(e.turnId, {
      text: item?.text || e.text,
      result: item?.result || null,
      decision: item?.decision || { action: "keep", result: null },
      applied: false
    });

    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    const item = byTurn.get(e.turnId);
    if (!item || e.agentId) {
      return yield* next(e);
    }

    if (!item.applied) {
      item.applied = true;
      state.lastDecision = {
        turnId: e.turnId,
        text: item.text,
        result: item.result,
        decision: item.decision
      };

      if (
        item.decision.action === "apply" &&
        modelFamily(e.model) !== modelFamily(item.decision.model)
      ) {
        state.lastSwitchTurn = state.turnNumber;
        state.lastSwitchModel = item.decision.model;
      }
    }

    if (state.paused || item.decision.action !== "apply") {
      return yield* next(e);
    }

    if (!item.modelId) {
      item.modelId = await resolveModel($, item.decision.model);
    }

    return yield* next({
      ...e,
      model: item.modelId,
      effort: item.decision.effort
    });
  });

  on("turn.complete", async ($, e, next) => {
    byTurn.delete(e.turnId);
    return next(e);
  });

  on("command.run", { command: "gear" }, async ($, e) => {
    // "/gear off" and "/gear on" pause and resume routing for this session only. State lives in memory, so it never outlasts the session.
    const arg = String(e.args || "").trim().toLowerCase();
    if (arg === "off" || arg === "pause") {
      state.paused = true;
      return { text: "paused for this session. /gear on resumes." };
    }
    if (arg === "on" || arg === "resume") {
      state.paused = false;
      return { text: "resumed for this session." };
    }
    const config = await loadConfig($);
    const current = await $.session.model().catch(() => "unknown");
    const routing = config.routing || DEFAULT_ROUTING;
    const last = state.lastDecision;
    const lastLine = last?.decision?.action === "apply"
      ? `${last.decision.model}/${last.decision.effort} for "${last.text}"`
      : last
        ? `kept ${current} (${last.decision.reason || "no switch"}) for "${last.text}"`
        : "no decision yet";

    return {
      text: [
        `current=${current}`,
        `last=${lastLine}`,
        `paused=${state.paused} mode=${routing.mode} cacheAware=${routing.cacheAware} minTurns=${routing.minTurnsBetweenSwitches}`
      ].join("\n")
    };
  });
}
