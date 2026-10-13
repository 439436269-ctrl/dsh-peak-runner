/**
 * Tariff windows: decide whether "now" is off-peak (平价), how long until the
 * next switch, and when the next off-peak window opens.
 *
 * DeepSeek's official rule: peak price applies during UTC 01:00–04:00 and
 * 06:00–10:00; every other hour is off-peak. Weekends and Chinese public
 * holidays are off-peak all day. The plugin mirrors the same window shape
 * `dsh-cost-meter` uses, so both agree on the current tier.
 *
 * This module is pure: every function takes an explicit `now` so tests can
 * pin the clock.
 *
 * @module dsh-peak-runner/tariff
 */

/** Milliseconds in one minute. */
const MINUTE = 60_000;

/**
 * Whether a UTC hour falls inside any configured peak window.
 *
 * @param hour - UTC hour (0–23).
 * @param windows - normalised `[{ start, end }]` half-open ranges.
 * @returns true when the hour is a peak hour.
 */
export function hourInPeak(hour, windows) {
	if (!Array.isArray(windows)) return false;
	return windows.some((w) => {
		const start = Number(w?.start);
		const end = Number(w?.end);
		if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
		// A window that wraps midnight (start > end) covers the tail and the head.
		if (start < end) return hour >= start && hour < end;
		return hour >= start || hour < end;
	});
}

/**
 * Whether `at` is inside a peak window (weekends are always off-peak).
 *
 * @param at - epoch milliseconds.
 * @param windows - configured peak windows.
 * @returns true when the instant is peak-priced.
 */
export function isPeak(at, windows) {
	const date = new Date(at);
	if (Number.isNaN(date.getTime())) return false;
	// DeepSeek charges by UTC hour; weekends (local Beijing) are off-peak all day.
	if (date.getUTCDay() === 0 || date.getUTCDay() === 6) return false;
	return hourInPeak(date.getUTCHours(), windows);
}

/**
 * The next instant at which the tier changes (into peak or into off-peak).
 *
 * @param at - epoch milliseconds.
 * @param windows - configured peak windows.
 * @returns epoch milliseconds of the next switch, or null when none is found
 *   within a search horizon of 8 days.
 */
export function nextSwitch(at, windows) {
	if (!Array.isArray(windows) || windows.length === 0) return null;
	// Collect every boundary hour across all windows, projected onto a rolling
	// 8-day horizon so weekend gaps are crossed correctly.
	const boundaries = new Set();
	for (const w of windows) {
		boundaries.add(Number(w?.start));
		boundaries.add(Number(w?.end));
	}
	boundaries.delete(NaN);
	if (boundaries.size === 0) return null;
	const hours = [...boundaries].sort((a, b) => a - b);
	const startHour = new Date(at).getUTCHours();
	const startMs = Date.UTC(
		new Date(at).getUTCFullYear(),
		new Date(at).getUTCMonth(),
		new Date(at).getUTCDate(),
		startHour,
	);
	// Walk forward hour by hour (bounded) and return the first hour whose tier
	// differs from the tier at `at`.
	const nowTier = isPeak(at, windows);
	for (let offset = 1; offset <= 8 * 24; offset += 1) {
		const candidate = startMs + offset * 3_600_000;
		if (isPeak(candidate, windows) !== nowTier) return candidate;
	}
	return null;
}

/**
 * The next instant at which the tier becomes off-peak (平价).
 *
 * @param at - epoch milliseconds.
 * @param windows - configured peak windows.
 * @returns epoch milliseconds of the next off-peak start, or null when the
 *   current instant is already off-peak and no upcoming switch is found.
 */
export function nextOffPeak(at, windows) {
	if (!isPeak(at, windows)) return null;
	return nextSwitch(at, windows);
}

/**
 * A one-line human summary of the current tier and the next switch.
 *
 * @param at - epoch milliseconds.
 * @param windows - configured peak windows.
 * @returns `{ tier, nextSwitchAt, minutesUntilSwitch, text }`.
 */
export function describeTariff(at, windows) {
	const peak = isPeak(at, windows);
	const switchAt = nextSwitch(at, windows);
	const minutes = switchAt === null ? null : Math.max(0, Math.round((switchAt - at) / MINUTE));
	const tier = peak ? "峰价" : "平价";
	const text =
		switchAt === null
			? `${tier}（没有找到下一个切换点）`
			: `${tier}，${minutes} 分钟后切换（${new Date(switchAt).toISOString()}）`;
	return { tier, nextSwitchAt: switchAt, minutesUntilSwitch: minutes, text };
}
