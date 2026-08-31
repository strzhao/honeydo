#!/bin/bash
# ab-edit-teacache.sh — TeaCache 出版档 A/B（page-20，30步 CFG4，同 prompt/refs/seed）
# 对照：page-20.png（30步 CFG4 生产档产物）；实验：同配置 + --cache 0.2
# daemon 时代的安全模型：任务走 daemon 串行队列（不抢卡）；唯一前置是现驻 edit daemon
# 内存里的 edit.py 是 TeaCache 接线前的旧版 → 必须先等它空闲再重启（busy 时 stop 会杀别人任务）
set -euo pipefail

OUT_DIR=/Users/stringzhao/workspace/little-bee/scripts/storybook-pipeline/out/beyond-wengweng
SMOKE_OUT=$OUT_DIR/pages/ab-tc-smoke-512.png
AB_OUT=$OUT_DIR/pages/page-20.teacache02.png
BASE_OUT=$OUT_DIR/pages/page-20.png

echo "== [0/3] 等 edit daemon 空闲（busy 时不碰，防误杀其他 session 任务）"
while true; do
  ST=$(lmedia image serve status 2>/dev/null | grep 'edit:' || true)
  case "$ST" in
    *busy*) sleep 60 ;;
    *pid*)  echo "daemon 空闲，重启以加载 TeaCache 代码…"; lmedia image serve stop >/dev/null 2>&1 || true; break ;;
    *未运行*) break ;;
    *) sleep 30 ;;  # 状态读取异常，保守等待
  esac
done

echo "== [1/3] 冒烟：512×288 8步 CFG4 + --cache 0.2（自动拉起新 daemon，加载新版 edit.py/teacache.py）"
time lmedia image edit "保持参考图中角色的外观完全一致：小蜜蜂男孩在草地上挥手。画风要求：低饱和淡雅色调；大色块平涂，画面扁平如手绘插画；角色用深色手绘轮廓线勾边；大面积留白背景，接近纸的本色；阴影极轻极淡" \
  --ref "$OUT_DIR/refs/pipi.png" --steps 8 --cache 0.2 --width 512 --height 288 --seed 42 -o "$SMOKE_OUT"
[ -s "$SMOKE_OUT" ] || { echo "❌ 冒烟无产物"; exit 1; }

echo "== [2/3] A/B：page-20 出版配置（2048×1152 30步 CFG4 + 负向）+ --cache 0.2"
PROMPT=$(python3 -c "import json; print(json.load(open('/tmp/ab-page20-config.json'))['prompt'])")
SEED=$(python3 -c "import json; print(json.load(open('/tmp/ab-page20-config.json'))['seed'])")
NEG=$(python3 -c "import json; print(json.load(open('/tmp/ab-page20-config.json'))['neg'])")
time lmedia image edit "$PROMPT" \
  --ref "$OUT_DIR/refs/mama.png" --ref "$OUT_DIR/refs/pipi.png" \
  --ref "$OUT_DIR/refs/maomao.png" --ref "$OUT_DIR/refs/baba.png" \
  --steps 30 --cfg 4 --neg "$NEG" --cache 0.2 \
  --width 2048 --height 1152 --seed "$SEED" -o "$AB_OUT"

echo "== [3/3] 对比（PSNR 仅参考；主验收 = 画风六要素/角色锚点人眼 + 管线 qwen gate）"
echo "对照: $BASE_OUT"
echo "实验: $AB_OUT"
if [ -s "$BASE_OUT" ] && [ -s "$AB_OUT" ]; then
  /Users/stringzhao/ml/lb-local-gen/.venv-train/bin/python - "$BASE_OUT" "$AB_OUT" <<'EOF'
import sys
import numpy as np
from PIL import Image

a = np.asarray(Image.open(sys.argv[1]).convert("RGB"), dtype=np.float32)
b = np.asarray(Image.open(sys.argv[2]).convert("RGB").resize((a.shape[1], a.shape[0])), dtype=np.float32)
mse = float(((a - b) ** 2).mean())
psnr = 10 * np.log10(255.0**2 / mse) if mse > 0 else 99.0
# 同 seed 同配方、仅步缓存差异 → 像素应高度接近：PSNR>28 基本无损，22-28 轻微可察，<22 警惕
print(f"PSNR: {psnr:.1f} dB（>28 近似无损 / 22-28 轻微 / <22 警惕）")
EOF
fi
