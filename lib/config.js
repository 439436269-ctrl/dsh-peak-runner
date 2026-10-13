/**
 * Plugin configuration: the schema the host validates against, the code-side
 * defaults (so a direct `apply()` call works without the loader), and the
 * normalisation of every knob.
 *
 * The Cordis loader applies `Config` defaults, but `apply` is also reachable
 * through direct construction (tests, tooling), so this module resolves its own
 * defaults instead of trusting the caller.
 *
 * @module dsh-peak-runner/config
 */

import z from "@deepseek-ai/schemastery";

/** Reasoning efforts the DeepSeek adapter advertises. */
const EFFORTS = ["off", "low", "high", "max"];

/** Code-side defaults, mirrored by the `Config` schema below. */
export const DEFAULTS = Object.freeze({
	enabled: true,
	provider: "deepseek-account",
	model: "deepseek-flash",
	// DeepSeek 官方按 UTC 峰段收费：01:00–04:00、06:00–10:00 为峰时价，其余为平价。
	// 周末与法定假日全天平价（与 dsh-cost-meter 的口径一致）。
	peakWindows: [
		{ start: 1, end: 4 },
		{ start: 6, end: 10 },
	],
	// 峰价开始前多少分钟停止执行新任务、把任务攒进队列等平价。
	leadMinutes: 10,
	reasoningEffort: "off",
	maxTokens: 2048,
	timeoutMs: 45_000,
	temperature: 0.7,
});

export const Config = z.object({
	/** Master switch; `false` registers no tools and runs nothing. */
	enabled: z.boolean().default(DEFAULTS.enabled),
	/** Provider id for the batch runner (empty = auto-pick the first usable one). */
	provider: z.string().default(DEFAULTS.provider),
	/** Model id for the batch runner. */
	model: z.string().default(DEFAULTS.model),
	/** Peak (UTC hour) windows: `[start, end)` half-open ranges. */
	peakWindows: z
		.array(
			z.object({
				start: z.number().min(0).max(23),
				end: z.number().min(1).max(24),
			}),
		)
		.default(DEFAULTS.peakWindows),
	/** How many minutes before a peak window to stop running and start queueing. */
	leadMinutes: z.number().min(0).max(120).default(DEFAULTS.leadMinutes),
	/** Reasoning budget per call: `off`, `low`, `high` or `max`. */
	reasoningEffort: z.string().default(DEFAULTS.reasoningEffort),
	/** Output cap per call. */
	maxTokens: z.natural().default(DEFAULTS.maxTokens),
	/** Hard ceiling on one call; the queue marks the task failed instead of hanging. */
	timeoutMs: z.natural().default(DEFAULTS.timeoutMs),
	/** Sampling temperature. */
	temperature: z.number().default(DEFAULTS.temperature),
});

/**
 * A finite number clamped into `[min, max]`, or `fallback`.
 *
 * @param value - raw configured value.
 * @param min - lower bound.
 * @param max - upper bound.
 * @param fallback - value used otherwise.
 * @returns the resolved number.
 */
function clampNumber(value, min, max, fallback) {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.min(max, Math.max(min, number));
}

/**
 * A positive integer, or `fallback`.
 *
 * @param value - raw configured value.
 * @param fallback - value used otherwise.
 * @returns the resolved integer.
 */
function positiveInteger(value, fallback) {
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

/**
 * One of `allowed`, or `fallback` when the value is absent/unknown.
 *
 * @param value - raw configured value.
 * @param allowed - accepted strings.
 * @param fallback - value used otherwise.
 * @returns the resolved string.
 */
function pick(value, allowed, fallback) {
	return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

/**
 * Normalise the peak-window list: only keep well-formed half-open ranges.
 *
 * @param raw - raw configured windows.
 * @returns a fresh normalised list.
 */
function windows(raw) {
	if (!Array.isArray(raw)) return DEFAULTS.peakWindows.map((w) => ({ ...w }));
	return raw
		.filter((w) => w && typeof w === "object")
		.map((w) => ({
			start: Math.min(23, Math.max(0, Math.floor(Number(w.start)))),
			end: Math.min(24, Math.max(1, Math.floor(Number(w.end)))),
		}))
		.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end));
}

/**
 * Resolve user configuration into the plain settings object the plugin uses.
 *
 * @param raw - the loader-supplied config (possibly undefined).
 * @returns resolved settings.
 */
export function resolveConfig(raw) {
	const config = raw === null || typeof raw !== "object" ? {} : raw;
	return {
		enabled: config.enabled !== false,
		provider: typeof config.provider === "string" ? config.provider.trim() : DEFAULTS.provider,
		model: typeof config.model === "string" ? config.model.trim() : DEFAULTS.model,
		peakWindows: windows(config.peakWindows),
		leadMinutes: clampNumber(config.leadMinutes, 0, 120, DEFAULTS.leadMinutes),
		reasoningEffort: pick(config.reasoningEffort, EFFORTS, DEFAULTS.reasoningEffort),
		maxTokens: positiveInteger(config.maxTokens, DEFAULTS.maxTokens),
		timeoutMs: positiveInteger(config.timeoutMs, DEFAULTS.timeoutMs),
		temperature: clampNumber(config.temperature, 0, 2, DEFAULTS.temperature),
	};
}
