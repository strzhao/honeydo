#!/bin/bash
# 校准脚本公共库：正确的退出码捕获 + 每跑完清一次可能挂死的 MPS python
# 背景：老 edit.py 出现过"打印结果后进程不退出、占 ~60GB 挂死"（MPS 退出清理死锁），
#       会级联挤兑后续 GPU 任务。校准期间跑完就清扫，生产侧已记入排障文档。
run() {
  echo "=== [$(date +%H:%M:%S)] $*" | tee -a "$LOG"
  "$@" > >(tee -a "$LOG" | tail -1) 2> >(tee -a "$LOG" >&2)
  local code=$?
  echo "=== exit=$code [$(date +%H:%M:%S)]" | tee -a "$LOG"
  # 清扫挂死的驱动进程（结果已落盘才允许杀：gen/edit 驱动打印 JSON 后即应退出）
  sleep 2
  pkill -9 -f "lmedia-cli/python/(gen|edit|upscale).py" 2>/dev/null
  return $code
}
