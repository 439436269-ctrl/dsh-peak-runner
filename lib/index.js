/**
 * dsh-peak-runner — DeepSeek 峰谷价感知的任务执行器。
 *
 * 平价时段直接跑 deepseek-flash 的任务批；峰价快到时把任务攒进队列，
 * 挂一条自持定时器，到下一个平价时段自动执行完。
 *
 * 接缝：`ctx.llm`（模型调用）+ `ctx.storageDomain`（队列持久化）+
 * `ctx.tools`（工具注册）+ `ctx.systemPrompt`（使用指引）。
 *
 * @module dsh-peak-runner
 */

import z from "@deepseek-ai/schemastery";
import { Config, resolveConfig } from "./config.js";
import { createQueue } from "./queue.js";
import { createToolSpecs } from "./tools.js";
import { guideText } from "./prompt.js";
import { armTimer } from "./scheduler.js";

export const name = "peak-runner";

export const inject = ["llm", "storageDomain", "tools", "systemPrompt"];

export { Config };

/**
 * Mount the plugin.
 *
 * @param ctx - host plugin context.
 * @param config - loader config (defaults are re-resolved here).
 */
export function apply(ctx, config) {
	const settings = resolveConfig(config);
	if (!settings.enabled) {
		console.log("[dsh-peak-runner] disabled by configuration");
		return;
	}

	const queue = createQueue(ctx);

	// The scheduler handle is shared between `apply()` and the tool specs.
	// `armedAt` is the one piece of mutable state the tools read.
	const timer = {
		armedAt: null,
		_dispose: null,
		arm(atMs) {
			this.disarm();
			this.armedAt = atMs;
			this._dispose = armTimer(atMs, () => {
				this.armedAt = null;
				// The timer only wakes the queue; the actual drain happens on the
				// next `peak_run` call (or the next `peak_schedule` read), which
				// keeps model calls inside an explicit tool invocation.
				console.log(`[dsh-peak-runner] off-peak reached at ${new Date(atMs).toISOString()}; queue is ready to drain`);
			});
		},
		disarm() {
			if (typeof this._dispose === "function") this._dispose();
			this._dispose = null;
			this.armedAt = null;
		},
	};

	ctx.effect(() => () => timer.disarm(), "dsh-peak-runner: scheduler timer");

	ctx.systemPrompt.section({
		name: "peak-runner:guide",
		order: 70,
		text: () => guideText(settings),
	});

	for (const spec of createToolSpecs({ ctx, settings, queue, timer })) {
		ctx.tools.register(spec);
	}
}
