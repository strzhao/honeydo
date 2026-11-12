# Handoff：高斯泼溅能力包（`honeydo splat`）

| | |
|---|---|
| **状态** | 调研完成，待开发 |
| **日期** | 2026-09-13 |
| **落点** | honeydo 新能力包，建议 `packages/lsplat/`，bin `lsplat`，主壳命令 `honeydo splat` |
| **首个消费方** | relight 每日精选 Hero 页（`apps/web/components/daily-hero.tsx`） |
| **一句话** | 用 Apple SHARP 把单张照片本地推理成 3D 高斯泼溅，抽稀压缩成网页可交互的 splat 资产 |

---

## 1. 为什么做这个包

> ⚠️ **先读 §2.5 和 §6 决策 0**：后台调研显示，如果 Hero 页要的只是「微动的呼吸感」，**深度图 2.5D 路线在成本 / 体积 / 许可三项上全面占优**，且每一环都已验证。本文档描述的真 3DGS 路线成立，但**它是为「真的能拖着转视角」这个更强的产品承诺买单**。路线未拍板前不要动工。

relight 的每日精选 Hero 页目前是一张静态 `<img>`。目标是让它变成**可以用指针微动、换角度看**的 3D 场景——SHARP 的视域是 ±15–30°，做不了 360°，但对「Hero 微微换个角度」这个场景**恰好够用**，而它 <1 秒的推理让「每天自动出一张」在成本上成立。这是这条路线的独特甜点区。

按 honeydo 的既有边界，它应该是一个**独立能力包**：relight 已经通过 `spawn honeydo` 消费视频能力（`HONEYDO_CLI_PATH` + stdout JSON + 退出码契约），splat 走同一条路。

**不要塞进 `lmedia`**：lmedia 的 venv 是 diffusers/mflux 系，SHARP 要的是 torch 2.8 + gsplat，两者栈完全不同；且仓规明确「别在能力包里加对兄弟包的 import——保持各自独立可拆」。

---

## 2. 调研结论（2.1–2.3 SHARP 一手事实 · 2.4–2.6 生态与对照路线）

官方仓库 [`apple/ml-sharp`](https://github.com/apple/ml-sharp)，论文 *Sharp Monocular View Synthesis in Less Than a Second*（arXiv 2512.10685）。
**下表全部由我直接读源码 / README / 许可证 / PyPI 核实**，非二手转述。

### 2.1 硬参数

| 项 | 实测值 | 出处 |
|---|---|---|
| 推理设备 | `cuda → mps → cpu` **自动选择**，`--device` 可强制 | `src/sharp/cli/predict.py:103-109` |
| **MPS 可用** | ✅ 官方 README 明写 "gaussians prediction works for all CPU, CUDA, and MPS" | README |
| `--render`（轨迹视频） | **仅 CUDA**；非 CUDA 会 `LOGGER.warning` 并自动关掉，不报错 | `predict.py:112-114` |
| 内部推理分辨率 | 硬编码 `internal_shape = (1536, 1536)`，**与输入分辨率无关** | `predict.py:166` |
| 高斯点数 | **固定 ~1,179,648**（1536×768） | 源码 + 社区 CoreML 移植验证 |
| 球谐阶数 | **仅 SH degree 0**（`f_dc_0..2`，无视角相关颜色） | `utils/gaussians.py: save_ply` |
| PLY 属性 | xyz(3)+color(3)+opacity(1)+scale(3)+rot(4) = **14 × float32 = 56 B/点** | `utils/gaussians.py:379-388` |
| **单张 PLY 体积** | **≈ 63 MiB（66 MB）** ← 全链路根约束 | 1,179,648 × 56 B |
| 坐标约定 | OpenCV（x 右、y 下、z 前），场景中心约 (0, 0, +z) | README |
| PLY 附带元数据 | `extrinsic` / `intrinsic` / `color_space` / `image_size` 写进 supplement ← **前端可据此摆正相机** | `utils/gaussians.py:267` |
| 权重体积 | `sharp_2572gikvuh.pt` = **2,809,738,232 B（2.62 GiB）** | HEAD 实测 CDN |
| 颜色空间 | 输入 sRGB；内部 linearRGB；导出时**强制转回 sRGB** 以兼容公共渲染器 | `save_ply` 注释 |
| 视域 | **±15–30°**，做不了 360°；遮挡区域无法生成 | 官方说明 |

### 2.2 依赖与安装（macOS 可用性已核实）

- Python **3.13**、torch 2.8.0、torchvision 0.23.0、**gsplat 1.5.3**、timm 1.0.20、`pillow-heif`（**原生读 HEIC**，正好合 relight 的照片库）
- `requirements.txt` 里所有 `nvidia-*` / `triton` 都有 `platform_machine == 'x86_64' and sys_platform == 'linux'` 标记 → **macOS 上不会装**
- ⚠️ **一个原本以为致命的坑，已排除**：`predict.py` 顶层就 `from .render import render_gaussians` → `render.py` → `from sharp.utils import gsplat` → `sharp/utils/gsplat.py:12` 是 `import gsplat`。也就是说**即使不渲染视频，也必然 import 第三方 gsplat**（一个 CUDA 库）。我下载 `gsplat-1.5.3-py3-none-any.whl` 验证：
  - 它是**纯 Python 轮子**（`py3-none-any`），macOS 上 pip 安装不编译
  - `cuda/_wrapper.py` 用的是**惰性加载**——`_make_lazy_cuda_func` 把 `from ._backend import _C` 放在**函数体内**，所以 `import gsplat` 无 CUDA 也成功
  - ⇒ **macOS 安装路径通畅**，CUDA 只在真正调用光栅化时才需要
- 官方 CLI：
  ```bash
  sharp predict -i <图片或目录> -o <输出目录>          # 权重自动下载到 ~/.cache/torch/hub/checkpoints/
  sharp predict -i <img> -o <out> -c sharp_2572gikvuh.pt --device mps
  ```

### 2.3 许可（`LICENSE_MODEL` 原文核实）

Apple AMLR —— *"exclusively for **Research Purposes**"*，且明写 *"Research Purposes does not include any commercial exploitation, product development or use in any commercial product or service"*。
个人相册自用属非商业，无实际风险；但**不能带进任何商业化形态**。注意 honeydo 根包是**公开发布到 npm** 的——见 §6 决策项。

### 2.4 生态（后台 agent 调研，非我亲验，按可信度标注）

- **Apple Silicon 本地推理移植**：[`schwa/Sharp`](https://github.com/schwa/Sharp)（Swift/Metal，~3s）、[`pearsonkyle/Sharp-coreml`](https://huggingface.co/pearsonkyle/Sharp-coreml)（Core ML，**M4 Max 实测 ~1.9s**，与 PyTorch 输出误差 ~0.01%）、[`neosun100/sharp`](https://github.com/neosun100/sharp)（Docker + WebUI + REST + MCP）、[`cjgaspari/ml-sharp`](https://github.com/cjgaspari/ml-sharp)（一键装 + Web UI）
- **浏览器渲染器**：[`sparkjsdev/spark`](https://github.com/sparkjsdev/spark) —— **`@sparkjsdev/spark` 2.2.0，MIT，gzip 909.6 KB，是可嵌入的 npm 组件**（`SparkRenderer` + `SplatMesh`，THREE.js peer dep ≥0.180），有真正的 LOD 流式（`SplatPager`），**不需要 COOP/COEP 头**。备选 [`@reall3d/reall3dviewer`](https://www.npmjs.com/package/@reall3d/reall3dviewer)、[`manycoretech/aholo-viewer`](https://github.com/manycoretech/aholo-viewer)（MIT）
- **交付格式**：`.ply`（归档）→ `.spz`（Niantic）/ `.sog`，4M 点实测 1.4 GB → 160 MB / 140 MB，**约 10× 压缩**。转换工具候选：`splat-transform <in.ply> <out.sog>`
- 官方只给了 Python 推理；**Python → 网页 splat 的完整工程链路需要我们自己搭**，这也是本包的核心价值

### 2.5 对照路线：深度图 2.5D 视差（⚠️ 就 Hero 页这个需求，它可能比 3DGS 更划算）

后台调研把这条路线的每一环都验证到位了，结论**对 3DGS 路线不利，必须如实记录**：

| | 真 3DGS（SHARP） | 深度 2.5D |
|---|---|---|
| 模型许可 | **Apple AMLR**（研究限定 + 可单方面 revoke） | **Apache-2.0** ✅ |
| 模型体积 | 2.62 GiB 权重 + ~3 GB venv | **F16 49.4 MB**（`apple/coreml-depth-anything-v2-small`） |
| 单张耗时 | ~1.9–5s（MPS，待实测） | **M3 Max 24.58 ms（ANE）/ M1 Max 32.78 ms（GPU）** |
| 365 张批量 | 分钟级 | **≈ 10 秒** |
| 网页资产 | 66 MB → 压缩后 ~3–4 MB（推算） | **一张 512²/1024² 灰度 PNG**（几十 KB） |
| 客户端依赖 | Three.js + Spark（~910 KB gzip） | ~100 行自研 three.js `ShaderMaterial` |
| 交互性 | **真 3D，可绕看 ±20°** | 弱视差，无真视差 |

**关键细节**
- 🔴 **授权陷阱**：DA V2 **Small 是 Apache-2.0**，但 **Base / Large 的社区 ONNX 版是 CC BY-NC 4.0**。**只用 Small**。另：官方 HF 仓（`depth-anything/Depth-Anything-V2-Small-hf`）**只给 `model.safetensors`，没有 .onnx** —— ONNX 靠社区转换，或用 Apple 官方 Core ML 版
- **现成 npm 包不适用**：`react-depth-parallax`（MIT，113 KB）**要求容器及任何祖先元素都不能有背景色**（它画在 div 背后的 fixed canvas），而 relight 的 Hero 正坐在纸色基底上 → 直接冲突；且 0 star、无生产背书。**建议自研 shader**
- **实现要点**：用**高度细分平面 + 顶点位移**（`PlaneGeometry(1,1,200,200)` + 透视相机）而非纯片元 UV 平移，才能拿到正确的透视/遮挡关系；canvas 放正常布局流里，绕开上述背景色限制
- **伪影的诚实评估**：小幅位移（等效 ±5–15px）下拉伸涂抹几乎不可察觉 —— **这恰好就是「subtle micro-parallax」的设计区间**。位移一大，前后景交界立刻出现橡皮膜拉伸，**这是该技术的本质而非 bug**（[`vt-vl-lab/3d-photo-inpainting`](https://github.com/vt-vl-lab/3d-photo-inpainting)，CVPR 2020，**MIT**，7092★，是大位移需求的离线方案）

### 2.6 单图→3DGS 的其它模型：**没有一个能在 Apple Silicon 上替代 SHARP**

后台核实了 17 个候选，全部排除：

- **InfiniSplat**（ZJU, SIGGRAPH Asia 2026）能力最接近（单图→全场景，且 gsplat 可选依赖），但 INSTALL.md 锁 `torch==2.9.0 + xformers/cu128 + CUDA toolkit` → 不可行；License NOASSERTION
- **TripoSplat**（MIT，代码+权重，1290★）是唯一大概率能跑的（near-zero dependencies），但它是**物体级 asset creation、专门做背景移除**，不做带背景的生活照场景重建
- **Depth Anything 3** 的 GS 头只开在 GIANT / NESTED-GIANT 上，而这两个是 **CC BY-NC 4.0**；开源友好的 SMALL/BASE 只能出深度图；示例还硬编码 `torch.device("cuda")`
- **Splatter Image**（BSD-3）、**TRELLIS / TripoSR**（MIT）都是**物体级**，对带背景生活照无效；**Flash3D** 锁 CUDA 11.8 + PyTorch 2.2.2
- ⚠️ **`GaussianImage` 方向不对**（原始需求里被提到）：它是把一张 2D 图表示成 **2D 高斯**的神经图像**编解码器**，**不产生新视角、不产生视差**，渲染出来还是同一张图；且未发现预训练权重
- **`transformers` / `diffusers` 集成全线为零**：对 `huggingface/transformers` 代码搜索 `vggt`/`triposr`/`trellis`/`sharp` **total_count 全 = 0**（对照组 `Sam2Model` = 15）。所有模型的「HF 集成」都只是「权重仓 + Gradio Space」。唯一例外是**深度估计**（`depth-estimation` pipeline 被广泛支持）—— 这反过来又利好 2.5D 路线

---

## 3. 能力包设计

严格对齐 `packages/lmedia/` 的既有范式（**这是全仓已验证可用的形状，照抄即可**）。

### 3.1 目录结构

```
packages/lsplat/
  package.json          # name: "lsplat-cli"? 见决策项；private: true；bin: { lsplat: ./dist/index.js }
  src/
    index.ts            # commander 入口
    commands/
      predict.ts        # 图 → .ply（薄封装 SHARP）
      compress.ts       # .ply → .spz/.sog（抽稀 + 压缩）
      gen.ts            # 图 → 网页就绪 splat（predict + compress 一步到位）★ relight 调这个
      doctor.ts         # 自检（对齐 lmedia/src/commands/doctor.ts）
      setup.ts          # 建 venv + 下权重
    lib/
      runtime.ts        # 运行时解析（对齐 lmedia/src/lib/runtime.ts）
      shard.ts          # spawn python 驱动 + stdout JSON 解析 + 超时（对齐 relight 侧 spawnHoneydoVideo 的契约）
  python/
    predict.py          # 驱动 SHARP（import sharp / 调 venv python）
    compress.py         # 抽稀 + 写 spz/sog
  tests/                # *.test.ts + *.acceptance.test.ts（对齐 lmedia）
  USAGE.md  README.md
  tsup.config.ts  tsconfig.json  vitest.config.ts
```

### 3.2 运行时解析（抄 `lmedia/src/lib/runtime.ts` 的三级优先级）

```
LSPLAT_RUNTIME env  >  ~/.lsplat/runtime（symlink）  >  默认目录
```

- **仓内只有 node 壳 + python 驱动脚本；venv 与权重全部在仓外**（这是 lmedia 已验证的边界，`LMEDIA_RUNTIME` 同款）
- venv 建议 `~/ml/sharp-runtime/.venv-sharp`，权重走 SHARP 自己的 `~/.cache/torch/hub/checkpoints/`
- 缺运行时时的报错文案要对齐 lmedia 的引导风格：
  `请设置 LSPLAT_RUNTIME 指向本地栈目录，或创建软链: mkdir -p ~/.lsplat && ln -s <栈目录> ~/.lsplat/runtime`

### 3.3 命令面

| 命令 | 作用 |
|---|---|
| `lsplat setup` | 建 venv（Python 3.13）+ 装 requirements + 下权重（**幂等**） |
| `lsplat doctor` | 自检：venv / 权重 / `import gsplat` / MPS 可用性 / 磁盘余量，输出可执行修复建议 |
| `lsplat predict <img> -o <dir>` | 薄封装，产出 `.ply`（保留全量 1.18M 点，供调试与画质对比） |
| `lsplat compress <in.ply> -o <out.spz> --max-gaussians N` | 抽稀 + 压缩 |
| **`lsplat gen <img> -o <out.spz> --max-gaussians N`** | **★ relight 调用的一步到位命令** |

### 3.4 集成契约（必须遵守，relight 侧已如此消费 honeydo）

- **退出码**：0 成功 / 1 运行错误 / 2 参数错误（全仓统一）
- **stdout 只放机读 JSON**，进度与人读信息一律走 stderr：
  ```json
  {"ok": true, "splat": "/abs/out.spz", "gaussians": 150000, "bytes": 3145728, "ms": 2100}
  ```
- **产物绝对路径**回传（relight 会 `fs.access` 校验产物存在性，路径基准错位是踩过的坑）
- relight 侧解析：`which honeydo` → 可被 `HONEYDO_CLI_PATH` 覆盖
- **主壳注册**（两处，缺一不可）：
  1. `packages/cli/src/index.ts` 的 `ENTRIES` 加 `splat: path.resolve(HERE, "../../lsplat/dist/index.js")`
  2. 同文件 `switch (cmd)` 加 `case "splat": return forward("splat", rest)`

---

## 4. 关键技术风险（按证伪优先级排序）

### 🔴 R1：63 MiB → ≤3 MB 的压缩链路（**最大未知，必须先证伪**）

SHARP 固定产出 1,179,648 个点，原始 PLY 63 MiB，**绝不能进浏览器**。

- 目标：`max-gaussians` ≈ 8–15 万，SPZ 后 **1.7–3 MB**（按 ~10× 压缩 + 线性缩减估）
- ⚠️ **抽稀不能等距/随机采样**——会在大块低不透明度区域留洞。应按 **opacity 重要性采样**，或直接取 opacity 排序 top-N
- **未验证**：`.ply → .spz` 的具体工具链、真实压缩比、抽稀后画质。这是 M2 要跑出来的第一手数据

### 🔴 R2：MPS 真实推理耗时

官方 "less than a second" 说的是标准 GPU；MPS 待实测（CoreML 移植版在 M4 Max 是 ~1.9s，原生 MPS 路径未知）。若单张 >10s，每日流水线仍可接受（一天一张），但手动重跑体验会差。

### 🟠 R3：网页侧手势冲突（消费方问题，但会影响命令面设计）

relight 的 Hero 容器 `.dh-banner` **已经用 `onPointerDown/Move/Up` 做左右拖拽切换 entry**。泼溅的「拖动转视角」与之直接冲突。可选：泼溅只吃 hover/陀螺仪不吃拖拽 / 画布内 `stopPropagation` / 加「3D 模式」开关接管手势。**这个决定会影响 `gen` 是否需要同时输出一张静态首帧图**。

### 🟠 R4：LCP 与 bundle

Hero 首图是 `eager` + `fetchPriority="high"` 的 LCP 元素，且有 no-crop 的 e2e 断言。渲染器（Three.js + Spark 系）必须 `dynamic import` + `ssr: false`，**绝不能进首屏路径**——静态图先出，splat 在 idle 后加载再交叉淡入。

### 🟡 R5：磁盘

本机数据卷 **935G/995G 已用，仅剩 21 GB（98%）**。新增：venv ~3 GB + 权重 2.62 GiB + 每日累积 splat ≈ 5.6 GB 起。参照系：现有 `~/ml/lb-local-gen` 是 16 GB。**开工前建议先清盘**。`doctor` 应把磁盘余量纳入检查。

---

## 5. 里程碑

| | 内容 | 出口条件（可证伪） |
|---|---|---|
| **M0** | 环境打通 | `lsplat setup` 在 M4 Max 跑通；`sharp --help` 正常；`import gsplat` 成功 |
| **M1** | 单图出 ply | 一张真实照片产出 `.ply`；**实测**文件体积 / MPS 耗时 / 点数，与 §2.1 表格对账 |
| **M2** | 压缩链路 | `.ply → .spz` 跑通；实测压缩比；目视对比抽稀前后画质，定出 `max-gaussians` 默认值 ← **R1 在此证伪** |
| **M3** | 网页 demo | relight 里一个**独立 demo 页**（**先不碰 `daily-hero.tsx`**，避免打破既有 e2e 断言）用 Spark.js 渲染出来，鼠标可交互 |
| **M4** | 接流水线 | 照抄 relight `src/jobs/wallpaper-video.ts` 的形状：新队列 + `daily_picks` 新增 URL 列 + COS 上传 + `syncDayToGallery`，独立 try/catch 旁路、失败回退静态图 |

---

## 6. 必须拍板的决策（开发前）

0. **🔴 路线选择（最大的一条，建议先拍）**：就「Hero 页微动视差」这个原始需求，**深度 2.5D 在成本、体积、许可三项上全面占优**（见 §2.5），且每一环都已验证到位；真 3DGS 的独有价值是**真交互（可绕看 ±20°）**，代价是 66 MB 资产链路 + AMLR 许可 + 显著更多工程量。
   - 若你要的是「微动的呼吸感」→ **选 2.5D**，本包的 SHARP 部分可以不做
   - 若你要的是「能拖着转的 3D 物件」（这本身也是很好的产品体验）→ **选 3DGS**，本 handoff 的 §3 成立
   - 也可以**两条都做**：2.5D 作为默认、3DGS 作为「点击进入 3D」的增强项
1. **包名 / 命令名**：建议 `lsplat`（`l*` 前缀 = 本地推理，与 `lmedia` 一致），主壳命令 `honeydo splat`。备选：`hsplat` / `gsplat`（与第三方库同名，不推荐）。若最终选 2.5D 路线，包名应改为 `ldepth` 之类
2. **许可证边界** ⚠️：Apple AMLR 限「研究用途」、**可单方面 revoke**、禁止商业使用。honeydo 根包**公开发布到 npm** —— 需要明确：能力包本身可以发（不发权重，用户自行从 Apple CDN 下载并直接接受 Apple 条款），但要在 README 显著位置声明许可约束。**这条建议有意识地拍板，而不是默认带过**。（2.5D 路线无此问题：Apache-2.0）
3. **隐私**：splat 是对**场景几何**的还原，比二维照片暴露更多（家里的空间结构、孩子所在环境）。relight 的画廊是**公有读**的——照片/壁纸/视频已接受该前提，但「3D 还原」是同一份同意的新量级，建议单独确认一次
4. **`gen` 是否同时输出静态首帧**（取决于 R3 的手势方案）

---

## 7. 验收标准

- [ ] `lsplat setup` / `doctor` 幂等，缺依赖时给可执行修复建议
- [ ] 退出码 0/1/2 契约、stdout 纯 JSON、产物绝对路径回传
- [ ] `tests/` 有 `.test.ts` + `.acceptance.test.ts`，与 lmedia 同级覆盖
- [ ] **`honeydo/CLAUDE.md` 的「结构」表登记新包**，`README` 增加能力说明 ← 仓规要求的「防建完就丢」
- [ ] **登记发现入口**：按全局规范，honeydo 根 `CLAUDE.md` 加一行「何时用 + 指针」；relight 侧消费方同步登记
- [ ] `USAGE.md` 写清 runtime 解析、权重下载位置、许可约束

---

## 8. 开放问题

- **⭐ 唯一剩下的推算空白：`.sog` 的真实体积**。66 MB 是 PLY 实测值，压缩后 ~3.3–4.4 MB 是**推算**，没实测过 —— **它直接决定真 3DGS 路线是否成立**（若 >6 MB，移动端体验就成问题）。**这是全文档最有价值的下一步**：
  ```bash
  sharp predict -i <一张照片> -o /tmp/sharpout -c sharp_2572gikvuh.pt --device mps
  splat-transform /tmp/sharpout/<stem>.ply /tmp/sharpout/<stem>.sog
  ls -la /tmp/sharpout/          # ← 这个数字决定路线生死
  ```
- `.ply → .spz/.sog` 工具链候选是 `splat-transform`，但**是否可脚本化、Node 侧有无替代**仍未定 —— M2 前确认，若无则走 python 驱动
- relight 每天出一张，历史日期的 splat 是否回填？回填成本 = 天数 × 单张耗时
- 是否需要同时给 relight 的 **mac App 壁纸**用（`apps/mac`，本地交互式壁纸是 splat 的另一块甜点区，且无体积约束 —— 这条路上 66 MB **不是问题**，是本路线最容易见效的场景）
- 是否值得同时支持「多图 → splat」（SHARP 是单图模型，多图要另找方案）

---

## 附录：一手来源与复现方法

**已核实来源**
- 代码 / README / 许可证：`apple/ml-sharp`（因网络策略，用 `gh api repos/apple/ml-sharp/contents/<path> -H "Accept: application/vnd.github.raw"` 抓取，`curl` 直连 `raw.githubusercontent.com` 会超时）
- 权重体积：`curl -sSIL https://ml-site.cdn-apple.com/models/sharp/sharp_2572gikvuh.pt` → `content-length: 2809738232`
- gsplat 惰性加载：下载 `gsplat-1.5.3-py3-none-any.whl` 后读 `gsplat/cuda/_wrapper.py`
- 本机环境：Apple M4 Max / 128 GB / 数据卷剩 21 GB / `uv` 可用（可装 Python 3.13）

**关键文件索引（ml-sharp）**
| 关注点 | 文件 |
|---|---|
| CLI 参数与设备选择 | `src/sharp/cli/predict.py` |
| PLY 写出与颜色空间转换 | `src/sharp/utils/gaussians.py: save_ply` |
| gsplat 导入点（macOS 风险点） | `src/sharp/utils/gsplat.py:12` |
| 模型结构 | `src/sharp/models/` |

**消费方索引（relight）**
| 关注点 | 文件 |
|---|---|
| Hero 页（要改造的） | `apps/web/components/daily-hero.tsx`（977 行，`EntryBigImage` L603 / 容器 `.dh-banner` L440） |
| 流水线模板（要照抄的） | `apps/backend/src/jobs/wallpaper-video.ts`（349 行） |
| 集成契约 | `apps/backend/src/lib/wallpaper/video.ts: spawnHoneydoVideo` |
| CLI 路径解析 | `apps/backend/src/lib/config.ts: resolveHoneydoCliPath` |
| 新增 DB 列 | `apps/backend/src/db/schema.ts: dailyPicks`（L186 起，已有 2 个 video url 列可参照） |
