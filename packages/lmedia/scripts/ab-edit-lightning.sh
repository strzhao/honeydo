#!/bin/bash
# ab-edit-lightning.sh — Edit-2511 Lightning 8 步蒸馏 LoRA A/B 验证（P0）
# 对照组：beyond-wengweng page-20 的生产 30 步 CFG4 输出（另一 session 正在/已生成）
# 实验组：同 prompt/refs/seed/尺寸，--fast 8 步（cfg=1 + 蒸馏调度器）
# 安全：GPU 串行铁律——有其他 lmedia 推理进程在跑则拒绝启动（防爆内存）
set -euo pipefail

OUT_DIR=/Users/stringzhao/workspace/little-bee/scripts/storybook-pipeline/out/beyond-wengweng
SMOKE_OUT=$OUT_DIR/pages/ab-smoke-512.png
AB_OUT=$OUT_DIR/pages/page-20.lightning8.png
BASE_OUT=$OUT_DIR/pages/page-20.png.native.png   # 30 步对照（生产管线产物）

if pgrep -f "lmedia-cli/python/(gen|edit)\.py" >/dev/null; then
  echo "❌ 检测到其他 lmedia 推理进程在跑（GPU 串行铁律），等它结束再跑："
  pgrep -fl "lmedia-cli/python/(gen|edit)\.py"
  exit 1
fi
FREE=$(memory_pressure | grep 'free percentage' | grep -o '[0-9]*' | head -1)
if [ "${FREE:-0}" -lt 50 ]; then
  echo "❌ 内存空闲 ${FREE}% < 50%，拒绝启动（防 swap/SIGKILL）"
  exit 1
fi

echo "== [1/2] 冒烟：512×288 8步 fast edit（单 ref，验证 LoRA+调度器链路）"
time lmedia image edit "保持参考图中角色的外观完全一致：小蜜蜂男孩在草地上挥手。画风要求：低饱和淡雅色调；大色块平涂，画面扁平如手绘插画；角色用深色手绘轮廓线勾边；大面积留白背景，接近纸的本色；阴影极轻极淡" \
  --ref "$OUT_DIR/refs/pipi.png" --fast --width 512 --height 288 --seed 42 -o "$SMOKE_OUT"
[ -s "$SMOKE_OUT" ] || { echo "❌ 冒烟无产物"; exit 1; }
echo "✅ 冒烟产物: ${SMOKE_OUT}（先看一眼是否正常再继续）"

echo "== [2/2] A/B：page-20 全量复刻（2048×1152，同 prompt/refs/seed，--fast 8 步）"
PROMPT=$(python3 -c "import json; print(json.load(open('/tmp/ab-page20-config.json'))['prompt'])")
SEED=$(python3 -c "import json; print(json.load(open('/tmp/ab-page20-config.json'))['seed'])")
time lmedia image edit "$PROMPT" \
  --ref "$OUT_DIR/refs/mama.png" --ref "$OUT_DIR/refs/pipi.png" \
  --ref "$OUT_DIR/refs/maomao.png" --ref "$OUT_DIR/refs/baba.png" \
  --fast --width 2048 --height 1152 --seed "$SEED" -o "$AB_OUT"

echo
echo "== 对比 =="
echo "对照（30步 CFG4 生产档）: $BASE_OUT"
echo "实验（8步 Lightning）   : $AB_OUT"
if [ -s "$BASE_OUT" ] && [ -s "$AB_OUT" ]; then
  /Users/stringzhao/ml/lb-local-gen/.venv-train/bin/python - "$BASE_OUT" "$AB_OUT" <<'EOF'
import sys
import numpy as np
from PIL import Image

a = np.asarray(Image.open(sys.argv[1]).convert("RGB"), dtype=np.float32)
b = np.asarray(Image.open(sys.argv[2]).convert("RGB").resize((a.shape[1], a.shape[0])), dtype=np.float32)
mse = float(((a - b) ** 2).mean())
psnr = 10 * np.log10(255.0**2 / mse) if mse > 0 else 99.0
# 采样器不同 → 像素级不会高，PSNR>18 且肉眼结构一致即正常；核心验收是画风/角色/构图人眼对比 + qwen gate
print(f"PSNR(参考性指标): {psnr:.1f} dB")
EOF
fi
echo "下一步：人眼对比两张图（画风六要素/角色锚点/构图），通过则考虑进 little-bee lmedia.ts 的 --fast 档"
