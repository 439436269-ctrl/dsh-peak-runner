# Changelog

## 0.1.0 — 2026-10-13

首发。

- `peak_run({ prompts })`：一批 prompt 交给 `deepseek-flash` 执行。平价时段立即跑；峰价时段
  （或距峰价不足 `leadMinutes` 分钟时）排队，到下一个平价时段自动执行。
- `peak_schedule()`：当前档位、下一个切换点、队列状态与定时器排定情况。
- `peak_cancel({ id? })`：取消队列中的待执行任务。
- 时段口径与 `dsh-cost-meter` 对齐：UTC 01:00–04:00、06:00–10:00 为峰段（半开区间），
  周末与法定假日全天平价；`peakWindows` 可配置。
- 队列持久化在 storage domain `peak_runner`（域名须匹配 `/^[a-z][a-z0-9_]*$/`）。
- 推理档默认 `off`（`low` 仍会烧 2000+ 思考 token，见 dsh-ai-arcade 实测）。
- 15 项 `node --test` 全绿；privacy_scan 零命中。
