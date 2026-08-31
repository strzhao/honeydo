# patterns

## 新命令输出约定必须对齐既有模态，测试解析器按契约声明的格式写（2026-08-31）

<!-- tags: testing, contract, qa, blind-spot -->

**Why**：本项目 image/video 的 stdout 结果 JSON 是 `JSON.stringify(result, null, 2)` pretty 多行；新 sfx 命令契约声明「对齐 image/video 既有约定」。QA 红队 smoke 却按「单行 JSON」写解析器 → 契约与实现都对，测试必挂。同轮另一处：红队漏传契约必填 `--key` ×6。

**How to apply**：写任何解析 CLI stdout 的测试前，先看契约声明的对齐对象并实测一次真实输出形态；契约未声明的解析假设（单行/多行、挂载层级）一律标 CONTRACT_AMBIGUOUS 而非自行发明。

## ffmpeg fixture 合成用 aevalsrc 精确控幅，禁用 sine 源默认幅度（2026-08-31）

<!-- tags: ffmpeg, fixture, testing -->

**Why**：`-f lavfi -i sine=...` 默认幅度 1/8（≈-18dBFS），阈值类测试（-35/-50dB 两级回退、峰值门限）会全部踩坑。

**How to apply**：`aevalsrc` 显式写幅值（如 `0.4*sin(...)`）；需要「介于两级阈值之间的本底」时按 dB 换算幅值（-40dB ≈ 0.01）。红线：所有 fixture 统一 44.1kHz mono，否则采样率断言必挂。

## stop-hook 状态文件合流会覆写自增章节（2026-08-31）

<!-- tags: autopilot, state, blind-spot -->

**Why**：implement→qa 转换时 stop-hook 重写 state.md，编排器在 implement 阶段自增的章节（如 `## 契约校验`）会被丢弃。

**How to apply**：跨阶段要存活的结论写进 `## 变更日志`（stop-hook 保留追加式区域），或在各阶段转换后检查并恢复；不要假设自定义章节能穿透 transition。

## 红队审计判定要同量纲（2026-08-31）

<!-- tags: testing, mutation-testing -->

**Why**：batch report 审计若拿 winner（snr 口径）对比淘汰池（peak 口径），比较近乎恒真，「取 min(snr) 当 winner」的变异体可存活。

**How to apply**：支配性断言限定在同资格池内（合格池按 snr、全废池按 peak），并对审计函数自身做反向对照（故意破坏数据后必须报违规）防恒真。
