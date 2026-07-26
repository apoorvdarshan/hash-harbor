import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/hash-harbor.js", import.meta.url));
const packageInfo = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("prints launcher help", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npx hash-harbor install-service/);
  assert.match(result.stdout, /config --port 3210/);
});

test("prints the package version", () => {
  const result = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), packageInfo.version);
});
