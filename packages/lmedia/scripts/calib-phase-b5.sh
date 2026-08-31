#!/bin/bash
# B5 edit-2511 校准（下载完成 + doctor 绿后跑）：同 prompt 复刻 A4 + 官方 40 步对比
set -uo pipefail
source /Users/stringzhao/workspace/lmedia-cli/.claude/worktrees/img/scripts/calib-lib.sh
CLI="node /Users/stringzhao/workspace/lmedia-cli/.claude/worktrees/img/dist/index.js"
OUT=/Users/stringzhao/ml/calib-img
LOG="$OUT/phase-b.log"
REF=/Users/stringzhao/ml/lb-local-gen/gallery/imgs/ref-pipi.png

run() {
  echo "=== [$(date +%H:%M:%S)] $*" | tee -a "$LOG"
  "$@" 2>&1 | tee -a "$LOG" | tail -1
  echo "=== exit=$? [$(date +%H:%M:%S)]" | tee -a "$LOG"
}

run $CLI image edit "保持参考图角色外观完全一致：他在厨房吃蜂蜜面包" --ref "$REF" --seed 42 -o "$OUT/after-edit-s42.png"
run $CLI image edit "保持参考图角色外观完全一致：他在厨房吃蜂蜜面包" --ref "$REF" --seed 43 -o "$OUT/after-edit-s43.png"
run $CLI image edit "保持参考图角色外观完全一致：他在厨房吃蜂蜜面包" --ref "$REF" --seed 42 --steps 40 -o "$OUT/after-edit40-s42.png"

echo "PHASE B5 (edit) DONE" | tee -a "$LOG"
