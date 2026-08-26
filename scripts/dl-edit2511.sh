#!/bin/bash
# 无代理直连 hf-mirror 下载 Qwen-Image-Edit-2511（~42GB，写入 HF 缓存布局供 snapOf 读取）
# 可断点续传：失败重跑同命令即可。日志：~/ml/dl-edit2511.log
set -euo pipefail
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
export no_proxy='*' NO_PROXY='*' HF_HUB_DISABLE_XET=1 HF_ENDPOINT=https://hf-mirror.com
exec /Users/stringzhao/ml/lb-local-gen/.venv-train/bin/hf download Qwen/Qwen-Image-Edit-2511
