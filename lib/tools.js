/**
 * Tool specs for the peak runner: one factory that closes over the runtime
 * services (queue, runner, scheduler) and returns plain specs for `apply()`.
 *
 * @module dsh-peak-runner/tools
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { describeTariff, isPeak } from "./tariff.js";
import { nextDrainAt, shouldRunNow } from "./scheduler.js";
import { normalizeTask } from "./queue.js";
import { resolveTarget, runPrompt } from "./runner.js";

/** Shared output shape: every tool answers with one text block. */
const OUTPUT = {
	schema: {
		type: "object",
		additionalProperties: false,
		properties: { text: { type: "string", required: true } },
	},
	render: (_args, value) => [{ type: "text", text: value.text }],
};

/** Truncate a long string for the summary line. */
function clip(text, max = 120) {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Build all three tool specs bound to one plugin instance.
 *
 * @param deps - `{ ctx, settings, queue, timer }` where `timer` is the mutable
 *   scheduler handle `{ arm(atMs), disarm(), armedAt }`.
 * @returns the tool specs consumed by `apply()`.
 */
export function createToolSpecs({ ctx, settings, queue, timer }) {
	/** Drain every pending task in order; each one is one model call. */
	async function drain() {
		const tasks = await queue.tasks();
		const pending = tasks.filter((t) => t.status === "pending");
		if (pending.length === 0) return tasks;

		const target = await resolveTarget(ctx, settings);
		if (target === null) {
			throw new Error("no usable provider/model is registered in this harness");
		}

		const running = new Set();
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);
		if (typeof timeout.unref === "function") timeout.unref();

		try {
			for (const task of pending) {
				task.status = "running";
				task.startedAt = Date.now();
				running.add(task.id);
				await queue.put(tasks);

				const outcome = await runPrompt(ctx, {
					prompt: task.prompt,
					provider: target.provider,
					model: target.model,
					maxTokens: settings.maxTokens,
					temperature: settings.temperature,
					reasoningEffort: settings.reasoningEffort,
					signal: controller.signal,
				});

				task.finishedAt = Date.now();
				running.delete(task.id);
				if (outcome.ok) {
					task.status = "done";
					task.result = outcome.text;
				} else {
					task.status = "failed";
					task.error = `${outcome.code}: ${outcome.detail}`;
				}
				await queue.put(tasks);
			}
		} finally {
			clearTimeout(timeout);
		}
		return tasks;
	}

	/** Re-arm the scheduler for the next drain moment (no-op when none). */
	function reschedule() {
		const at = nextDrainAt(Date.now(), settings);
		if (at === null) {
			timer.disarm();
			return null;
		}
		timer.arm(at);
		return at;
	}

	return [
		{
			name: "peak_run",
			description:
				"Run a batch of prompts through deepseek-flash. During off-peak hours the batch runs immediately; during peak hours (or within leadMinutes of a peak window) it is queued and executed at the next off-peak start. Returns one text block with the per-task outcome.",
			parameters: {
				prompts: {
					type: "array",
					items: { type: "string" },
					required: true,
					description: "The prompts to run; each entry is one independent model call.",
				},
			},
			output: OUTPUT,
			async execute(args) {
				const list = Array.isArray(args?.prompts) ? args.prompts : [];
				const now = Date.now();
				const added = [];
				const tasks = await queue.tasks();
				for (const prompt of list) {
					const task = normalizeTask({ prompt }, now);
					tasks.push(task);
					added.push(task);
				}
				await queue.put(tasks);

				const decision = shouldRunNow(now, settings);
				if (!decision.run) {
					const armedAt = reschedule();
					const eta = armedAt === null ? "（无下一个平价点）" : new Date(armedAt).toISOString();
					return {
						text: [
							`当前${decision.reason === "lead-window" ? "接近峰价" : "峰价"}，${added.length} 个任务已排队，等待平价时段（预计 ${eta}）自动执行。`,
							"用 peak_schedule 查看详情，用 peak_cancel 取消。",
						].join("\n"),
					};
				}

				const finished = await drain();
				const done = finished.filter((t) => t.status === "done").length;
				const failed = finished.filter((t) => t.status === "failed");
				const lines = [
					`平价时段执行完成：${done}/${added.length} 成功。`,
					...finished.slice(-added.length).map((t, i) => {
						const body = t.status === "done" ? t.result ?? "" : t.error ?? "";
						return `${i + 1}. [${t.status}] ${clip(body)}`;
					}),
				];
				if (failed.length > 0) lines.push(`${failed.length} 个任务失败，可用 peak_run 重试。`);
				return { text: lines.join("\n") };
			},
		},
		{
			name: "peak_schedule",
			description:
				"Show the current DeepSeek price tier (off-peak / peak), the next switch instant, and the state of the pending task queue.",
			parameters: {},
			output: OUTPUT,
			async execute() {
				const now = Date.now();
				const tariff = describeTariff(now, settings.peakWindows);
				const tasks = await queue.tasks();
				const pending = tasks.filter((t) => t.status === "pending");
				const done = tasks.filter((t) => t.status === "done");
				const failed = tasks.filter((t) => t.status === "failed");
				const armedAt = timer.armedAt;
				return {
					text: [
						`当前档位：${tariff.text}`,
						`队列：${pending.length} 待执行 / ${done.length} 已完成 / ${failed.length} 失败`,
						armedAt === null ? "定时器：未排定" : `定时器：已排定 ${new Date(armedAt).toISOString()}`,
					].join("\n"),
				};
			},
		},
		{
			name: "peak_cancel",
			description:
				"Cancel pending tasks in the queue (by id, or all pending tasks when no id is given). Already-finished tasks are not affected.",
			parameters: {
				id: {
					type: "string",
					description: "Task id to cancel; omit to cancel every pending task.",
				},
			},
			output: OUTPUT,
			async execute(args) {
				const id = typeof args?.id === "string" ? args.id.trim() : "";
				const tasks = await queue.tasks();
				let cancelled = 0;
				for (const task of tasks) {
					if (task.status !== "pending") continue;
					if (id !== "" && task.id !== id) continue;
					task.status = "cancelled";
					task.finishedAt = Date.now();
					cancelled += 1;
				}
				await queue.put(tasks);
				if (cancelled === 0) return { text: "没有匹配的待执行任务被取消。" };
				reschedule();
				return { text: `已取消 ${cancelled} 个待执行任务。` };
			},
		},
	].map((spec) =>
		defineTool({
			...spec,
			presentCall: (args) => ({
				card: "generic",
				title: spec.name,
				kind: "execute",
				detail: args?.id ?? (Array.isArray(args?.prompts) ? `${args.prompts.length} prompts` : ""),
			}),
		}),
	);
}
