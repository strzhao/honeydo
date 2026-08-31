# lmedia CLI 使用说明

本地媒体生产 CLI。Apple Silicon 本地推理（Mac Studio M4 Max 128GB），**零 API 成本**，图像/视频/音效三模态。

> 何时用它：任何「要出图/出视频/出音效」的需求——绘本插画、素材图、原型图、角色一致性生产、绘本页微动视频、角色签名音/环境音。
> 边界：**图片理解**用 `qwen` CLI（别搞混）；**云端快速单张**可用 `doubao`；本地批量/一致性/免成本生产用 `lmedia`。

## 命令速查

```bash
# ── 音效产线（Dasheng-AudioGen 本地，Apache 2.0 零成本；2026-08-31 从 little-bee 迁移为通用能力）──
# prompt 必须纯英文场景描述（英文文本编码器，中文会生成人声废片）

# 单条生成（10s → 质量门 → 剪裁 → 段内峰值归一 -6dBFS）
lmedia sfx gen "A friendly cartoon bear making soft happy grunting sounds, single clean take" -o bear.wav
lmedia sfx gen "A cute cartoon rabbit squeaking happily" --rolls 4 --keep-rolls -o rabbit.wav   # 4掷筛好+保留全部
lmedia sfx gen "Calm forest ambience with gentle birds" --full -o forest.wav                    # 环境音：跳过剪裁留 10s

# 批量生成（清单驱动，模型只加载一次；逐 key 多掷+质量门选优 → <dir>/<key>.best.wav + report.json）
lmedia sfx batch -m sfx.json -o /tmp/sfx-batch --rolls 3 --keys bear,frog      # --keys 过滤子集；-m - 读 stdin
# 清单: [{"key":"bear","prompt":"A friendly cartoon bear making soft happy grunting sounds"}]
# report.json 记录逐候选 {roll,peak,snr,pass,reason} 与 winner{path,score}，可审计选优

# 剪裁 / 重剪（不依赖模型，秒级；产物旁写 .ops.json 记录本次参数）
lmedia sfx trim bear.wav                        # → bear.trim.wav + bear.short.wav + bear.ops.json
lmedia sfx trim bear.wav --thresh -45dB         # 静音阈值（默认 -35dB，两级回退 -35→-50→不剪）
lmedia sfx recut bear.wav --cap 3.0             # 灵敏重剪（-40dB/0.45s 间隙 + 3.5s 硬帽）→ 覆写 bear.short.wav

# 归一（sfx 默认两遍峰值 -6dBFS；ambient 走 loudnorm 两遍；全静音输入透传副本+告警，不产 NaN/削波）
lmedia sfx normalize bear.wav                          # 原地峰值归一 -6dBFS（|增益|<0.5dB 跳过但仍写副本）
lmedia sfx normalize ambient/*.wav --loudness -23      # loudnorm I=-23 TP=-2 LRA=7（第二遍 aresample 回原采样率）
lmedia sfx normalize bear.wav --target -12 --out-dir out/   # 峰值归一到 -12dBFS 并输出到别处

# 量化验收（时长/峰值/均值报表；任一 flag 命中 exit 1，行尾 status=pass|fail 机读）
lmedia sfx accept /tmp/sfx-batch/*.short.wav --max-dur 4.0 --min-dur 0.4

# A/B 试听页（候选音频拷贝到 ab_files/，html 相对路径引用，浏览器直开零依赖）
lmedia sfx ab -m groups.json -o ab.html         # groups: [{"name":"bear 新旧对比","candidates":["a.wav","b.wav"]}]

# 音效库（SSOT：~/.config/limg/sfx-library/，清单 index.json + 44.1kHz mono 160k mp3）
lmedia sfx lib init                                              # 建库根 + 空清单（幂等）
lmedia sfx lib add bear.best.short.wav --key bear --type sfx --library storybook --tags animal,cute
lmedia sfx lib add forest.wav --key forest --type ambient --library storybook    # ambient 环境音
lmedia sfx lib list [--type ambient] [--status ready] [--lib <dir>]
lmedia sfx lib remove bear                       # 仅删记录不删文件；不存在 exit 1
lmedia sfx lib verify                            # 对账：文件缺失/时长漂移>0.1s → ✗ + exit 1

# 音效栈自检（venv / 主模型缓存 / 分词器缓存；独立退出码 0/1 + 修复指引）
lmedia sfx doctor
lmedia sfx setup                                 # 幂等创建 .venv-audio（uv venv + torch/transformers<5 等）

# 管线：10s 生成 → 质量门(峰值≥-25dBFS+SNR≥20dB，全废自动加掷≤2) → 剪裁(两级静音检测+簇截断→1-3s) → 段内两遍归一-6dBFS
# venv：栈目录 .venv-audio（transformers<5）；~33s/掷；16kHz mono 是模型天花板（高保真待 Stable Audio 3 接入）
# 退出码：0 成功 / 1 环境·清单损坏·漂移·验收不过 / 2 参数非法·文件不存在
```

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

# 草稿档（Edit-2511 Lightning 8 步蒸馏 LoRA + 蒸馏调度器，~1/4 耗时；--fast 4 极速）
# ⚠️ 仅限构图/锚点验证：cfg=1 负向不下发，长 prompt 多角色会丢角色+画风漂（2026-08-29 A/B 实录，勿进出版链）
lmedia image edit "保持参考图角色外观完全一致：他在厨房吃蜂蜜面包" \
  --ref refs/pipi.png --fast -o draft.png

# 超分（Real-ESRGAN x2 + Lanczos，秒级）
lmedia image upscale in.png out.png --size 2730x1535

# 视频生成（本地 MiniMax-H3 / mmh3turbo；首次用前先 lmedia video setup）
lmedia video gen "水彩绘本风格：小蜜蜂男孩在花园里挥手，花瓣缓缓飘落，镜头缓慢推近，细节丰富" -r 480p -o scene.mp4
lmedia video gen "角色轻轻挥手" --first-frame page.png -r 352p -o page-motion.mp4   # 绘本页微动（图生视频）

# LoRA 注册表
lmedia lora list
lmedia lora add mimi ./mimi.safetensors --kind character --trigger "mimi_cat 橘猫女孩" --weight 1.0

# 常驻 daemon（模型加载一次，gen/edit/upscale 免每次 ~2min 冷加载；2026-08-29 加入）
lmedia image serve start --mode edit --wait   # 预加载（不 --wait 立即返回，加载期任务自动排队）
lmedia image serve status                     # 两模式状态；stop 停止（--mode gen 或缺省全部）
# 默认无需手动管理：gen/edit 首次调用自动拉起，空闲 30min 自动退出（--idle-timeout 可调）；
# 跑批免冷加载、`--no-daemon` 强制冷路径排障；一个实例只载一条管线（gen+edit 双驻 ~110GB 超内存，
# 切换用 `serve start --mode X --swap`）

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
- 栈目录内含：`.venv`（mflux Q8 遗留）+ `.venv-train`（diffusers bf16 推理/训练，主力）+ `.venv-video`（mmh3turbo，MiniMax-H3 MLX 引擎）
- 模型缓存在系统级 `~/.cache/huggingface`（Qwen-Image-2512 / Qwen-Image-Edit-2511，~150GB，勿删；2509 旧缓存确认不用后可手动删；另有 mmh3turbo-bundles ~33GB）
- Lightning 蒸馏 LoRA 在栈目录 `loras/`（8 步默认 + 4 步极速，--fast 自动注入）
- LoRA 注册表 `~/.config/limg/loras.json`：三项字段语义——`kind`（style 画风 / character 角色 / speed 加速）、`trigger`（prompt 自动注入）、`defaultWeight`（`lightning` 旧条目为 mflux 遗留，已废弃）
- **音效库根解析优先级**：`--lib` flag > `LMEDIA_SFX_LIB` env > 默认 `~/.config/limg/sfx-library/`；库根内 `index.json` 是唯一清单（SSOT，snake_case 字段），`sfx/`、`ambient/` 放入库规范产物（44.1kHz mono 160k mp3，ffmpeg 转码，原件保留在用户手中）
- **音效清单损坏防护**：`index.json` 为空/非法 JSON 时报「清单损坏」exit 1，**绝不静默重建**（与 lora 注册表首跑自动播种不同，防丢账）；批量清单 `-m` 同语义（不存在=2，存在但内容坏=1）
- **音效 venv**：栈目录 `.venv-audio`（`lmedia sfx setup` 幂等创建）；音效模态自检走 `lmedia sfx doctor`（独立退出码），全局 `doctor` 的 `[sfx]` 段仅展示不参与退出码
- **daemon（常驻推理）**：状态目录 `~/.lmedia/serve/`（`<mode>.sock/.json/.log`）；gen/edit 自动拉起、upscale 只搭便车（daemon 不在直接冷路径，spandrel 秒级）；任务串行（GPU 铁律）；任务中客户端断连则服务端照常算完（产物落盘由调用方兜底）；LoRA 按任务热切换（adapter 缓存上限 4）；快照升级/切 LMEDIA_RUNTIME 后需 `serve stop` 重启才会用新权重

## 绘本插画生产配方 v3（2026-08-28 验收通过，「淡空平」画风）

**画风语言（对照线上原版逆向出的六要素，逐字写进 prompt）**：
```
画风要求：低饱和淡雅色调，颜色含蓄柔和偏灰；大色块平涂，画面扁平如手绘插画，无体积光影；
角色和物体用深色手绘轮廓线勾边；大面积留白背景，接近纸的本色，背景极度简化，仅保留{场景必要物}；
只有{主角}有细节，背景没有任何多余细节；阴影极轻极淡，若有若无
```
**反 AI 味负向（常备）**：
```
写实照片，3D渲染，photorealistic，过度细节，均匀满铺的纹理，全图噪点颗粒，高饱和艳丽的色彩，体积光影，立体感，厚重阴影
```

**完整调用**（edit 路径，角色保真最强）：
```bash
lmedia image edit "保持参考图中的角色外观完全一致（{完整锚点，不能省}）：{场景动作}。
{画风六要素}。无文字、无汉字、无字母、无数字、无logo、无水印、无标签" \
  --ref refs/{char}.png --steps 30 --width 2048 --height 1152 --seed N --neg "{反AI味负向}"
```

**七条铁律**：
1. **画风 = 淡空平 + 轮廓线**——「色彩饱和温暖明亮/主体细节丰富/纸张质感」是 AI 味三毒，禁写；淡雅/平涂/留白/勾边才是原版语言（08-28 用户验收通过）
2. **锚点/面部纪律/反写实负向缺一不可**——写实漂移的真实根因是 prompt 薄（A/B 实证：官方 ref + v3 prompt + 负向 = 水彩不漂移，ref 无需替换）
3. **完整锚点每页全量写**——CFG 生效后 prompt 缺什么漂什么
4. **原生 2048×1152 + 30 步发布 / 1024×576 + 20 步验收迭代**（低尺寸 5 分钟档，画风方向验证够用）
5. **背景要素显式枚举**——「留白」与「开满花」不能同写；草地写「一整块柔和绿色色块，不画一根根的草」
6. **gen 无 ref 时必须卡通化词汇**——Q版圆润头大身小手绘平涂 + 反写实负向（动物写实先验很强）
7. **风格 LoRA 发布档不加**——lbwatercolor 是无 CFG 时代产物，「淡空平」prompt 已覆盖其价值

**角色一致性优先级**：参考图编辑（`image edit --ref`）> 角色 LoRA > 纯文字锚点
**LoRA 训练成本结论**（2026-08-27 调研）：本地 47s/step × 1500 = 16-20h/角色不划算；云端 AutoDL 4090 ¥1.88/h + ai-toolkit ≈ **¥4-8/角色**（15 角色 ¥65-150，两三个夜间）。只在「需要脱离参考图的自由生成」时才训。升级候选：Edit-2511（多参考图+身份增强）、DiffSynth Qwen-Image-i2L（单图 1 分钟出 LoRA）

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
| 参考图编辑 `--fast`（Lightning 8 步，2048×1152 四 ref，daemon 热路径） | ~651s | 2026-08-29 A/B 实测；**仅草稿档**（见排障表「Lightning edit 画风漂移」） |
| 参考图编辑 `--cache`（TeaCache 步缓存，2048×1152 30步 CFG4） | ~40-43min | ❌ 出版不可用：两轮 A/B（0.3 / warmup4+0.3）构图均发散成浆糊，见排障表 |
| 参考图编辑 refVaeSize=512²（实验开关，edit.py cfg 注入） | ~28min（1678s） | ❌ 出版不可用：参考图 token 减 75% 提速 ~1.7x，但角色身份漂移（蜂妈→人类女孩）+ 构图重掷——参考图分辨率是角色一致性命脉，勿动 |
| 参考图编辑 20 步 @2048×1152 四 ref | ~48min（2854s） | ⚠️ 比 30 步（同机 pace ~70min）省 ~1.5x，但同 seed 不等价（减步=换调度=重掷构图）；n=1 A/B 未过出版门槛，要采用需多页 gate 评分验证 |
| 参考图编辑 `--fast --cfg 4` | ~1238s | ❌ 死路勿用：蒸馏模型叠 CFG 冲出分布（半调网点/角色崩坏/长水印） |
| 超分 | ~5s | |
| LoRA 训练 768² fp32 | ~47s/step | 角色 1200-1500 步 / 风格 1000 步 |
| 视频 352p / 5s / 12 步 | ~3-6min（预估*） | MiniMax-H3 mmh3turbo；草稿试错档 |
| 视频 480p / 5s / 12 步 | ~6-10min（预估*） | 默认档 |
| 视频 720p / 5s / 12 步 | ~29-45min（预估*） | 成品档（1280×704） |

\* 视频耗时为 M5 Pro 51GB 实测参照推算，M4 Max 实测后回填；步数不变时近似线性于时长。

## 排障 playbook

| 症状 | 原因与解法 |
|------|-----------|
| 下载报 CAS Client Error / xet 错 | Clash TUN 与 xet 不兼容：`HF_HUB_DISABLE_XET=1`；SSL EOF 偶发 → 换 hf-mirror.com 手动下载 |
| hf CLI 直连报 "Distant resource..." 且不想走 proxy | hf_hub 1.28 的 curl_cffi 传输层吃 macOS 系统代理，`unset` 不够：`export no_proxy='*' NO_PROXY='*'` + `HF_ENDPOINT=https://hf-mirror.com`（见 scripts/dl-*.sh） |
| 进程 0% CPU 卡死 | HF etag 检查挂代理 → `HF_HUB_OFFLINE=1`（CLI 已内置） |
| 生图不遵循 prompt / 画质发飘 | 2026-08 前的旧版 `guidance_scale` 无效（diffusers 忽略），已修复为 true_cfg_scale + 负向模板；`--fast` 时 cfg=1 属正常（蒸馏） |
| Lightning edit 画风漂移（马赛克满铺纹理/丢角色/构图不跟 prompt） | 蒸馏路径 cfg=1 负向不下发，长 prompt 多角色遵循度衰减（page-20 A/B 实录）——`edit --fast` 只用于构图/锚点草稿验证，出版必须 30 步 CFG4；**蒸馏 + `--cfg 4` 更糟**（半调网点+水印，分布外），别试 |
| TeaCache（`--cache`）出版档构图发散成浆糊 | 2048×1152/30步/CFG4/多 ref 配方下两轮 A/B 均失败（阈值 0.3、warmup4+0.3 都救不回；PSNR 9.3）。小尺寸 512² 同机制正常（PSNR 26）——大图上每步轨迹扰动被 CFG renorm 放大累积。**出版勿用**；草稿/低尺寸可玩。实现细节与坑见 `python/teacache.py` 头注 |
| 蒸馏 LoRA 出图质量比预期差 | 检查是否换了蒸馏调度器（`base_shift=max_shift=ln3`、`shift_terminal=None`）：CLI 的 `--fast` 已自动换（`lightningSched`），手写调用 gen.py/edit.py 时必须显式传 |
| 生成结束但 python 进程不退、内存不还（后续 GPU 任务被杀） | MPS 退出清理偶发挂死（实测一次：旧 edit.py 打印结果后占 ~60GB 不退）。处置：`pkill -9 -f "lmedia-cli/python/(gen\|edit).py"`；跑批脚本见 `scripts/calib-lib.sh` 的清扫模式 |
| 训练被 SIGKILL | fp32 全模型 ~112GB 超内存 → 必须预计算 embeddings 补丁（见栈目录 train/）；fp16 在 MPS 是死路（loss=nan + scaler bug） |
| mflux 挂 LoRA 无效果 | mflux 不吃 diffusers/peft 格式 LoRA（静默失败）→ 用 diffusers 路径（CLI 的 gen 就是；快速档也已迁到 diffusers `--fast`） |
| 生图变慢 2 倍+ | GPU 被另一个任务占着（训练/并发生图/大文件下载抢盘）——本机 GPU 任务是串行的，别并行 |
| daemon 行为异常（任务挂起/状态残留） | `lmedia image serve stop && lmedia image serve start --mode X --wait` 重启；现场日志 `tail -50 ~/.lmedia/serve/<mode>.log`；被 `pkill -9` 留下的死 socket 会自愈（下次 start 自动清理重绑） |
| daemon 报「连接中断（任务结果未知）」 | daemon 在任务中死掉/被 stop——客户端故意不自动重跑（防 40min 任务重复）；产物可能已落盘，重试前先查输出文件 |
| gen/edit 首次调用突然多等 2 分钟 | 那是 daemon 在自动拉起加载模型（stderr 有提示）；之后同管线任务免加载。不想要 daemon：`--no-daemon` 或 `LMEDIA_NO_DAEMON=1` |
| 外部脚本的 GPU 占用检查失效（pgrep gen/edit.py 查不到） | daemon 进程名是 `serve.py`，且 busy 才占 GPU——防御检查应改用 `lmedia image serve status`（busy=true 即占用）；走 lmedia CLI 的任务自带 waitGpuIdle 排队，不会抢 |
| 视频秒退/无产物 | 磁盘空间不足（H3 权重 ~50GB + 峰值内存 31GB 需 swap 余量）→ 清理后重跑；权重下载中断重跑即续传 |
| `sfx gen/batch` 报「音效 venv 未找到」 | 栈目录缺 `.venv-audio` → `lmedia sfx setup`（或 `lmedia sfx doctor` 看三项缺哪） |
| `sfx doctor` 报模型/分词器缓存缺失 | `HF_HUB_OFFLINE=0 huggingface-cli download mispeech/Dasheng-AudioGen`（分词器同 repo 名换成 `mispeech/dashengtokenizer`）；HF 缓存路径按 `HF_HUB_CACHE` > `$HF_HOME/hub` > `~/.cache/huggingface/hub` 解析 |
| `sfx trim` 剪完音量还是不对（整段偏轻） | 旧版整掷峰值归一的错位 bug（2026-08-31 已修）：现在先剪到 tmp 测**段内**峰值再增益；若仍异常用 `lmedia sfx recut <file> --cap 3.5` 重剪（同样走段内归一） |
| `sfx lib add` 报「已有同内容条目」 | 同 `content_hash` 幂等跳过（exit 0）——换 key 也不会重复记账；要强制换内容先改音频再入库 |
| `sfx lib verify` 报时长漂移 | 清单记录与实际文件时长差 >0.1s（多半是文件被重编码/覆盖）→ `lib remove <key>` 后重新 `lib add` |
| `sfx normalize` 输出和输入一样大（没响） | 输入全静音（peak < -60dBFS）→ 跳过增益但写透传副本 + `·` 告警（exit 0），这是防 NaN/削波的保护行为 |
| `sfx batch` 报「批清单解析失败」 | `-m` 文件存在但为空/非法 JSON（exit 1，不覆写）；文件不存在是 exit 2；key 需 `^[a-z0-9-]+$` 且清单内唯一（违者 exit 2） |
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
