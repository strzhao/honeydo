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
