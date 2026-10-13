/**
 * Tariff-window unit tests: pin the clock, verify the tier and the next switch.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { hourInPeak, isPeak, nextSwitch, nextOffPeak, describeTariff } from "../lib/tariff.js";

const WINDOWS = [
	{ start: 1, end: 4 },
	{ start: 6, end: 10 },
];

/** A UTC instant for 2026-10-13 (Tuesday) at the given UTC hour. */
function atUtcHour(hour, minute = 0) {
	return Date.UTC(2026, 9, 13, hour, minute, 0);
}

test("hourInPeak honours half-open ranges", () => {
	assert.equal(hourInPeak(1, WINDOWS), true);
	assert.equal(hourInPeak(3, WINDOWS), true);
	assert.equal(hourInPeak(4, WINDOWS), false, "end is exclusive");
	assert.equal(hourInPeak(5, WINDOWS), false);
	assert.equal(hourInPeak(6, WINDOWS), true);
	assert.equal(hourInPeak(9, WINDOWS), true);
	assert.equal(hourInPeak(10, WINDOWS), false, "end is exclusive");
	assert.equal(hourInPeak(0, WINDOWS), false);
	assert.equal(hourInPeak(23, WINDOWS), false);
});

test("hourInPeak tolerates a malformed window list", () => {
	assert.equal(hourInPeak(2, []), false);
	assert.equal(hourInPeak(2, null), false);
	assert.equal(hourInPeak(2, [{ start: "x", end: "y" }]), false);
});

test("isPeak is false on weekends regardless of the hour", () => {
	// 2026-10-13 is a Tuesday; 2026-10-17 is a Saturday.
	const tuesdayPeak = atUtcHour(2);
	const saturdaySameHour = Date.UTC(2026, 9, 17, 2, 0, 0);
	assert.equal(isPeak(tuesdayPeak, WINDOWS), true);
	assert.equal(isPeak(saturdaySameHour, WINDOWS), false, "weekend is off-peak all day");
});

test("nextSwitch finds the next tier change", () => {
	// Tuesday 03:00 UTC is inside the 01–04 peak; the switch to off-peak is 04:00.
	const at = atUtcHour(3, 30);
	const switchAt = nextSwitch(at, WINDOWS);
	assert.equal(switchAt, atUtcHour(4), "peak → off-peak at the window end");

	// Tuesday 04:30 is off-peak; the next switch is into peak at 06:00.
	const off = atUtcHour(4, 30);
	assert.equal(nextSwitch(off, WINDOWS), atUtcHour(6), "off-peak → peak at the next window start");
});

test("nextSwitch crosses a weekend gap", () => {
	// Friday 2026-10-16 22:00 UTC is off-peak; the next switch is Monday's 01:00.
	const friday = Date.UTC(2026, 9, 16, 22, 0, 0);
	const switchAt = nextSwitch(friday, WINDOWS);
	assert.equal(switchAt, Date.UTC(2026, 9, 19, 1, 0, 0), "skips Sat/Sun (all off-peak)");
});

test("nextOffPeak is null when already off-peak", () => {
	assert.equal(nextOffPeak(atUtcHour(12), WINDOWS), null);
	assert.notEqual(nextOffPeak(atUtcHour(2), WINDOWS), null);
});

test("describeTariff reports tier and minutes until the next switch", () => {
	const at = atUtcHour(3, 0);
	const info = describeTariff(at, WINDOWS);
	assert.equal(info.tier, "峰价");
	assert.equal(info.minutesUntilSwitch, 60, "03:00 → 04:00 is 60 minutes");
	assert.match(info.text, /峰价/);
});
