#!/bin/bash
# Phase A 基线：旧全局 lmedia（无引导旧行为），改代码前必须跑完
# GPU 串行，输出 ~/ml/calib-img/，日志带每条命令与耗时
set -uo pipefail
OUT=/Users/stringzhao/ml/calib-img
mkdir -p "$OUT"
LOG="$OUT/phase-a.log"
REF=/Users/stringzhao/ml/lb-local-gen/gallery/imgs/ref-pipi.png

run() {
  echo "=== [$(date +%H:%M:%S)] $*" | tee -a "$LOG"
  "$@" 2>&1 | tee -a "$LOG" | tail -1
  echo "=== exit=$? [$(date +%H:%M:%S)]" | tee -a "$LOG"
}

# A1 双 LoRA（绘本主场景）×2 种子
run lmedia image gen "午后庭院，小蜜蜂男孩蹲在草地上推红色小汽车" --style lbwatercolor --char pipi --seed 42 -o "$OUT/before-p1-s42.png"
run lmedia image gen "午后庭院，小蜜蜂男孩蹲在草地上推红色小汽车" --style lbwatercolor --char pipi --seed 43 -o "$OUT/before-p1-s43.png"
# A2 无 LoRA 对照 ×2 种子
run lmedia image gen "清晨湖边的一座红色小木屋，薄雾，平静水面倒映远处群山" --seed 42 -o "$OUT/before-p2-s42.png"
run lmedia image gen "清晨湖边的一座红色小木屋，薄雾，平静水面倒映远处群山" --seed 43 -o "$OUT/before-p2-s43.png"
# A3 文字+人物压力测
run lmedia image gen "教室黑板前，一位戴圆框眼镜的女教师在讲解方程，黑板上写着 E=mc^2" --seed 42 -o "$OUT/before-p3-s42.png"
# A4 edit-2509 基线
run lmedia image edit "保持参考图角色外观完全一致：他在厨房吃蜂蜜面包" --ref "$REF" --seed 42 -o "$OUT/before-edit-s42.png"

echo "PHASE A DONE" | tee -a "$LOG"
