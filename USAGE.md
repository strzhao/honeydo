# lmedia CLI 使用说明

本地媒体生产 CLI。Apple Silicon 本地推理（Mac Studio M4 Max 128GB），**零 API 成本**，图像模态已生产验证。

> 何时用它：任何「要出图/出视频」的需求——绘本插画、素材图、原型图、角色一致性生产。
> 边界：**图片理解**用 `qwen` CLI（别搞混）；**云端快速单张**可用 `doubao`；本地批量/一致性/免成本生产用 `lmedia`。

## 命令速查

```bash
# 文生图（官方 true CFG 4.0 + 中文负向模板已内置；风格+角色 LoRA 自动叠加、触发词自动注入、可选超分到发布尺寸）
lmedia image gen "午后庭院，小蜜蜂男孩蹲在草地上推红色小汽车" \
  --style lbwatercolor --char pipi --upscale -o page.png

# 快速档草稿（Lightning 8 步蒸馏 LoRA，cfg=1，~1/4 耗时；可叠 LoRA；--fast 4 极速档）
lmedia image gen "午后庭院，小蜜蜂男孩蹲在草地上推红色小汽车" \
  --style lbwatercolor --char pipi --fast --num 2 -o draft.png

# 参考图编辑（Qwen-Image-Edit-2511，角色一致性最强路径，1+ 张参考图；与 little-bee 生产管线同构）
lmedia image edit "保持参考图角色外观完全一致：他在厨房吃蜂蜜面包" \
  --ref refs/pipi.png -o breakfast.png

# 超分（Real-ESRGAN x2 + Lanczos，秒级）
lmedia image upscale in.png out.png --size 2730x1535

# LoRA 注册表
lmedia lora list
lmedia lora add mimi ./mimi.safetensors --kind character --trigger "mimi_cat 橘猫女孩" --weight 1.0

# 环境自检（换机器/长时间不用后先跑）
lmedia doctor
```

## 引导与负向（2026-08 修复，重要行为变化）

历史 bug：`guidance_scale` 参数被 diffusers **静默忽略**（仅对 guidance-distilled 模型生效），且未传 `negative_prompt` 导致 true CFG 从未启用——**修复前所有图都是无引导生成的**，模型真实水平未发挥。现在：

- `image gen` 默认 `true_cfg_scale=4.0` + 官方 2512 中文负向模板（低画质/AI感/肢体畸形等）
- `image edit` 默认 `true_cfg_scale=4.0` + `" "`（官方 Edit-2511 配方）
- `--cfg 1` 退回旧行为（无引导，耗时减半）；`--neg "..."` 覆盖负向，`--neg ""` 清空
- CFG 使每步 2 次前向，20 步耗时约 ×2（364s vs 184s）——质量换时间，出版用默认、快速看效果用 `--cfg 1` 或 `--fast`
- **注意**：风格/角色 LoRA 权重是在无引导下调的，启用 CFG 后若过风格化，先试 `--style-weight 0.7~0.8`

## 运行时约定

- **栈目录解析优先级**：`LMEDIA_RUNTIME` env > `~/.lmedia/runtime` 软链 > 默认 `~/ml/lb-local-gen`
- 栈目录内含：`.venv`（mflux Q8 遗留）+ `.venv-train`（diffusers bf16 推理/训练，主力）
- 模型缓存在系统级 `~/.cache/huggingface`（Qwen-Image-2512 / Qwen-Image-Edit-2511，~150GB，勿删；2509 旧缓存确认不用后可手动删）
- Lightning 蒸馏 LoRA 在栈目录 `loras/`（8 步默认 + 4 步极速，--fast 自动注入）
- LoRA 注册表 `~/.config/limg/loras.json`：三项字段语义——`kind`（style 画风 / character 角色 / speed 加速）、`trigger`（prompt 自动注入）、`defaultWeight`（`lightning` 旧条目为 mflux 遗留，已废弃）

## 绘本插画生产配方（实测沉淀，直接用）

**画风与面部纪律 prompt 模板**（绘本页生产时照抄结构）：
```
lbwatercolor 水彩绘本插画：{场景与动作}。
角色面部严格约束：{角色}圆润脸蛋，超大椭圆形纯黑色亮眼睛（约占面部三分之一，带白色高光点），
淡淡的红晕腮红，笑眯眯小嘴，面部必须简洁平面卡通化，禁止写实鼻子/人中/牙齿/任何写实五官细节。
大面积简洁留白背景，正午柔和阳光，角色有落地接触阴影。
无文字、无汉字、无字母、无数字、无logo、无水印、无标签
```
三条铁律（都是踩坑换来的）：
1. **面部极简明确**——五官越具体越简单，模型自由发挥空间越小（写「超大椭圆纯黑亮眼带高光」，别写「可爱精致的脸」）
2. **留白要明写**——不写「大面积留白」模型会自动填满背景（AI 味来源之一）
3. **角色一致性优先级**：参考图编辑（`image edit --ref`）> 角色 LoRA > 纯文字锚点。出版级产出用前两个

**发布尺寸链路**：1664×928 生成 → `--upscale` 超分 2730×1535（水彩对超分极友好，质量无损，5s）

## 性能基线（M4 Max 128GB 实测，2026-08 校准 · 1664×928 · 进程内耗时，另加每次调用 ~2min 冷加载）

| 任务 | 耗时 | 说明 |
|------|------|------|
| 文生图 20 步 / true CFG 4.0 + 官方负向（新默认，无 LoRA） | ~364s | 官方配方，出版质量档 |
| 同上（双 LoRA 叠加） | ~379s | |
| `--fast` Lightning 8 步（cfg=1） | ~82s | 草稿迭代主力，可叠 LoRA（双 LoRA ~85s） |
| `--fast 4` 极速档 | ~43s | 极速预览 |
| `--cfg 1`（无引导，旧默认行为） | ~184s | 逃生口：要速度不要引导时用 |
| `--num 2`（CFG） | ~722s/2 张 | 批量不省计算时间（MPS 带宽瓶颈），省的是冷加载 |
| `--fast --num 2` | ~168s/2 张 | 快速档批量选图 |
| 参考图编辑 2511 / 20 步 / CFG 4.0（新默认） | ~737s | 官方 40 步配方 1392s，质量优先可上调 |
| 参考图编辑 `--cfg 1` | ~200s | 旧行为逃生口 |
| 超分 | ~5s | |
| LoRA 训练 768² fp32 | ~47s/step | 角色 1200-1500 步 / 风格 1000 步 |

## 排障 playbook

| 症状 | 原因与解法 |
|------|-----------|
| 下载报 CAS Client Error / xet 错 | Clash TUN 与 xet 不兼容：`HF_HUB_DISABLE_XET=1`；SSL EOF 偶发 → 换 hf-mirror.com 手动下载 |
| hf CLI 直连报 "Distant resource..." 且不想走 proxy | hf_hub 1.28 的 curl_cffi 传输层吃 macOS 系统代理，`unset` 不够：`export no_proxy='*' NO_PROXY='*'` + `HF_ENDPOINT=https://hf-mirror.com`（见 scripts/dl-*.sh） |
| 进程 0% CPU 卡死 | HF etag 检查挂代理 → `HF_HUB_OFFLINE=1`（CLI 已内置） |
| 生图不遵循 prompt / 画质发飘 | 2026-08 前的旧版 `guidance_scale` 无效（diffusers 忽略），已修复为 true_cfg_scale + 负向模板；`--fast` 时 cfg=1 属正常（蒸馏） |
| 生成结束但 python 进程不退、内存不还（后续 GPU 任务被杀） | MPS 退出清理偶发挂死（实测一次：旧 edit.py 打印结果后占 ~60GB 不退）。处置：`pkill -9 -f "lmedia-cli/python/(gen\|edit).py"`；跑批脚本见 `scripts/calib-lib.sh` 的清扫模式 |
| 训练被 SIGKILL | fp32 全模型 ~112GB 超内存 → 必须预计算 embeddings 补丁（见栈目录 train/）；fp16 在 MPS 是死路（loss=nan + scaler bug） |
| mflux 挂 LoRA 无效果 | mflux 不吃 diffusers/peft 格式 LoRA（静默失败）→ 用 diffusers 路径（CLI 的 gen 就是；快速档也已迁到 diffusers `--fast`） |
| 生图变慢 2 倍+ | GPU 被另一个任务占着（训练/并发生图/大文件下载抢盘）——本机 GPU 任务是串行的，别并行 |

## 视频模态接入约定（规划中）

① `python/` 新增 `video-gen.py`（JSON argv 协议，stdout 末行 JSON）→ ② `src/commands/video.ts` 注册 action → ③ `runtime.ts` 加视频模型快照字段。绘本甜点场景：静态页 + 2-3s 首尾帧闭环微动循环。候选本地模型：LTX-Video / Mochi / Wan2.x。

## 维护

- 源码：`~/workspace/lmedia-cli`；改动后 `npm run build && npm link`
- 实测知识与排障实录沉淀在 little-bee memory：`m4max-local-image-gen-stack`
