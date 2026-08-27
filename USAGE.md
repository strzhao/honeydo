# lmedia CLI 使用说明

本地媒体生产 CLI。Apple Silicon 本地推理（Mac Studio M4 Max 128GB），**零 API 成本**，图像/视频双模态。

> 何时用它：任何「要出图/出视频」的需求——绘本插画、素材图、原型图、角色一致性生产、绘本页微动视频。
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

# 视频生成（本地 MiniMax-H3 / mmh3turbo；首次用前先 lmedia video setup）
lmedia video gen "水彩绘本风格：小蜜蜂男孩在花园里挥手，花瓣缓缓飘落，镜头缓慢推近，细节丰富" -r 480p -o scene.mp4
lmedia video gen "角色轻轻挥手" --first-frame page.png -r 352p -o page-motion.mp4   # 绘本页微动（图生视频）

# LoRA 注册表
lmedia lora list
lmedia lora add mimi ./mimi.safetensors --kind character --trigger "mimi_cat 橘猫女孩" --weight 1.0

# 环境自检（换机器/长时间不用后先跑）
lmedia doctor
```

## 运行时约定

- **栈目录解析优先级**：`LMEDIA_RUNTIME` env > `~/.lmedia/runtime` 软链 > 默认 `~/ml/lb-local-gen`
- 栈目录内含：`.venv`（mflux Q8 推理）+ `.venv-train`（diffusers bf16 推理/训练，主力）+ `.venv-video`（mmh3turbo，MiniMax-H3 MLX 引擎）
- 模型缓存在系统级 `~/.cache/huggingface`（Qwen-Image-2512 / Qwen-Image-Edit-2509，~110GB，勿删；另有 mmh3turbo-bundles ~33GB）
- LoRA 注册表 `~/.config/lmedia/loras.json`：三项字段语义——`kind`（style 画风 / character 角色 / speed 加速）、`trigger`（prompt 自动注入）、`defaultWeight`

## 绘本插画生产配方（2026-08-27 定稿）

**主力 = 参考图编辑路径**（角色保真最强、零训练）：
```bash
lmedia image edit "保持参考图中的角色外观完全一致（{角色锚点}）：{场景动作}。
{背景要素显式枚举：如 草地开满粉色黄色紫色小花、蒲公英散落}。
画面物体边界纪律：每个物体轮廓清晰独立、边缘干净分明，物体之间边界利落不融合，主体细节丰富。
{主体细节：如 红色玩具小汽车圆润卡通造型、亮红车身饱满、圆形车头灯像眼睛、黄色轮毂清晰锐利}。
色彩饱和温暖明亮，主体颜色鲜明，水彩儿童绘本插画风格，纸张质感，角色有落地接触阴影，
无文字、无汉字、无字母、无数字、无logo、无水印、无标签" \
  --ref refs/{char}.png --steps 30 --width 2048 --height 1152 --seed N
```

**五条铁律**（全部实测换来的）：
1. **原生 2048×1152 + 30 步**——1664 生成再超分会导致物体边界混合；2048 原生物体像素 +51%，边界在生成时就画清楚
2. **背景要素显式枚举**——「留白」与「开满花」不能同写（自相矛盾时模型选空）；要花就写「粉黄紫小花一丛丛+蒲公英」
3. **色彩锚点必写**——「色彩饱和温暖明亮、主体颜色鲜明」；只写「柔和色调」会被理解成淡
4. **物体边界纪律段**——「每个物体轮廓清晰独立、边缘干净分明、不融合」单独成句
5. **风格 LoRA 慎用**——lbwatercolor 的「晕染柔边」会泡软边界降饱和（原版画风本身就是边缘利落色块干净的）。确需浓水彩感时权重 ≤0.5，发布档不加

**角色一致性优先级**：参考图编辑（`image edit --ref`）> 角色 LoRA > 纯文字锚点
**LoRA 训练成本结论**（2026-08-27 调研）：本地 47s/step × 1500 = 16-20h/角色不划算；云端 AutoDL 4090 ¥1.88/h + ai-toolkit ≈ **¥4-8/角色**（15 角色 ¥65-150，两三个夜间）。只在「需要脱离参考图的自由生成」时才训。升级候选：Edit-2511（多参考图+身份增强）、DiffSynth Qwen-Image-i2L（单图 1 分钟出 LoRA）

## 性能基线（M4 Max 128GB 实测）

| 任务 | 耗时 | 说明 |
|------|------|------|
| 文生图 1664×928 / 20 步 | ~196s | diffusers bf16（比 mflux Q8 快 2.4 倍，主力路径） |
| 参考图编辑 同尺寸 | ~200s + 首次加载 2min | |
| 超分 | ~5s | |
| Lightning 8 步快速档 | ~187s（mflux 路径） | 草稿迭代用 |
| LoRA 训练 768² fp32 | ~47s/step | 角色 1200-1500 步 / 风格 1000 步 |
| 视频 352p / 5s / 12 步 | ~3-6min（预估*） | MiniMax-H3 mmh3turbo；草稿试错档 |
| 视频 480p / 5s / 12 步 | ~6-10min（预估*） | 默认档 |
| 视频 720p / 5s / 12 步 | ~29-45min（预估*） | 成品档（1280×704） |

\* 视频耗时为 M5 Pro 51GB 实测参照推算，M4 Max 实测后回填；步数不变时近似线性于时长。

## 排障 playbook

| 症状 | 原因与解法 |
|------|-----------|
| 下载报 CAS Client Error / xet 错 | Clash TUN 与 xet 不兼容：`HF_HUB_DISABLE_XET=1`；SSL EOF 偶发 → 换 hf-mirror.com 手动下载 |
| 进程 0% CPU 卡死 | HF etag 检查挂代理 → `HF_HUB_OFFLINE=1`（CLI 已内置） |
| 训练被 SIGKILL | fp32 全模型 ~112GB 超内存 → 必须预计算 embeddings 补丁（见栈目录 train/）；fp16 在 MPS 是死路（loss=nan + scaler bug） |
| mflux 挂 LoRA 无效果 | mflux 不吃 diffusers/peft 格式 LoRA（静默失败）→ 用 diffusers 路径（CLI 的 gen 就是） |
| 生图变慢 2 倍+ | GPU 被另一个任务占着（训练/并发生图）——本机 GPU 任务是串行的，别并行 |
| 视频秒退/无产物 | 磁盘空间不足（H3 权重 ~50GB + 峰值内存 31GB 需 swap 余量）→ 清理后重跑；权重下载中断重跑即续传 |
| 视频 mp4 缺失只有帧/音频 | 系统无 ffmpeg（封装必需）→ `brew install ffmpeg` |
| 换 prompt 画面几乎不变 | 中文 prompt 太短被 seed 主导 → 写 30-50 字（见下方视频小节） |
| H3 权重下载报 LocalEntryNotFoundError | huggingface_hub 客户端（1.x/0.x 均中招）与 hf-mirror 的 resolve 重定向不兼容（308 回源 huggingface.co）→ 不要指望 HF_ENDPOINT，用 `lmedia video setup --mirror`（curl 直落盘到 mmh3turbo 认的本地路径，全部本地命中零网络） |
| mmh3turbo 下载 GGUF 报 404 | 上游 realrebelai/MiniMax-H3_GGUFs 改了文件名（0.1.0 硬编码旧名）→ `lmedia video setup` 已内置自动补丁；手动修 weights.py 里 GGUF_FILE 为 `qwen3vl-32B-MiniMax-H3-Q2_K.gguf` |

## 视频生成（本地 MiniMax-H3 / mmh3turbo，零 API 成本）

**模型**：MiniMax H3 开源权重（H3-Base FL2VA，33B DiT + Qwen3-VL-32B 文本塔），输出 768p 上限 / 24fps / 1-15s，**原生 32kHz 立体声音轨**。引擎为社区 MLX 移植 [mmh3turbo](https://github.com/vra/mmh3turbo)（自研 int8 Metal kernel，M4 Max 128GB 峰值内存 31GB@768p，权重 ~33GB）。Context-IR / 2K 再生成 / Ref2VA 参考生未开源或引擎未支持，本地只有「文生视频 + 首帧图生视频」。

**安装（一次性）**：

```bash
lmedia video setup --mirror        # 建 .venv-video + 装 mmh3turbo + hf-mirror 预置 ~50GB 权重（国内推荐）
brew install ffmpeg                # mp4 封装必需（若已装跳过）
```

无代理直连 huggingface.co 的环境可省略 `--mirror`（首次生成自动下载）；setup 会自动修补 mmh3turbo 0.1.0 的上游 GGUF 文件名漂移。

**命令**：`lmedia video gen <prompt> [-r 256p|352p|480p|704p|720p|768p] [--seconds 1-15] [--steps 12] [--seed N] [--first-frame <图>] [-o out.mp4]`，另有 `lmedia video list-res`。

**实操要点**（社区实测换来的）：
1. **草稿优先**——先用 352p/256p 把 prompt 歧义清掉（一镜几分钟），确认构图后再上 720p 出片（30-45min）；720p 实际画布 1280×704（32 倍数约束）
2. **中文 prompt 写 30-50 字**——H3 全注意力下文本 token 占比过低会被 seed 主导（换 prompt 画面不变）；「熊猫」不行，「一只大熊猫坐在竹林里啃竹叶，特写镜头，阳光透过竹叶」才行
3. **音频避开台词**——语音内容不可控（含糊类人声），prompt 里写 `Audio: ... no talking, no voices`，只要配乐/环境音，它是稳定给对的
4. **角色一致性靠 prompt 字面复用**——风格卡/角色卡逐字复用不改动写，12 镜独立生成可保持一致（社区 60s 短片验证过）；本地没有 Ref2VA，别指望参考图锁角色
5. **steps 默认 12 就好**——与 20 步视觉不可区分（31dB），8 步 23.6dB、4 步 17.6dB 明显掉质
6. 运行中间产物（帧/gif/audio.wav）在 `~/.lmedia/video-runs/<ts>/`，mp4 自动移到 `-o` 路径

**绘本管线配方**：`lmedia image edit`（角色一致性最强路径）出静态页 → `lmedia video gen "微动描述" --first-frame page.png -r 352p`（2-3s 微动循环：花瓣飘落/镜头缓推/角色挥手），对应 little-bee 调研的绘本增强甜点场景。

## 维护

- 源码：`~/workspace/lmedia-cli`；改动后 `npm run build && npm link`
- 实测知识与排障实录沉淀在 little-bee memory：`m4max-local-image-gen-stack`
