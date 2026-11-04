# gearshift

Shifts Claude Code between Haiku, Sonnet and Opus by what each piece of work needs: every turn of your main session, every subagent, and every agent in an Ultracode workflow. It only uses models your account actually has.

| Work looks like | Gear |
|---|---|
| find, search, list, read, rename, format, lint, run tests | Haiku |
| implement, add, refactor, migrate, write tests | Sonnet |
| debug, root cause, design, architecture, security, review, audit | Opus |

No API calls, no network, no telemetry. Classification is keyword scoring that runs locally in a few milliseconds.

## Install

gearshift isn't in a public plugin marketplace, so you add it yourself. Pick one route; all of them install it for your Claude user profile, so every project and every new session gets it. You need Node 18+ and a Claude Code version with hook modules.

### Route 1: from GitHub (no download)

In Claude Code:

```
/plugin marketplace add smeel19/gearshift
/plugin install gearshift@gearshift
```

### Route 2: from the zip

1. Download `gearshift-1.0.0.zip` (from the GitHub repo's **Code > Download ZIP**, or from whoever shared it) and unzip it somewhere permanent, for example `~/claude-plugins/gearshift`. Claude Code loads the plugin from that folder, so don't delete or move it afterwards.
2. Add it and install it for your user, in Claude Code:

   ```
   /plugin marketplace add ~/claude-plugins/gearshift
   /plugin install gearshift@gearshift
   ```

   Or in a terminal:

   ```bash
   claude plugin marketplace add ~/claude-plugins/gearshift
   claude plugin install gearshift@gearshift --scope user
   ```

   (A GitHub "Download ZIP" unpacks to a folder named `gearshift-main`; use that folder's path instead.)

### Check it, update it, remove it

- **Check:** start a new session and type `/gear`. It shows the current model and the last decision. `claude plugin list` should show `gearshift@gearshift` as enabled.
- **Update:** from GitHub, `claude plugin marketplace update gearshift` then `claude plugin update gearshift@gearshift`. From a zip, replace the unzipped folder's contents with the new version, then run the same two commands.
- **Remove:** `claude plugin uninstall gearshift@gearshift` and `claude plugin marketplace remove gearshift`. Your settings and the model list live in `~/.claude/gearshift.json` and `~/.claude/gearshift/`; delete those too for a full clean-up.
- **Try without installing:** `claude --plugin-dir ~/claude-plugins/gearshift` loads it for that one session only.
- **Don't install it twice** (for example from GitHub and from a zip), or each request is routed twice.

## Use

```
/gear          show the current model and the last decision
/gear off      pause gearshift for this session (main session and subagents)
/gear on       resume
```

A pause lasts until `/gear on` or the end of the session, and never touches other sessions. To force a model for one subagent, put `!haiku`, `!sonnet` or `!opus` in its task, or ask Claude for "an Opus subagent".

## What it does

**Main session** (`hooks/main-router.js`): classifies each prompt and switches the model for that turn only; your session's saved model doesn't change. It is cache-aware: it upgrades straight away, but downgrades only after a couple of turns and with confidence, so it doesn't throw away the prompt cache on every message.

**Subagents** (`scripts/route.mjs`): a `PreToolUse` hook on the `Agent` tool sets `model` on each call. It leaves alone calls that already name a model, custom and plugin agents (they pin their own), and forks. Long multi-step briefs never go to Haiku.

**Workflows** (`scripts/workflow.mjs`): workflow agents don't go through the `Agent` tool, so the same hook catches the `Workflow` call and adds a small router after the script's `meta` block. Each `agent()` call is classified on its label and prompt when it runs. Named workflows and nested `workflow()` children aren't routed; a workflow already running when you `/gear off` keeps its models.

**Your models** (`scripts/models.mjs`): at session start gearshift works out which models your account can use: models pinned in your config, then models your recent sessions actually ran on, then models Claude Code caches for your account. The newest per family wins, and a missing family falls back to the nearest one, more capable first. The main session switches by full model ID (for example `claude-sonnet-5-5`), because some clients reject a bare `sonnet`.

```bash
node /path/to/gearshift/scripts/models.mjs     # list your models
node /path/to/gearshift/scripts/stats.mjs      # subagent routing summary
```

## Config

Optional. `~/.claude/gearshift.json` for all projects, `<project>/.claude/gearshift.json` for one (wins over the user file). Start from `gearshift.example.json`.

```json
{
  "models":    { "sonnet": "claude-sonnet-5-5" },
  "main":      { "routing": { "mode": "off" } },
  "subagents": { "enabled": false }
}
```

That example pauses gearshift for a whole project. `main` takes the main-session router's settings (`routing.mode`: `per-turn`, `session` or `off`; `cacheAware`; `minTurnsBetweenSwitches`; `minConfidence`; `debuggingStrategy`: `opus` or `sonnet-first`). `subagents` takes:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Route subagents and workflow agents. |
| `defaultTier` | `"sonnet"` | Model when a task gives no clear signal. |
| `minMargin` | `2` | How far ahead a tier must score to win; closer calls go to the more capable tier. |
| `respectExplicitModel` | `true` | Keep a model the caller already set. |
| `autoApprove` | `false` | Also approve the subagent call. Leave off so your permission rules apply. |
| `routeWorkflows` | `true` | Route `agent()` calls inside workflows. |
| `workflowLog` | `false` | Show each workflow agent's model in the progress view. |
| `agentTypes` | `{Explore: haiku, Plan: opus}` | Fallback tier per agent type. |
| `routeCustomAgents` | `[]` | Custom agent types gearshift may route. |
| `extraKeywords` | `{}` | Extra words per tier, for example `{"opus": ["migration plan"]}`. |
| `tierMap` | `{}` | Send a tier to another model, for example `{"opus": "fable"}`. |
| `log` | `true` | Log subagent decisions to `~/.claude/gearshift/log.jsonl`. |

Don't set `CLAUDE_CODE_SUBAGENT_MODEL` or `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`; they override the model gearshift picks.

## A word on savings

Routing pays off when cheap models get the work right first time. Every model switch re-reads the session context, so very short sessions can cost more, not less. Check with `stats.mjs` and a usage tracker before trusting any number.

## Tests

```bash
node --test test/*.test.mjs
```

## Credits

The main-session router is adapted from [cc-model-router](https://github.com/misterkante/cc-model-router) (MIT, commit b49b304), with full-model-ID switching and per-session pause added. See `LICENSE` and `LICENSE.cc-model-router`.
