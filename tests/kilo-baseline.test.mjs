import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const lock = JSON.parse(
  await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
);
const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("published package has no Kilo engine gate and retains the Node requirement", () => {
  assert.equal(Object.hasOwn(manifest.engines, "kilo"), false);
  assert.equal(manifest.engines.node, ">=22.18.0");
  assert.equal(Object.hasOwn(lock.packages[""].engines, "kilo"), false);
  assert.equal(lock.packages[""].engines.node, manifest.engines.node);
});

test("SDK and plugin build dependencies share one exact version within the supported host range", async () => {
  const support = JSON.parse(
    await readFile(new URL("./kilo.json", import.meta.url), "utf8"),
  );
  const plugin = manifest.devDependencies["@kilocode/plugin"];
  assert.equal(manifest.devDependencies["@kilocode/sdk"], plugin);
  assert.match(plugin, /^\d+\.\d+\.\d+$/);
  const [major, minor, patch] = plugin.split(".").map(Number);
  const [floorMajor, floorMinor, floorPatch] = support.floor
    .split(".")
    .map(Number);
  assert.equal(`${major}.${minor}.x`, support.range);
  assert.ok(
    major === floorMajor && minor === floorMinor && patch >= floorPatch,
    `${plugin} is below the supported floor ${support.floor}`,
  );
});

test("TUI dev dependencies match the copies every supported Kilo host loads", () => {
  // Kilo 7.8.x maps a plugin's @opentui/* and solid-js imports to its own
  // bundled copies (@opentui 0.5.11 and a patched solid-js 1.9.12). Building
  // against newer releases would let code use APIs no supported host provides.
  // solid-js stays at 1.9.12, the exact peer of @opentui 0.5.11.
  for (const name of ["@opentui/core", "@opentui/keymap", "@opentui/solid"]) {
    assert.equal(manifest.devDependencies[name], "0.5.11", name);
    assert.equal(lock.packages[`node_modules/${name}`].version, "0.5.11", name);
  }
  assert.equal(manifest.devDependencies["solid-js"], "1.9.12");
  assert.equal(lock.packages["node_modules/solid-js"].version, "1.9.12");
});
