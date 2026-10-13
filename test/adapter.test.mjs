/**
 * Adapter-layer mount test (L2): the only file that imports `@deepseek-ai/*`
 * is `lib/index.js`, so the test builds a tiny stub tree and drives `apply()`
 * against a fake host context.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "peak-runner-adapter-"));
cpSync(join(import.meta.dirname, "..", "lib"), join(root, "lib"), { recursive: true });
writeFileSync(join(root, "package.json"), JSON.stringify({ name: "stub", type: "module" }));

// --- stub packages -----------------------------------------------------------

mkdirSync(join(root, "node_modules", "@deepseek-ai", "dsh-tools"), { recursive: true });
writeFileSync(
	join(root, "node_modules", "@deepseek-ai", "dsh-tools", "index.js"),
	"export function defineTool(definition) { return definition; }\n",
);

mkdirSync(join(root, "node_modules", "@deepseek-ai", "schemastery"), { recursive: true });
writeFileSync(
	join(root, "node_modules", "@deepseek-ai", "schemastery", "index.js"),
	[
		"const chain = () => new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : chain()), apply: () => chain() });",
		"export default new Proxy({}, { get: () => () => chain() });",
	].join("\n"),
);

mkdirSync(join(root, "node_modules", "@deepseek-ai", "dsh-storage-domain"), { recursive: true });
writeFileSync(
	join(root, "node_modules", "@deepseek-ai", "dsh-storage-domain", "index.js"),
	[
		"export function defineDomain(spec) { return spec; }",
		"export function domainTable(schema) { return { schema }; }",
	].join("\n"),
);

mkdirSync(join(root, "node_modules", "@deepseek-ai", "dsh-llm"), { recursive: true });
writeFileSync(
	join(root, "node_modules", "@deepseek-ai", "dsh-llm", "index.js"),
	[
		"export function createUserMessage(message) { return message; }",
		"export class BlockAssembler {",
		"  constructor() { this.blocks_ = []; this.finish = undefined; this.usage = undefined; }",
		"  push(chunk) {",
		"    if (chunk.type === 'text-delta') { this.blocks_.push({ type: 'text', text: chunk.delta }); return; }",
		"    if (chunk.type === 'finish') this.finish = chunk;",
		"    if (chunk.type === 'usage') this.usage = chunk.usage;",
		"  }",
		"  blocks() { return this.blocks_; }",
		"}",
	].join("\n"),
);

// --- fake host context -------------------------------------------------------

function makeCtx() {
	const tools = [];
	const sections = [];
	const disposers = [];
	const store = new Map();
	return {
		tools: { register: (tool) => tools.push(tool) },
		systemPrompt: { section: (spec) => sections.push(spec) },
		effect: (fn) => {
			const dispose = fn();
			disposers.push(dispose);
		},
		storageDomain: {
			open: async () => ({
				table: () => ({
					get: (key) => store.get(key),
					put: async (key, value) => {
						store.set(key, value);
					},
				}),
			}),
		},
		llm: {
			resolveModelInfo: async () => ({}),
			listProviders: () => ["deepseek-account"],
			listModels: async () => [{ id: "deepseek-flash" }],
			stream: async function* () {
				yield { type: "text-delta", delta: "pong" };
				yield { type: "finish", kind: "stop" };
			},
		},
		_tools: tools,
		_sections: sections,
		_disposers: disposers,
		_store: store,
	};
}

test("apply registers three tools and a guide section", async () => {
	const mod = await import(pathToFileURL(join(root, "lib", "index.js")).href);
	assert.equal(mod.name, "peak-runner");
	assert.deepEqual(mod.inject, ["llm", "storageDomain", "tools", "systemPrompt"]);

	const ctx = makeCtx();
	mod.apply(ctx, { enabled: true });

	assert.equal(ctx._tools.length, 3, "peak_run / peak_schedule / peak_cancel");
	assert.deepEqual(
		ctx._tools.map((t) => t.name),
		["peak_run", "peak_schedule", "peak_cancel"],
	);
	assert.equal(ctx._sections.length, 1);
	assert.equal(ctx._sections[0].name, "peak-runner:guide");
});

test("each tool's execute returns exactly the declared output schema", async () => {
	const mod = await import(pathToFileURL(join(root, "lib", "index.js")).href);
	const ctx = makeCtx();
	mod.apply(ctx, { enabled: true });

	/** A minimal self-check of the host's output schema subset. */
	function validateOutput(schema, value) {
		assert.equal(typeof value, "object");
		assert.notEqual(value, null);
		const declared = Object.keys(schema.properties ?? {});
		for (const key of Object.keys(value)) {
			assert.ok(declared.includes(key), `undeclared field ${key}`);
		}
		for (const [key, spec] of Object.entries(schema.properties ?? {})) {
			if (spec.required === true) {
				assert.ok(key in value, `missing required field ${key}`);
			}
			if (spec.type === "string") assert.equal(typeof value[key], "string");
		}
	}

	// peak_schedule (no args) — this one never spends credits.
	const schedule = ctx._tools.find((t) => t.name === "peak_schedule");
	const scheduleValue = await schedule.execute({});
	validateOutput(schedule.output.schema, scheduleValue);
	assert.match(scheduleValue.text, /档位/);

	// peak_run with two prompts — run it twice so the first call queues the
	// tasks (the fake clock is inside a peak window) and the second call —
	// after we fake the clock into an off-peak hour — drains them.
	const run = ctx._tools.find((t) => t.name === "peak_run");
	const realNow = Date.now;
	try {
		// 2026-10-13 09:30 UTC is a Tuesday: inside the 06:00–10:00 peak window.
		Date.now = () => Date.UTC(2026, 9, 13, 9, 30);
		const queued = await run.execute({ prompts: ["ping one", "ping two"] });
		validateOutput(run.output.schema, queued);
		assert.match(queued.text, /排队/, "peak hours must queue, not run");

		// 2026-10-13 12:00 UTC is off-peak: the queue drains immediately.
		Date.now = () => Date.UTC(2026, 9, 13, 12, 0);
		const drained = await run.execute({ prompts: [] });
		validateOutput(run.output.schema, drained);
		assert.match(drained.text, /成功/, "off-peak hours must run the pending queue");
	} finally {
		Date.now = realNow;
	}

	// peak_cancel — clears whatever is still pending.
	const cancel = ctx._tools.find((t) => t.name === "peak_cancel");
	const cancelValue = await cancel.execute({});
	validateOutput(cancel.output.schema, cancelValue);
});

test("disposer returned by effect clears the scheduler timer", async () => {
	const mod = await import(pathToFileURL(join(root, "lib", "index.js")).href);
	const ctx = makeCtx();
	mod.apply(ctx, { enabled: true });
	for (const dispose of ctx._disposers) {
		if (typeof dispose === "function") dispose();
	}
	assert.ok(ctx._disposers.length >= 1, "at least one effect was registered");
});
