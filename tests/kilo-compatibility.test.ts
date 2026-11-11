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

test("Kilo loader inputs separate provider setups with or without the core catalog", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "kilo-loader-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directories = { data: root, cache: root };
  for (const cached of [false, true]) {
    if (cached) {
      await writeFile(
        path.join(root, "models.json"),
        JSON.stringify({ openai: { env: ["OPENAI_API_KEY"] } }),
      );
    }
    const base = await providerSetupKey({}, {}, directories);
    for (const name of [
      "KILO_API_KEY",
      "KILO_ORG_ID",
      "APERTIS_API_KEY",
      "APERTIS_BASE_URL",
      "AZURE_OPENAI_ENDPOINT",
      "AZURE_OPENAI_RESOURCE_NAME",
      "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME",
      "GOOGLE_VERTEX_PROJECT",
      "GOOGLE_VERTEX_LOCATION",
      "CLOUDFLARE_GATEWAY_ID",
      "CLOUDFLARE_API_KEY",
      "CLOUDFLARE_API_TOKEN",
      "CF_AIG_TOKEN",
      "GITLAB_INSTANCE_URL",
      "GITLAB_TOKEN",
      "AICORE_SERVICE_KEY",
      "AICORE_DEPLOYMENT_ID",
      "AICORE_RESOURCE_GROUP",
      "SNOWFLAKE_ACCOUNT",
      "SNOWFLAKE_CORTEX_TOKEN",
      "SNOWFLAKE_CORTEX_PAT",
    ]) {
      assert.notEqual(
        await providerSetupKey({}, { [name]: "present" }, directories),
        base,
        `${name}, catalog cached: ${cached}`,
      );
    }
    assert.equal(
      await providerSetupKey({}, { KILO_API_KEY: "first-secret" }, directories),
      await providerSetupKey(
        {},
        { KILO_API_KEY: "second-secret" },
        directories,
      ),
      "credential values never enter the setup fingerprint",
    );
  }
});

test("Kilo organization selectors isolate availability and keep credentials out of saved state", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "kilo-org-availability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directories = { data: root, cache: root };
  const {
    availabilityFilePath,
    knownAvailableModels,
    rememberAvailableModels,
  } = await import("../src/fallback.ts");
  const state = path.join(root, "state");
  const directory = path.join(root, "project");
  const personal = await providerSetupKey({}, {}, directories);
  const first = await providerSetupKey(
    {},
    { KILO_ORG_ID: "org-first", KILO_API_KEY: "test-secret" },
    directories,
  );
  const second = await providerSetupKey(
    {},
    { KILO_ORG_ID: "org-second", KILO_API_KEY: "test-secret" },
    directories,
  );
  assert.notEqual(first, second);
  assert.notEqual(first, personal);
  await rememberAvailableModels(
    state,
    directory,
    first,
    new Set(["kilo/first-model"]),
  );
  assert.equal(await knownAvailableModels(state, directory, second), undefined);
  assert.equal(
    await knownAvailableModels(state, directory, personal),
    undefined,
  );
  await rememberAvailableModels(
    state,
    directory,
    second,
    new Set(["kilo/second-model"]),
  );
  assert.deepEqual(
    await knownAvailableModels(state, directory, first),
    new Set(["kilo/first-model"]),
  );
  assert.deepEqual(
    await knownAvailableModels(state, directory, second),
    new Set(["kilo/second-model"]),
  );
  const file = availabilityFilePath(state, directory, first);
  assert.doesNotMatch(
    file + (await readFile(file, "utf8")),
    /org-first|test-secret/,
  );
});

test("Kilo organization fingerprint follows environment, OAuth account and config precedence", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "kilo-org-precedence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directories = { data: root, cache: root };
  const config = (organization: string) => ({
    provider: { kilo: { options: { kilocodeOrganizationId: organization } } },
  });
  const first = await providerSetupKey(config("org-first"), {}, directories);
  assert.notEqual(
    first,
    await providerSetupKey(config("org-second"), {}, directories),
  );
  const environment = { KILO_ORG_ID: "org-env" };
  assert.equal(
    await providerSetupKey(config("org-first"), environment, directories),
    await providerSetupKey(config("org-second"), environment, directories),
  );
  const authFile = path.join(root, "auth.json");
  const auth = (accountId: string, access = "secret") =>
    JSON.stringify({ kilo: { type: "oauth", accountId, access } });
  await writeFile(authFile, auth("org-auth"));
  const authFirst = await providerSetupKey(
    config("org-first"),
    {},
    directories,
  );
  assert.equal(
    authFirst,
    await providerSetupKey(config("org-second"), {}, directories),
  );
  await writeFile(authFile, auth("org-other"));
  assert.notEqual(
    authFirst,
    await providerSetupKey(config("org-first"), {}, directories),
  );
  await writeFile(authFile, auth("org-auth", "rotated-secret"));
  assert.equal(
    authFirst,
    await providerSetupKey(config("org-first"), {}, directories),
  );
  const urlConfig = (organization: string) => ({
    provider: {
      kilo: {
        options: {
          baseURL: `https://example.invalid/api/organizations/${organization}/openrouter`,
        },
      },
    },
  });
  await rm(authFile);
  assert.notEqual(
    await providerSetupKey(urlConfig("org-first"), {}, directories),
    await providerSetupKey(urlConfig("org-second"), {}, directories),
  );
});
