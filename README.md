# dsh-peak-runner

DeepSeek **峰谷价感知**的任务执行器：平价时段直接跑 `deepseek-flash` 的任务批；峰价快到时把任务攒进队列、挂一条定时器，到下一个平价时段自动执行完。

## 它解决什么问题

DeepSeek 官方按 UTC 时段两档计价：**01:00–04:00、06:00–10:00 为峰时价（约两倍），其余时段平价**；周末与法定假日全天平价。你把一批摘要/翻译/改写任务丢给它，它只在便宜的时候花钱。

与 [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter) 用同一套时段口径，两边对「现在是平价还是峰价」的判断一致。

## 装（正式安装）

```sh
dsh plugin --profile desktop add dsh-peak-runner
```

然后重启 DSH。它插一行进组合，注册三个工具 + 一段系统提示：

| 工具 | 作用 |
|---|---|
| `peak_run({ prompts })` | 一批 prompt 交给 `deepseek-flash` 执行。平价时段立即跑；峰价时段（或距峰价不足 `leadMinutes` 分钟时）排队，等下一个平价时段自动执行 |
| `peak_schedule()` | 查看当前档位、下一个切换点、队列状态与定时器排定情况 |
| `peak_cancel({ id? })` | 取消队列中的待执行任务（不传 id 则取消全部） |

## 配置（profile 补丁层覆盖）

```yaml
- id: dsh-peak-runner
  config:
    enabled: true
    provider: deepseek-account
    model: deepseek-flash
    # 峰段窗口（UTC 小时，半开区间 [start, end)）；默认对齐 DeepSeek 官方口径
    peakWindows:
      - { start: 1, end: 4 }
      - { start: 6, end: 10 }
    # 峰价开始前多少分钟停止执行新任务、开始排队
    leadMinutes: 10
    # 推理档：off 是延迟/成本正确的档位（low 仍可能烧掉 2000+ 思考 token）
    reasoningEffort: "off"
    maxTokens: 2048
    timeoutMs: 45000
```

## 用法

在对话里直接说：

> 帮我把这 5 段文字各写一句摘要：……（然后调 `peak_run`）

或者问：

> 现在是什么档位？队列里还有什么？

## 开发（不装进 profile）

```sh
cd dsh-peak-runner && pnpm install     # 只需 @deepseek-ai/schemastery

DSH='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
$DSH --profile <name> --patch "$PWD/dev.patch.yml" --dump-config | grep peak-runner
$DSH --profile <name> --patch "$PWD/dev.patch.yml" web
```

## 目录

```
lib/index.js         接线（name/inject/Config/apply）
lib/config.js        Config schema + DEFAULTS + resolveConfig
lib/tariff.js        时段计算（窗口表 → 当前档位/下一切换点）
lib/runner.js        模型调用（ctx.llm.stream + reasoning off）
lib/queue.js         任务队列（storage domain 持久化）
lib/scheduler.js     定时触发（自持 timer，不依赖可选的 ctx.schedule）
lib/tools.js         工具注册表
lib/prompt.js        系统提示文案
```

## License

MIT
