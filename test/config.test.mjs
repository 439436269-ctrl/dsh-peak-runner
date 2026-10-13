/**
 * Config normalisation unit tests.
 *
 * `lib/config.js` imports `@deepseek-ai/schemastery`, which is not installed
 * in the bare source tree (the host resolves it through the profile's hoisted
 * layout). The tests therefore load the module through a tiny stub for that
 * one package; the logic under test (`resolveConfig` / `DEFAULTS`) never
 * touches the schema object at runtime.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "peak-runner-config-"));
cpSync(join(import.meta.dirname, "..", "lib"), join(root, "lib"), { recursive: true });
mkdirSync(join(root, "node_modules", "@deepseek-ai", "schemastery"), { recursive: true });
writeFileSync(
	join(root, "node_modules", "@deepseek-ai", "schemastery", "index.js"),
	[
		"const chain = () => new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : chain()), apply: () => chain() });",
		"export default new Proxy({}, { get: () => () => chain() });",
	].join("\n"),
);
writeFileSync(join(root, "package.json"), JSON.stringify({ name: "stub", type: "module" }));

const { DEFAULTS, resolveConfig } = await import(pathToFileURL(join(root, "lib", "config.js")).href);

test("resolveConfig fills defaults from an empty object", () => {
	const settings = resolveConfig({});
	assert.equal(settings.enabled, true);
	assert.equal(settings.provider, DEFAULTS.provider);
	assert.equal(settings.model, DEFAULTS.model);
	assert.equal(settings.leadMinutes, DEFAULTS.leadMinutes);
	assert.equal(settings.reasoningEffort, "off");
	assert.equal(settings.maxTokens, DEFAULTS.maxTokens);
	assert.equal(settings.timeoutMs, DEFAULTS.timeoutMs);
	assert.deepEqual(settings.peakWindows, DEFAULTS.peakWindows);
});

test("resolveConfig clamps out-of-range numbers", () => {
	const settings = resolveConfig({ leadMinutes: 9999, maxTokens: -5, timeoutMs: 0, temperature: 9 });
	assert.equal(settings.leadMinutes, 120, "leadMinutes is clamped to 120");
	assert.equal(settings.maxTokens, DEFAULTS.maxTokens, "maxTokens falls back when not positive");
	assert.equal(settings.timeoutMs, DEFAULTS.timeoutMs, "timeoutMs falls back when not positive");
	assert.equal(settings.temperature, 2, "temperature is clamped to 2");
});

test("resolveConfig rejects unknown reasoning efforts", () => {
	const settings = resolveConfig({ reasoningEffort: "turbo" });
	assert.equal(settings.reasoningEffort, "off", "falls back to the default");
});

test("resolveConfig normalises malformed peak windows", () => {
	const settings = resolveConfig({ peakWindows: [{ start: 25, end: -1 }, null, { start: 1, end: 4 }] });
	assert.deepEqual(settings.peakWindows, [{ start: 23, end: 1 }, { start: 1, end: 4 }]);
});

test("resolveConfig trims provider and model", () => {
	const settings = resolveConfig({ provider: "  deepseek-account  ", model: " deepseek-flash " });
	assert.equal(settings.provider, "deepseek-account");
	assert.equal(settings.model, "deepseek-flash");
});
