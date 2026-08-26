# lmedia-cli

本地媒体生产 CLI — Apple Silicon 本地推理，零 API 成本。对标 `qwen`（视觉理解）/ `doubao`（云端生图）的姊妹工具，走**本地**路线。

## 定位

统一承载「本地媒体生产能力」，按模态分子树：

| 子树 | 状态 | 能力 |
|------|------|------|
| `lmedia image` | ✅ 就绪 | 文生图（Qwen-Image-2512 bf16 + true CFG + LoRA 叠加）、参考图编辑（Qwen-Image-Edit-2511，角色一致性最强路径）、Lightning 蒸馏快速档（`--fast`）、批量出图（`--num`）、Real-ESRGAN 超分 |
| `lmedia video` | 🚧 预留 | 接入指南见 `src/commands/video.ts` |
| `lmedia lora` | ✅ | LoRA 注册表（风格/角色/加速三类，含触发词与默认权重） |
| `lmedia doctor` | ✅ | 环境自检 |

## 安装

```bash
cd ~/workspace/lmedia-cli && npm install && npm run build && npm link
```

前置：本地生成栈目录（默认 `~/ml/lb-local-gen`，含 `.venv`/`.venv-train` 两个 Python venv 与 HF 模型缓存）。自定义位置：`export LMEDIA_RUNTIME=<栈目录>` 或 `ln -s <栈目录> ~/.lmedia/runtime`。

## 用法

```bash
# 文生图（官方 true CFG 4.0 + 中文负向模板；风格 + 角色 LoRA 自动叠加、触发词自动注入、超分）
lmedia image gen "一只小蜜蜂男孩在花园里追蝴蝶" --style lbwatercolor --char pipi --upscale -o out.png

# 快速档（Lightning 8 步蒸馏，~1/4 耗时，草稿迭代；可叠 LoRA、批量）
lmedia image gen "一只小蜜蜂男孩在花园里追蝴蝶" --style lbwatercolor --char pipi --fast --num 2 -o draft.png

# 参考图编辑（Qwen-Image-Edit-2511，1+ 张参考图锁角色，与 little-bee 生产管线同构）
lmedia image edit "让他在厨房吃早餐" --ref refs/pipi.png -o breakfast.png

# 超分到发布尺寸
lmedia image upscale in.png out.png --size 2730x1535

# LoRA 注册表
lmedia lora list
lmedia lora add mimi ./mimi.safetensors --kind character --trigger "mimi_cat 小橘猫女孩" --weight 1.0

# 自检
lmedia doctor
```

## 性能基线（M4 Max 128GB 实测，2026-08 校准 · 1664×928 · 另加每次调用 ~2min 冷加载）

| 任务 | 耗时 |
|------|------|
| 文生图 20 步 true CFG 4.0 + 官方负向（默认） | ~364s（双 LoRA ~379s） |
| `--fast` Lightning 8 步 | ~82s（双 LoRA ~85s）；`--fast 4` ~43s |
| `--cfg 1`（无引导旧行为） | ~184s |
| 参考图编辑 2511 / 20 步 / CFG 4.0 | ~737s（40 步官方配方 1392s；`--cfg 1` ~200s） |
| `--fast --num 2` 批量 | ~168s/2 张（批量省冷加载，不省计算） |
| 超分到 2730×1535 | ~5s |
| 角色/风格 LoRA 训练（768² fp32） | ~47s/step（训练命令暂未封装，见 `~/ml/lb-local-gen/train-*.sh`） |

## 架构

```
src/commands/   image.ts（gen/edit/upscale）· video.ts（预留）· lora.ts · doctor.ts
src/lib/        runtime.ts（venv/模型快照解析）· registry.ts（LoRA 注册表）· run-python.ts
python/         gen.py · edit.py · upscale.py（JSON argv 协议，stdout 末行 JSON 回传）
```

LoRA 注册表：`~/.config/limg/loras.json`（首次运行自动播种 lbwatercolor / pipi / lightning2512 三项；`lightning` 旧条目为 mflux 遗留，已废弃）。

## 给视频能力的预留约定

新模态接入三步：① `python/` 加 `video-*.py` 驱动（复用 JSON 协议）② `src/commands/video.ts` 注册 action ③ `runtime.ts` 加模型快照字段。绘本场景的甜点用法：现有静态页 + 2-3s 首尾帧闭环微动循环。
