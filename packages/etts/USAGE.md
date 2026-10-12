# etts — 免费微软神经 TTS（edge-tts）可脚本化 CLI

## 何时用

- 要**免费、高质量神经 TTS**（微软 Edge 神经音色，324 音色 / ~100 locale），输出 mp3、可批量、可脚本化
- 典型场景：闪卡/词库发音烘焙（多语言批量出 mp3 烘进 `audioRefs`）、朗读素材生成
- 云端付费 TTS（`honeydo tts`，MiniMax）要 API key 且计费；etts 免费，代价是**依赖微软免费端点，随时可能被封锁**（见下「403 风险」）
- 顶层命令：`honeydo etts <subcommand>`（或独立 bin `etts`，同一产物）

## 首次置备

```bash
etts setup      # 探测 python3 → 建 venv → pip 装 edge-tts → 合成探测（403 自动回退修复分支）
etts doctor     # python3 / venv / edge_tts import / voices API 四项自检（不做合成）
```

- venv 在仓外 `~/.etts/venv`（环境变量 `ETTS_RUNTIME` 可覆盖），无重型推理栈
- `setup` 幂等：venv 已存在则复用，重复跑安全
- 无 API key、无凭据存储；代理走 `--proxy <url>` 或环境变量 `ETTS_PROXY`（优先）/ `HTTPS_PROXY`

## 命令面

```bash
etts gen <text> --out <path> [--voice <name>] [--lang <bcp47>] [--gender m|f] [--retry <n>] [--proxy <url>]
etts batch <manifest.jsonl> [--failures <path>] [--skip-existing] [--retry <n>] [--proxy <url>]
etts voices [--lang <prefix>] [--json]
etts setup
etts doctor
```

### gen

```bash
etts gen "こんにちは、世界" --lang ja --out hi.mp3          # 查表：ja → ja-JP-NanamiNeural（女声默认）
etts gen "今日天气好好" --lang zh-HK --gender m --out y.mp3 # 查表：→ zh-HK-WanLungNeural
etts gen "hello" --voice en-US-AndrewMultilingualNeural --out a.mp3   # 点名音色（永远优先）
```

- 音色解析：`--voice` > `--lang` 查默认表（locale 精确 → 主子标签唯一，`ja`→`ja-JP`）→ 都没有则 exit 2
- `--lang zh` 表内命中两个 locale（zh-HK/zh-CN）→ 报歧义错，要求完整 locale
- 表外 locale 用 `etts voices --lang <prefix>` 枚举自选
- 实际所用音色回显在 stderr：`voice: <name> (via lang <locale>, gender <g>)`
- 成功末行 stdout：`Saved to: <绝对路径>`（脚本可 grep）

### batch

manifest JSONL，每行 `{"text", "out", "voice"|"lang", "gender"?}`（voice/lang 至少其一；`#` 注释行与空行跳过）：

```bash
etts batch manifest.jsonl --failures failures.jsonl --skip-existing
```

- 失败行**不中断**其余行；失败清单 JSONL（`index`=0 起物理行号 / `text` / `out` / `voice?` / `error`）
- 有失败 → exit 1（禁静默降级）；`--skip-existing` 跳过已存在（size>0）的产物，skipped 不计失败
- 收尾末行 stdout 单行 JSON：`{"total":n,"ok":n,"skipped":n,"failed":n,"seconds":n}`；逐条进度/重试在 stderr

### voices

```bash
etts voices --lang zh-HK          # 人读对齐表格（ShortName/Gender/Locale）
etts voices --json --lang ja      # 末行单行 JSON 数组（脚本消费）
```

## 默认音色表（15 locale × 女/男，`--lang` 查表用）

| locale | 女（默认） | 男（`--gender m`） |
|---|---|---|
| ja-JP | NanamiNeural | KeitaNeural |
| ko-KR | SunHiNeural | HyunsuMultilingualNeural |
| zh-HK | HiuMaanNeural | WanLungNeural |
| zh-CN | XiaoxiaoNeural | YunyangNeural |
| en-US | AvaMultilingualNeural | AndrewMultilingualNeural |
| en-GB | SoniaNeural | RyanNeural |
| fr-FR | DeniseNeural | RemyMultilingualNeural |
| de-DE | KatjaNeural | FlorianMultilingualNeural |
| es-ES | ElviraNeural | AlvaroNeural |
| it-IT | ElsaNeural | GiuseppeMultilingualNeural |
| ru-RU | SvetlanaNeural | DmitryNeural |
| pt-BR | FranciscaNeural | AntonioNeural |
| th-TH | PremwadeeNeural | NiwatNeural |
| vi-VN | HoaiMyNeural | NamMinhNeural |
| id-ID | GadisNeural | ArdiNeural |

（shortName 全名 = `<locale>-<音色名>`，如 `ja-JP-NanamiNeural`；表外音色仍可 `--voice` 直接点名全表任意音色。）

## 403 风险注记

- edge-tts 走微软免费端点，属违反 MS TOS 的灰色用法；微软历史上周期性封锁（合成 403 / `NoAudioReceived`），社区通常数天~数周内修复，但随时可能再断
- `etts setup` 内置回退：PyPI 版合成探测遇 403 → 自动改装修复分支（PR #491：`git+https://github.com/jonata/edge-tts.git@fix-locale-independent-server-date`）并复测；官方发版后可重跑 setup 回归 PyPI
- 封锁期 batch 不假装成功：失败清单如实带端点错误原文（含 `403` / `NoAudioReceived`），内容侧择期重跑 `--skip-existing` 续传即可
- 规模化正规化路径：Azure TTS F0 免费层（0.5M 字/月，需注册 key）

## 工程契约

- 退出码：0 成功 / 1 运行错误（venv 缺失、合成失败、batch 有失败项）/ 2 参数错误
- 结果 stdout、进度/重试/音色回显 stderr
- 重试：每条 1..`retry` 次尝试（默认 3，指数退避）；失败条目不残留半截产物
- node 壳零运行时依赖；edge_tts 隔离在 `python/etts.py` 薄 seam 后（spawn JSON 协议）

## CI 依赖面（2026-10-13 QA 登记）

- 红队验收测试（`tests/etts.e2e.acceptance.test.ts`）随根 `npm test` 在 CI 执行：runner 将触发 `etts setup` 自置备 + 真机合成（依赖微软端点 + PyPI/GitHub 网络可达）。**403 封锁期 CI 可能转红**（这是封锁信号，不是代码回归）
- 建议：ci.yml 在测试步前加 `npx etts setup` 预置步（同 lmedia 置备步先例，顺带自证网络可达）
