/**
 * Scheduling: when to run the queue.
 *
 * In off-peak hours the queue is drained immediately. As a peak window
 * approaches (within `leadMinutes`), new tasks stop running and the plugin
 * arms a timer for the next off-peak start. The timer is a plain
 * `setTimeout(...).unref()` — the same self-held pattern `dsh-loop` uses —
 * because `ctx.schedule` is an optional facette that is not always mounted.
 *
 * @module dsh-peak-runner/scheduler
 */

import { hourInPeak, nextSwitch } from "./tariff.js";

/** The longest `setTimeout` delay we ever ask Node for (2^31 - 1 ms). */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Should the queue run right now?
 *
 * @param at - epoch milliseconds.
 * @param settings - resolved plugin settings.
 * @returns `{ run: boolean, reason: string, nextRunAt: number|null }`.
 */
export function shouldRunNow(at, settings) {
	// A weekend instant is always off-peak; `isPeak` already handles that.
	// For a weekday we need the *window* tier, not the calendar tier, because
	// the lead window extends the "stop running" zone past the window end.
	const date = new Date(at);
	const weekend = Number.isNaN(date.getTime()) || date.getUTCDay() === 0 || date.getUTCDay() === 6;
	if (weekend) return { run: true, reason: "off-peak", nextRunAt: null };

	if (!hourInPeak(date.getUTCHours(), settings.peakWindows)) {
		return { run: true, reason: "off-peak", nextRunAt: null };
	}

	// Inside a peak window: look for the next switch and see whether the lead
	// window has already swallowed us.
	const switchAt = nextSwitch(at, settings.peakWindows);
	if (switchAt === null) return { run: false, reason: "peak-no-switch-found", nextRunAt: null };

	const leadMs = settings.leadMinutes * 60_000;
	if (at >= switchAt - leadMs) {
		// We are inside the lead window that precedes the switch into off-peak.
		return { run: false, reason: "lead-window", nextRunAt: switchAt };
	}
	// Still early inside a peak window; the next off-peak start is the switch.
	return { run: false, reason: "peak", nextRunAt: switchAt };
}

/**
 * Arm a one-shot timer for `atMs`, clamped to `setTimeout`'s maximum delay.
 *
 * @param atMs - target epoch milliseconds.
 * @param fire - called when the timer elapses.
 * @returns a disposer that clears the timer.
 */
export function armTimer(atMs, fire) {
	const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, atMs - Date.now()));
	const timer = setTimeout(() => {
		fire();
	}, delay);
	if (typeof timer.unref === "function") timer.unref();
	return () => clearTimeout(timer);
}

/**
 * Compute the next time the queue should be drained, whether or not it is
 * currently armed.
 *
 * @param at - epoch milliseconds.
 * @param settings - resolved plugin settings.
 * @returns epoch milliseconds of the next off-peak start, or null when the
 *   queue should just run now.
 */
export function nextDrainAt(at, settings) {
	const decision = shouldRunNow(at, settings);
	if (decision.run) return null;
	return decision.nextRunAt;
}
