# lmedia CLI 使用说明

本地媒体生产 CLI。Apple Silicon 本地推理（Mac Studio M4 Max 128GB），**零 API 成本**，图像模态已生产验证。

> 何时用它：任何「要出图/出视频」的需求——绘本插画、素材图、原型图、角色一致性生产。
> 边界：**图片理解**用 `qwen` CLI（别搞混）；**云端快速单张**可用 `doubao`；本地批量/一致性/免成本生产用 `lmedia`。

## 命令速查

```bash
# 文生图（风格+角色 LoRA 自动叠加、触发词自动注入、可选超分到发布尺寸）
lmedia image gen "午后庭院，小蜜蜂男孩蹲在草地上推红色小汽车" \
  --style lbwatercolor --char pipi --upscale -o page.png

# 参考图编辑（角色一致性最强路径，1+ 张参考图；与 little-bee 生产管线同构）
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

## 运行时约定

- **栈目录解析优先级**：`LMEDIA_RUNTIME` env > `~/.lmedia/runtime` 软链 > 默认 `~/ml/lb-local-gen`
- 栈目录内含：`.venv`（mflux Q8 推理）+ `.venv-train`（diffusers bf16 推理/训练，主力）
- 模型缓存在系统级 `~/.cache/huggingface`（Qwen-Image-2512 / Qwen-Image-Edit-2509，~110GB，勿删）
- LoRA 注册表 `~/.config/lmedia/loras.json`：三项字段语义——`kind`（style 画风 / character 角色 / speed 加速）、`trigger`（prompt 自动注入）、`defaultWeight`

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

## 性能基线（M4 Max 128GB 实测）

| 任务 | 耗时 | 说明 |
|------|------|------|
| 文生图 1664×928 / 20 步 | ~196s | diffusers bf16（比 mflux Q8 快 2.4 倍，主力路径） |
| 参考图编辑 同尺寸 | ~200s + 首次加载 2min | |
| 超分 | ~5s | |
| Lightning 8 步快速档 | ~187s（mflux 路径） | 草稿迭代用 |
| LoRA 训练 768² fp32 | ~47s/step | 角色 1200-1500 步 / 风格 1000 步 |

## 排障 playbook

| 症状 | 原因与解法 |
|------|-----------|
| 下载报 CAS Client Error / xet 错 | Clash TUN 与 xet 不兼容：`HF_HUB_DISABLE_XET=1`；SSL EOF 偶发 → 换 hf-mirror.com 手动下载 |
| 进程 0% CPU 卡死 | HF etag 检查挂代理 → `HF_HUB_OFFLINE=1`（CLI 已内置） |
| 训练被 SIGKILL | fp32 全模型 ~112GB 超内存 → 必须预计算 embeddings 补丁（见栈目录 train/）；fp16 在 MPS 是死路（loss=nan + scaler bug） |
| mflux 挂 LoRA 无效果 | mflux 不吃 diffusers/peft 格式 LoRA（静默失败）→ 用 diffusers 路径（CLI 的 gen 就是） |
| 生图变慢 2 倍+ | GPU 被另一个任务占着（训练/并发生图）——本机 GPU 任务是串行的，别并行 |

## 视频模态接入约定（规划中）

① `python/` 新增 `video-gen.py`（JSON argv 协议，stdout 末行 JSON）→ ② `src/commands/video.ts` 注册 action → ③ `runtime.ts` 加视频模型快照字段。绘本甜点场景：静态页 + 2-3s 首尾帧闭环微动循环。候选本地模型：LTX-Video / Mochi / Wan2.x。

## 维护

- 源码：`~/workspace/lmedia-cli`；改动后 `npm run build && npm link`
- 实测知识与排障实录沉淀在 little-bee memory：`m4max-local-image-gen-stack`
