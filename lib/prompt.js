/**
 * System prompt: teach the model how to use the peak-runner tools without
 * duplicating the tool descriptions.
 *
 * @module dsh-peak-runner/prompt
 */

import { describeTariff } from "./tariff.js";

/**
 * Build the guide text shown to the model.
 *
 * @param settings - resolved plugin settings.
 * @returns the section text (regenerated on every render so the tier stays live).
 */
export function guideText(settings) {
	const now = describeTariff(Date.now(), settings.peakWindows);
	return [
		`当前 DeepSeek 计价档位：${now.tier}（UTC 峰段 ${settings.peakWindows.map((w) => `${w.start}:00–${w.end}:00`).join("、")}；周末与法定假日全天平价）。`,
		"peak_run 把一批 prompt 交给 deepseek-flash 执行：在平价时段立即执行；在峰价时段（或距峰价不足 leadMinutes 分钟时）自动排队，等下一个平价时段再跑。",
		"peak_schedule 查看当前档位、下一个切换点与队列状态；peak_cancel 取消队列中的任务或已排定的执行。",
	].join("\n");
}
