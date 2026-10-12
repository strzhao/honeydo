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

### [2026-10-13] edge-tts 封锁期回退链：PyPI 探测 → 社区修复分支自动回退
<!-- tags: etts, edge-tts, tts, fallback, setup -->
**Background**: 免费微软神经 TTS（edge-tts）端点被微软周期性封锁（端点级 403），但它是日语+粤语双高质量的唯一免费方案；烘焙场景需要可自愈的置备路径而非人工排障。
**Choice**: `etts setup` 内置回退链——PyPI 最新版装完即做探测合成，遇 403/`NoAudioReceived` 自动改装社区修复分支（封锁对应 PR 的 fork head）并复测，官方发版后重跑 setup 自然回归 PyPI；batch 失败清单如实透传端点错误原文，禁静默降级。多语言默认音色以策展表（每 locale 女声默认+男声默认）内置于纯函数层，`--lang` 查表、显式 `--voice` 最高优先。
**Alternatives rejected**: 完全离线栈（Kokoro 无粤语、sherpa-onnx 无 ja/yue、CosyVoice Mac 部署重且吞吐差）；macOS say 离线兜底引擎（音质机器味，闪卡场景错误语调比没有音频更糟）。
**Trade-offs**: 长期依赖社区猫鼠修复节奏，微软可随时再断；封锁窗口内新语言首烘焙需等修复或手动指定可用分支。
**Evidence**: 2026-10-12 实测：PyPI 7.2.8 合成 403（WebSocket 握手拒绝、0 字节产物）；修复分支合成成功（ja 3.8s / yue 5.3s 有效 MPEG L3 48kbps mp3）；git 主分支不含修复（PR 尚未 merge），必须装 fork head。
