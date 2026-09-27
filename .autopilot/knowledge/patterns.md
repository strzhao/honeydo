# Patterns

### [2026-09-18] TUI 行内多段染色的 ANSI 复位纪律
<!-- tags: ansi, tui, terminal, rendering -->
**Scenario**: 终端单行内需要多段异色文本 + 选中行整行背景色共存时。
**Lesson**: 段与段之间用「关单项属性」码（`\x1b[39m` 关前景、`\x1b[22m` 关粗体/暗度）衔接而非 `\x1b[0m` 全复位——全复位会抹掉行首设置的背景色；整行最后一个段才用 `RESET_ALL + \x1b[K`（清行用默认背景，避免残影）。NO_COLOR 降级时渲染层零 ANSI，但重绘控制码（光标移动/清行）属控制非颜色，可保留。
**Evidence**: gcli picker 渲染（cli.ts `FG_OFF`/`INTENSITY_OFF` 常量注释）；qa-reviewer Section B 将其列为 Strength（无背景泄漏/无残影）。

### [2026-09-18] 蓝红并行前在设计文档显式声明测试 seam
<!-- tags: testing, parallel-agents, red-team, design -->
**Scenario**: 编排器并行启动实现者与验证者 agent，验证者只能从设计文档推导被测接口。
**Lesson**: 设计文档必须列「导出面清单」（哪些函数/export 供测试驱动），否则红队会 import 一个实现未导出的函数，其集成测试整体卡在同一 seam 上（表面是 11 个失败，根因是 1 个缺失的 `export`）；修复应开实现侧 seam（一行 export）而非改红队测试。
**Evidence**: 本次红队 picker-render 11 用例全卡 `pickProviderInteractive is not a function`，蓝队补 export 后 10/11 立即转绿（剩 1 个为断言推导错误）。

### [2026-09-27] TUI 帧级数据走 entries 字段而非位置参数（mock 边界存活）
<!-- tags: tui, testing, rendering, design -->
**Scenario**: 给纯渲染函数/其生产 wrapper 增加帧级（非行级）数据（如全帧共用的统计数），且仓内存在规范化的调用方 mock 模板。
**Lesson**: 帧级数据若走位置参数，会在「仓内规范 mock 只转发旧签名」的边界被静默丢弃（集成测试全绿但真实链路缺数据）；双通道最稳——entries 携带兜底 + 位置参数优先覆盖。新增位置参数必须在设计文档 seam 清单声明，否则 mock 模板不会跟着转发。
**Evidence**: 红队集成 2 用例红：`unattributed` 位置第三参在 picker-render 两参 mock（:150-165）被丢；蓝队改 `PickerEntry.unattributed?` entries 兜底 + 位置参数优先后 28/28 转绿。

### [2026-09-27] autopilot tree_sig 复算必须与加锁时同 cwd（repo root）
<!-- tags: autopilot, qa, tooling -->
**Scenario**: QA Tier 1 沿用蓝队自检前要做 tree_sig 新鲜度复核。
**Lesson**: `tree_sig()` 对 diff/未跟踪文件列表做 `[ -f "$f" ]` 存在性检查——路径是 git 根相对形式，从子目录跑会把根相对路径全判不存在、只哈希子目录相对路径，得出完全不同的 sig（勿误判为代码漂移）。同时它按设计**跳过所有测试文件**（`*.test.*`/`*.acceptance.*`/staging），测试文件改动不需要重锁 sig；非测试文件（如 state/artifacts md）若未跟踪入 diff 也会进哈希，以 repo root 为唯一复算基准。
**Evidence**: 同一工作树从 packages/gcli 复算得 `efdbfde4…`（恰与上一任务历史值同形误导），从 repo root 复算得 `45e1c202…` 与蓝队锁值一致。
