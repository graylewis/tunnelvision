import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configExists, DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/config.js";
import { existingConfig, resolvePaths } from "../src/paths.js";

function tmpRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tv-config-"));
}

test("config lives at tunnelvision.json in the project root", () => {
	const paths = resolvePaths(tmpRoot());
	assert.equal(path.basename(paths.config), "tunnelvision.json");
	assert.equal(path.dirname(paths.config), paths.root);
	assert.equal(configExists(paths), false);
	assert.throws(() => loadConfig(paths), /tunnelvision init/);

	saveConfig(paths, { ...DEFAULT_CONFIG, baseUrl: "http://localhost:5173" });
	assert.equal(existingConfig(paths), paths.config);
	assert.equal(loadConfig(paths).baseUrl, "http://localhost:5173");
	// Nothing under .tunnelvision/ is needed for the config alone.
	assert.equal(fs.existsSync(paths.dir), false);
});

test("a legacy .tunnelvision/config.json is read when tunnelvision.json is missing", () => {
	const paths = resolvePaths(tmpRoot());
	fs.mkdirSync(paths.dir, { recursive: true });
	fs.writeFileSync(paths.legacyConfig, JSON.stringify({ baseUrl: "http://localhost:4321", wait: 250 }));
	assert.equal(existingConfig(paths), paths.legacyConfig);
	assert.equal(configExists(paths), true);
	const config = loadConfig(paths);
	assert.equal(config.baseUrl, "http://localhost:4321");
	assert.equal(config.wait, 250);
	assert.equal(config.settle, DEFAULT_CONFIG.settle);

	// Once the root file exists it wins.
	saveConfig(paths, { ...config, baseUrl: "http://localhost:3000" });
	assert.equal(existingConfig(paths), paths.config);
	assert.equal(loadConfig(paths).baseUrl, "http://localhost:3000");
});
