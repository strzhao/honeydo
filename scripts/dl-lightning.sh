#!/bin/bash
# 无代理直连 hf-mirror 下载 LightX2V 2512-Lightning 蒸馏 LoRA（8步默认 + 4步极速，fp32 配 bf16 base）
# 用户约束：下载严禁走 VPN proxy（流量配额）。
# 坑：hf_hub 1.28 的 curl_cffi 传输层会吃 macOS 系统代理，unset 不够，必须 no_proxy='*' 覆盖。
set -euo pipefail
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
export no_proxy='*' NO_PROXY='*' HF_HUB_DISABLE_XET=1 HF_ENDPOINT=https://hf-mirror.com
HF=/Users/stringzhao/ml/lb-local-gen/.venv-train/bin/hf
DEST=/Users/stringzhao/ml/lb-local-gen/loras
$HF download lightx2v/Qwen-Image-2512-Lightning \
  Qwen-Image-2512-Lightning-8steps-V1.0-fp32.safetensors \
  Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors \
  --local-dir "$DEST"
ls -lh "$DEST"/*.safetensors
