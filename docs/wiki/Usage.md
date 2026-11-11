# Usage

Model Profiles resolves each agent's `modelRef` to a model from `models.jsonc`. It requires Node 22.18+ and is built for Kilo CLI 7.8.x, starting at 7.8.27.

## Install

Add the package to `plugin` in both `kilo.jsonc` (the server plugin resolves models) and `tui.jsonc` (the `/model-config` dialog and fallback toasts):

```jsonc
{ "plugin": ["@lunchbox-labs/kilo-model-profiles"] }
```

## Name the model an agent uses

Set `modelRef` in an agent's Markdown frontmatter:

```markdown
---
description: Plans and implements changes
mode: primary
modelRef: reasoning
---
```

or on an agent entry in `kilo.jsonc`, built-in agents included:

```jsonc
{ "agent": { "reviewer": { "modelRef": "reasoning" } } }
```

A resolved ref sets the agent's `model`, replacing any model the agent sets itself, along with the model settings the ref names (see [Model settings](#model-settings)). Settings the ref leaves out keep the agent's own values. `modelRef` is removed before Kilo builds the agent, so it never reaches a provider as an option.

## models.jsonc

The plugin reads `models.jsonc` from Kilo's global config directory (`KILO_CONFIG_DIR`, else `$XDG_CONFIG_HOME/kilo`, else `~/.config/kilo`) each time Kilo loads a project. To use another file, pass `configFile`, resolved against that directory:

```jsonc
{
  "plugin": [
    [
      "@lunchbox-labs/kilo-model-profiles",
      { "configFile": "models/work.jsonc" },
    ],
  ],
}
```

```jsonc
{
  "$schema": "https://cdn.jsdelivr.net/npm/@lunchbox-labs/kilo-model-profiles/schema.json",
  "defaults": {
    "reasoning": { "model": "openai/gpt-6-astra", "variant": "high" },
    "coding": "openai/gpt-5.6-sol",
    "system": "openai/gpt-5.6-terra",
  },
  "profiles": {
    "anthropic-latest": {
      "reasoning": { "model": "anthropic/claude-opus-5-5", "variant": "high" },
      "coding": "anthropic/claude-sonnet-5-5",
    },
  },
  "builtins": { "general": "coding", "title": "system" },
}
```

- `defaults` maps ref names to models. A model is `"provider/model"`, or an object with `model` and the [model settings](#model-settings) to send with it.
- `profiles` maps profile names to refs. A ref the selected profile leaves out comes from `defaults`.
- `builtins` gives refs to Kilo's built-in agents: `code`, `plan`, `debug`, `ask`, `orchestrator`, `general`, `explore`, `scout`, `compaction`, `title` and `summary`. A built-in can also take a `modelRef` on its entry in `kilo.jsonc`, like any other agent. That entry's `modelRef`, or a `model` it sets itself, wins over `builtins`. Built-ins with neither keep Kilo's default model choice.
- `defaultProfile` (optional) names the profile used when none is saved for the worktree.

## Model settings

An object ref takes the model settings of a Kilo agent entry, so a ref carries the agent settings its model needs:

```jsonc
{
  "defaults": {
    "reasoning": {
      "model": "openai/gpt-6-astra",
      "variant": "high",
      "options": { "reasoningSummary": "detailed" },
    },
    "coding": {
      "model": "openai/gpt-6",
      "reasoningEffort": "high",
      "textVerbosity": "low",
    },
  },
}
```

- `variant`, `temperature` and `top_p` replace the agent's own values. A request the agent sends to another model, such as a fallback or a model picked by hand, gets the agent's own `temperature` and `top_p` back, or the provider's default where the agent sets none, since some providers refuse another model's sampling settings. The ref's `options` still go with it, as an agent's options do in Kilo.
- `options` are provider options. They merge over the agent's own `options` the way Kilo merges them: nested objects key by key, the ref winning where both set a value. As in Kilo, the variant's own options still win over them.
- Any other key goes into `options`, as Kilo does for an agent entry, so `"reasoningEffort": "high"` is the same as `"options": { "reasoningEffort": "high" }`.
- Agent settings that are not about the model, such as `prompt`, `steps`, `mode` or `permission`, are left out with a notice. Set those on the agent.

The settings apply only when the ref does. A ref whose model is unavailable leaves the agent's own model and settings. A profile's ref replaces the default's whole entry, settings included, so a profile that sets `"coding": "openai/gpt-6-luna"` drops the settings `defaults.coding` has. An invalid setting is left out with a notice and the rest of the ref still applies.

A fuller example is in [docs/examples/models.jsonc](https://github.com/lunchbox-labs/kilo-model-profiles/blob/main/docs/examples/models.jsonc).

[Profiles](Profiles) covers switching profiles, and [Fallbacks](Fallbacks) what happens when an entry or model can't be used.

## Kilo paths and compatibility

The default models file is `$XDG_CONFIG_HOME/kilo/models.jsonc` (normally `~/.config/kilo/models.jsonc`). `KILO_CONFIG_DIR` overrides the config directory. The `configFile` option accepts absolute paths, paths relative to that directory, and `~/` paths.

Profile selections and provider availability use Kilo's state directory, normally `$XDG_STATE_HOME/kilo` or `~/.local/state/kilo`. If Kilo has selected its sticky data-directory fallback, the plugin uses that same `kilo/state` directory. Auth-provider detection uses `$XDG_DATA_HOME/kilo/auth.json`; catalog detection follows `KILO_MODELS_PATH`, `KILO_MODELS_URL` and Kilo's cache directory. OpenCode environment variables and OpenCode state are not read or migrated.

`build` remains an alias for `code` in agent entries and `builtins`. If both are present, `code` wins. Reports and runtime fallbacks use the canonical `code` name. `builtins.scout` is ignored with a notice unless the host enables scout through `KILO_EXPERIMENTAL_SCOUT` or `KILO_EXPERIMENTAL`, or an explicit scout agent already exists.
