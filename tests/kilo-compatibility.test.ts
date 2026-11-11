import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { modelsFilePath } from "../src/apply.ts";
import { providerSetupKey } from "../src/fallback.ts";
import { parseModelsDocument } from "../src/models-file.ts";
import {
  type ModelProfilesReport,
  publishReport,
  readReport,
} from "../src/report.ts";
import { applyModelRefs, restoreOwnSampling } from "../src/resolution.ts";
import {
  cacheDirectory,
  configurationDirectory,
  dataDirectory,
  processProfile,
  stateDirectory,
} from "../src/selection.ts";

test("Kilo directories and profile overrides ignore OpenCode settings", () => {
  const environment = {
    KILO_CONFIG_DIR: path.resolve("/kilo-custom"),
    OPENCODE_CONFIG_DIR: path.resolve("/opencode-custom"),
    KILO_MODEL_PROFILE: " fast ",
    OPENCODE_MODEL_PROFILE: "other",
    XDG_CONFIG_HOME: path.resolve("/config"),
    XDG_STATE_HOME: path.resolve("/state"),
    XDG_DATA_HOME: path.resolve("/data"),
    XDG_CACHE_HOME: path.resolve("/cache"),
  };
  assert.equal(
    configurationDirectory(environment),
    environment.KILO_CONFIG_DIR,
  );
  assert.equal(
    configurationDirectory({ ...environment, KILO_CONFIG_DIR: undefined }),
    path.join(environment.XDG_CONFIG_HOME, "kilo"),
  );
  assert.equal(
    stateDirectory(environment),
    path.join(environment.XDG_STATE_HOME, "kilo"),
  );
  assert.equal(
    dataDirectory(environment),
    path.join(environment.XDG_DATA_HOME, "kilo"),
  );
  assert.equal(
    cacheDirectory(environment),
    path.join(environment.XDG_CACHE_HOME, "kilo"),
  );
  assert.equal(processProfile(environment), "fast");
  assert.equal(processProfile({ OPENCODE_MODEL_PROFILE: "other" }), undefined);
});

test("Kilo XDG paths strip newlines and reject relative overrides", () => {
  assert.equal(
    configurationDirectory({
      XDG_CONFIG_HOME: path.resolve("/config") + "\r\n",
    }),
    path.resolve("/config/kilo"),
  );
  assert.equal(
    dataDirectory({ XDG_DATA_HOME: path.resolve("/data") + "\n" }),
    path.resolve("/data/kilo"),
  );
  assert.equal(
    cacheDirectory({ XDG_CACHE_HOME: path.resolve("/cache") + "\r" }),
    path.resolve("/cache/kilo"),
  );
  assert.equal(
    stateDirectory({ XDG_STATE_HOME: path.resolve("/state") + "\n" }),
    path.resolve("/state/kilo"),
  );
  assert.equal(
    configurationDirectory({ XDG_CONFIG_HOME: "relative" }),
    path.join(homedir().replace(/[\r\n]+/g, ""), ".config", "kilo"),
  );
});

test("Kilo's existing data/state fallback is sticky unless XDG_STATE_HOME is explicit", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "kilo-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fallback = path.join(root, "kilo", "state");
  await mkdir(fallback, { recursive: true });
  assert.equal(stateDirectory({ XDG_DATA_HOME: root }), fallback);
  assert.equal(
    stateDirectory({
      XDG_DATA_HOME: root,
      XDG_STATE_HOME: path.join(root, "explicit"),
    }),
    path.join(root, "explicit", "kilo"),
  );
  assert.notEqual(
    stateDirectory({ XDG_DATA_HOME: root, XDG_STATE_HOME: "relative" }),
    fallback,
  );
});

test("models config expands home paths instead of resolving a literal tilde under config", () => {
  const environment = {
    KILO_CONFIG_DIR: path.resolve("/config/kilo"),
    KILO_TEST_HOME: path.resolve("/test-home"),
  };
  assert.equal(
    modelsFilePath({ configFile: "~/models.jsonc" }, environment),
    path.resolve("/test-home/models.jsonc"),
  );
  assert.equal(
    modelsFilePath({ configFile: "models/extra.jsonc" }, environment),
    path.resolve("/config/kilo/models/extra.jsonc"),
  );
});

test("Kilo built-in agents receive refs and legacy build resolves to code for runtime fallbacks", () => {
  const { document, notices } = parseModelsDocument(
    JSON.stringify({
      defaults: {
        coding: { model: "test/coding", temperature: 0.2 },
        modern: "test/modern",
      },
      builtins: {
        code: "coding",
        debug: "coding",
        ask: "coding",
        orchestrator: "coding",
        scout: "coding",
      },
    }),
    "models.jsonc",
  );
  assert.deepEqual(notices, []);
  const applied = applyModelRefs({}, document, null, undefined, {
    KILO_EXPERIMENTAL_SCOUT: "true",
  });
  for (const name of ["code", "debug", "ask", "orchestrator", "scout"]) {
    assert.equal(
      (applied.agents[name] as { model: string }).model,
      "test/coding",
    );
  }
  const legacy = applyModelRefs(
    { build: { modelRef: "coding", temperature: 0.7 } },
    document,
    null,
  );
  assert.equal(Object.hasOwn(legacy.agents, "build"), false);
  assert.equal(
    legacy.assignments.find((entry) => entry.agent === "code")?.ownTemperature,
    0.7,
  );
  const params = { temperature: 0.2 };
  restoreOwnSampling(legacy.assignments, "code", "test/fallback", params);
  assert.equal(params.temperature, 0.7);
  const alias = parseModelsDocument(
    '{"defaults":{"coding":"test/coding"},"builtins":{"build":"coding"}}',
    "models.jsonc",
  );
  assert.deepEqual(alias.document.builtins, { code: "coding" });
  const explicit = parseModelsDocument(
    '{"builtins":{"code":"modern","build":"coding"}}',
    "models.jsonc",
  );
  assert.deepEqual(explicit.document.builtins, { code: "modern" });
});

test("renamed npm specifiers receive the report consumed by the TUI", async () => {
  const report: ModelProfilesReport = {
    version: 1,
    configFile: "/config/kilo/models.jsonc",
    selectionFile: "/state/kilo/selection.json",
    worktree: "/project",
    profiles: [],
    profile: null,
    profileSource: "none",
    refs: [],
    notices: [],
  };
  for (const specifier of [
    "@lunchbox-labs/kilo-model-profiles",
    "@lunchbox-labs/kilo-model-profiles@0.2.1",
  ]) {
    const config = { plugin: [specifier] };
    assert.equal(publishReport(config, undefined, report), true);
    assert.deepEqual(readReport(config), report);
  }
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { name: string };
  assert.equal(manifest.name, "@lunchbox-labs/kilo-model-profiles");
});

test("provider setup uses KILO_MODELS_PATH and ignores the old override", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "kilo-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const models = path.join(root, "models.json");
  await writeFile(
    models,
    JSON.stringify({ custom: { env: ["CUSTOM_CONNECTION"] } }),
  );
  const directories = { data: root, cache: path.join(root, "cache") };
  const environment = { KILO_MODELS_PATH: models };
  const base = await providerSetupKey({}, environment, directories);
  assert.notEqual(
    await providerSetupKey(
      {},
      { ...environment, CUSTOM_CONNECTION: "present" },
      directories,
    ),
    base,
  );
  assert.equal(
    await providerSetupKey(
      {},
      {
        ...environment,
        IRRELEVANT_TOKEN: "present",
        OPENCODE_MODELS_PATH: "unused",
      },
      directories,
    ),
    base,
  );
});

test("provider setup reads Kilo's source-specific models cache", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "kilo-models-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { createHash } = await import("node:crypto");
  const source = "https://catalog.example.invalid";
  const hash = createHash("sha1").update(source).digest("hex");
  await writeFile(
    path.join(root, `models-${hash}.json`),
    JSON.stringify({ custom: { env: ["CUSTOM_CONNECTION"] } }),
  );
  const environment = { KILO_MODELS_URL: source };
  const directories = { data: root, cache: root };
  assert.notEqual(
    await providerSetupKey({}, environment, directories),
    await providerSetupKey(
      {},
      { ...environment, CUSTOM_CONNECTION: "present" },
      directories,
    ),
  );
});

test("a scout builtin does not create a generic agent when Kilo scout is disabled", () => {
  const { document } = parseModelsDocument(
    '{"defaults":{"search":"test/search"},"builtins":{"scout":"search"}}',
    "models.jsonc",
  );
  const applied = applyModelRefs({}, document, null, undefined, {});
  assert.equal(Object.hasOwn(applied.agents, "scout"), false);
  assert.ok(
    applied.notices.some((notice) =>
      notice.includes("KILO_EXPERIMENTAL_SCOUT"),
    ),
  );
  assert.equal(
    (
      applyModelRefs({}, document, null, undefined, {
        KILO_EXPERIMENTAL_SCOUT: "1",
      }).agents.scout as { model: string }
    ).model,
    "test/search",
  );
});
