# ROADMAP

## v0.2 — 产品化

- [ ] 统一配置：`~/.config/honeydo/config.json` + env 覆盖，一个 `honeydo config set/get` 入口（现状：各能力包独立 env）
- [ ] 全局 `--json` 规范（现状：qwen ask/vision 有，lmedia 部分命令原生 JSON，doubao/minimax 靠 "Saved to:" 末行约定）
- [ ] `honeydo ask` 的 `--backend local` 与 gcli api 后端融合（OpenAI 协议直连，不再经 qwen 包）
- [ ] 旧 bin 下线计划：little-bee 等调用方迁移到 honeydo 命令后，gcli/lmedia/doubao/minimax bin 打印 deprecation，再下个大版本移除

## v0.3 — 本地栈体验

- [ ] `honeydo image setup`：图像栈一键安装（venv + Qwen-Image-2512/Edit-2511 权重 + Real-ESRGAN，现状只有 video/sfx 有 setup，图像栈靠 doctor 文档引导）
- [ ] LoRA 公共源：`lora add` 支持 HF repo 直接登记（lightning 加速 LoRA 一行安装）
- [ ] doctor 输出 `--json` + 修复建议可执行化

## v1.0 — 传播

- [ ] i18n（CLI 内文案目前中文为主）
- [ ] brew tap（homebrew-honeydo）
- [ ] demo GIF × 3（image gen / tts / ask）
- [ ] awesome-claude-code 收录、HN/Reddit/V2EX/即刻投稿
