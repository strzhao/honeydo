#!/bin/bash
# Phase B 校准（干净状态重跑）：source calib-lib.sh 的 run()（正确退出码 + 清扫挂死进程）
set -uo pipefail
source /Users/stringzhao/workspace/lmedia-cli/.claude/worktrees/img/scripts/calib-lib.sh
CLI="node /Users/stringzhao/workspace/lmedia-cli/.claude/worktrees/img/dist/index.js"
OUT=/Users/stringzhao/ml/calib-img
LOG="$OUT/phase-b.log"
REF=/Users/stringzhao/ml/lb-local-gen/gallery/imgs/ref-pipi.png

# B1 新默认（CFG 4.0 + 官方负向模板）：复刻 A1/A2/A3
run $CLI image gen "午后庭院，小蜜蜂男孩蹲在草地上推红色小汽车" --style lbwatercolor --char pipi --seed 42 -o "$OUT/after-p1-s42.png"
run $CLI image gen "午后庭院，小蜜蜂男孩蹲在草地上推红色小汽车" --style lbwatercolor --char pipi --seed 43 -o "$OUT/after-p1-s43.png"
run $CLI image gen "清晨湖边的一座红色小木屋，薄雾，平静水面倒映远处群山" --seed 42 -o "$OUT/after-p2-s42.png"
run $CLI image gen "清晨湖边的一座红色小木屋，薄雾，平静水面倒映远处群山" --seed 43 -o "$OUT/after-p2-s43.png"
run $CLI image gen "教室黑板前，一位戴圆框眼镜的女教师在讲解方程，黑板上写着 E=mc^2" --seed 42 -o "$OUT/after-p3-s42.png"

# B3 快速档：8 步默认（含双 LoRA 叠加）/ 4 步极速
run $CLI image gen "午后庭院，小蜜蜂男孩蹲在草地上推红色小汽车" --style lbwatercolor --char pipi --fast --seed 42 -o "$OUT/fast-p1-s42.png"
run $CLI image gen "清晨湖边的一座红色小木屋，薄雾，平静水面倒映远处群山" --fast --seed 42 -o "$OUT/fast-p2-s42.png"
run $CLI image gen "清晨湖边的一座红色小木屋，薄雾，平静水面倒映远处群山" --fast 4 --seed 42 -o "$OUT/fast4-p2-s42.png"

# B4 批量：--num 2（CFG 引导）与 --fast --num 2（无引导）
run $CLI image gen "清晨湖边的一座红色小木屋，薄雾，平静水面倒映远处群山" --num 2 --seed 42 -o "$OUT/num-p2.png"
run $CLI image gen "午后庭院，小蜜蜂男孩蹲在草地上推红色小汽车" --style lbwatercolor --char pipi --fast --num 2 --seed 42 -o "$OUT/num-fast-p1.png"

# B6 回归：--cfg 1 逃生口
run $CLI image gen "清晨湖边的一座红色小木屋，薄雾，平静水面倒映远处群山" --cfg 1 --seed 42 -o "$OUT/cfg1-p2-s42.png"

echo "PHASE B (gen) DONE" | tee -a "$LOG"
