# Decisions

### [2026-09-18] gcli quota 染色阈值与色值对齐 statusline-sage
<!-- tags: gcli, quota, color, design-system -->
**Background**: gcli provider picker 需要按用量给 quota 上色（快用完显红），用户明确要求与 statusline-sage 观感统一。
**Choice**: 阈值照搬 statusline-sage（≥85 朱红 / ≥60 琥珀 / else 苔绿），色值直接用其 Sage truecolor 三色（#D94F3D/#D4920A/#3A7D68）；每个窗口（5h/wk）独立判定。
**Alternatives rejected**: ANSI 16 色语义色（31/33/32）——随终端主题自适应但与 statusline 观感割裂；因用户终端已验证 truecolor（statusline-sage 正在用）而落选。
**Trade-offs**: 固定 RGB 在浅色终端主题下对比度未验证；色彩决策单点在 `levelColor`，未来可一处切换。

### [2026-09-27] gcli picker 会话数统计口径：ps argv 归属 + 缺口诚实提示
<!-- tags: gcli, picker, session, process-scan, design -->
**Background**: picker 要展示每套餐活跃 session 数；gcli/cc-switch 均无 session 追踪，需选定数据源。
**Choice**: `pgrep -x claude` + `ps -ww -o command=` 扫全机，argv 抽 `--settings` JSON，按 **baseURL 全等 ∧（authToken∨apiKey 非空全等）** 归属到 cc-switch 套餐（同域异 token 靠 token 区分，本机存在双 GLM 套餐实据）；裸 claude（provider 是 spawn 时 settings.json 快照，`ps -E` 已验证不可考）不计入、picker 末行 dim 提示「另有 N 个未归属」。token 仅内存比对永不打印（专项防泄漏断言）。
**Alternatives rejected**: gcli 自写 session 注册表（被 ps 扫描压制：同样不覆盖裸 claude 还多一套状态/残留清理）；裸会话粗归 is_current（切套餐即算错，误导）。
**Trade-offs**: 已知边界——`pgrep -x` 对 node-script 形态安装的 claude（npm i -g）静默假零（本机原生二进制不受影响）；生产 pgrep/ps 编排函数无自动化测试（真实机 PTY e2e 人工证据覆盖），后续可抽纯函数补测 + `ps -ax` 兜底。
