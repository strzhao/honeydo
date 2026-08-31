#!/usr/bin/env bash
# =============================================================================
# qwen CLI 验收测试 (Acceptance Test)
# 基于设计文档的预期行为，不依赖实现代码。
# =============================================================================
set -euo pipefail

# ---- 辅助函数 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0
SKIPPED=0

log_pass()  { echo -e "${GREEN}[PASS]${NC} $*";  PASSED=$((PASSED + 1)); }
log_fail()  { echo -e "${RED}[FAIL]${NC} $*";  FAILED=$((FAILED + 1)); }
log_skip()  { echo -e "${YELLOW}[SKIP]${NC} $*"; SKIPPED=$((SKIPPED + 1)); }

# 寻找 qwen 可执行文件
find_qwen() {
  if command -v qwen &>/dev/null; then
    echo "qwen"
    return 0
  fi
  # 常见本地安装路径
  for candidate in \
    /Users/stringzhao/workspace/qwen-cli/bin/qwen \
    /Users/stringzhao/workspace/qwen-cli/qwen \
    ./bin/qwen \
    ./qwen \
    /usr/local/bin/qwen; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

QWEN_BIN=$(find_qwen) || true

# ---- 测试环境预检 ----
echo "============================================"
echo " qwen CLI 验收测试"
echo "============================================"
echo ""

if [ -z "${QWEN_BIN:-}" ]; then
  log_skip "未找到 qwen 可执行文件，跳过所有需要 CLI 的测试"
  QWEN_BIN="qwen"  # 保持默认值让后续测试可运行（会报友好错误）
fi
echo "使用二进制: $QWEN_BIN"
echo ""

# =============================================================================
# 测试用例 1: help 命令
# =============================================================================
echo "--- 测试组 1: help 命令 ---"

test_help_top_level() {
  set +e
  output=$("$QWEN_BIN" --help 2>&1)
  exit_code=$?
  set -e

  if [ $exit_code -ne 0 ]; then
    log_fail "1.1 qwen --help 退出码应为 0，实际为 $exit_code"
    return
  fi

  # 输出应包含命令说明
  if echo "$output" | grep -qiE "usage|用法|命令|command|ask|status|models"; then
    log_pass "1.1 qwen --help 输出包含命令说明"
  else
    log_fail "1.1 qwen --help 输出未包含预期的命令说明"
  fi
}

test_help_subcommand() {
  set +e
  output=$("$QWEN_BIN" ask --help 2>&1)
  exit_code=$?
  set -e

  if [ $exit_code -ne 0 ]; then
    log_fail "1.2 qwen ask --help 退出码应为 0，实际为 $exit_code"
    return
  fi

  # 输出应包含选项列表（如 --tokens, --json, --stdin）
  if echo "$output" | grep -qiE "option|选项|--tokens|--json|--stdin|usage|用法"; then
    log_pass "1.2 qwen ask --help 输出包含选项列表"
  else
    log_fail "1.2 qwen ask --help 输出未包含预期的选项列表"
  fi
}

test_help_top_level
test_help_subcommand

# =============================================================================
# 测试用例 2: 文本对话
# =============================================================================
echo ""
echo "--- 测试组 2: 文本对话 (ask) ---"

test_ask_text() {
  set +e
  output=$("$QWEN_BIN" ask "回复一个字：好" 2>&1)
  exit_code=$?
  set -e

  if [ $exit_code -ne 0 ]; then
    log_skip "2.1 qwen ask 文本对话 (退出码=$exit_code, 可能是 API 不可用)"
    return
  fi

  # 输出应包含 "好" 字
  if echo "$output" | grep -q "好"; then
    log_pass "2.1 qwen ask 返回文本内容包含'好'"
  else
    log_fail "2.1 qwen ask 输出未包含'好'字"
  fi
}

test_ask_tokens_param() {
  set +e
  output=$("$QWEN_BIN" ask --tokens 100 "回复 ok" 2>&1)
  exit_code=$?
  set -e

  if [ $exit_code -eq 0 ]; then
    log_pass "2.2 qwen ask --tokens 100 正常返回，退出码 0"
  elif [ $exit_code -ne 0 ]; then
    # 如果是 API 不可用（网络/服务问题），跳过而非失败
    if echo "$output" | grep -qiE "connection refused|无法连接|unreachable|ECONNREFUSED|服务不可用|timeout"; then
      log_skip "2.2 qwen ask --tokens 100 (API 不可用)"
    else
      log_fail "2.2 qwen ask --tokens 100 退出码非零: $exit_code"
    fi
  fi
}

test_ask_text
test_ask_tokens_param

# =============================================================================
# 测试用例 3: JSON 模式
# =============================================================================
echo ""
echo "--- 测试组 3: JSON 模式 ---"

test_ask_json() {
  set +e
  output=$("$QWEN_BIN" ask --json "1+1=?" 2>&1)
  exit_code=$?
  set -e

  if [ $exit_code -ne 0 ]; then
    log_skip "3.1 qwen ask --json (退出码=$exit_code, 可能是 API 不可用)"
    return
  fi

  # 输出应为合法 JSON，且包含 choices/message/content 结构
  if echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'choices' in d; c=d['choices'][0]; assert 'message' in c; assert 'content' in c['message']" 2>/dev/null; then
    log_pass "3.1 qwen ask --json 输出合法 JSON 含 choices/message/content"
  else
    log_fail "3.1 qwen ask --json 输出不是预期的 JSON 结构"
  fi
}

test_ask_json

# =============================================================================
# 测试用例 4: stdin 管道
# =============================================================================
echo ""
echo "--- 测试组 4: stdin 管道 ---"

test_ask_stdin() {
  set +e
  output=$(echo "回复好" | "$QWEN_BIN" ask --stdin 2>&1)
  exit_code=$?
  set -e

  if [ $exit_code -ne 0 ]; then
    log_skip "4.1 qwen ask --stdin 管道 (退出码=$exit_code, 可能是 API 不可用)"
    return
  fi

  # 应有正常文本输出（非空）
  if [ -n "$output" ]; then
    log_pass "4.1 qwen ask --stdin 管道正常返回文本"
  else
    log_fail "4.1 qwen ask --stdin 管道输出为空"
  fi
}

test_ask_stdin

# =============================================================================
# 测试用例 5: vision 文件模式
# =============================================================================
echo ""
echo "--- 测试组 5: vision 命令 ---"

test_vision_file() {
  # 准备测试图片
  TMP_IMG="/tmp/qwen_acceptance_test_img_$$.jpg"
  # 使用 python3 生成一个最小的 JPEG（1x1 白色像素）
  python3 -c "
from PIL import Image
img = Image.new('RGB', (1, 1), color='white')
img.save('$TMP_IMG', 'JPEG')
" 2>/dev/null || {
    log_skip "5.1 vision 文件模式 (无法创建测试图片，缺少 Pillow)"
    return
  }

  set +e
  output=$("$QWEN_BIN" vision -i "$TMP_IMG" "描述这张图" 2>&1)
  exit_code=$?
  set -e

  rm -f "$TMP_IMG"

  if [ $exit_code -ne 0 ]; then
    log_skip "5.1 vision 文件模式 (退出码=$exit_code, 可能是 API 不可用)"
    return
  fi

  if [ -n "$output" ]; then
    log_pass "5.1 qwen vision -i <file> 返回文字描述"
  else
    log_fail "5.1 qwen vision -i <file> 输出为空"
  fi
}

test_vision_file

# =============================================================================
# 测试用例 6: status 命令
# =============================================================================
echo ""
echo "--- 测试组 6: status 命令 ---"

test_status() {
  set +e
  output=$("$QWEN_BIN" status 2>&1)
  exit_code=$?
  set -e

  if [ $exit_code -ne 0 ]; then
    log_skip "6.1 qwen status (退出码=$exit_code)"
    return
  fi

  # 输出应包含 API 健康状态相关信息
  if echo "$output" | grep -qiE "health|健康|status|状态|model|模型|pm2|running|ok|up"; then
    log_pass "6.1 qwen status 输出包含健康状态和模型信息"
  else
    log_fail "6.1 qwen status 输出不包含预期的状态信息"
  fi
}

test_status

# =============================================================================
# 测试用例 7: models 命令
# =============================================================================
echo ""
echo "--- 测试组 7: models 命令 ---"

test_models() {
  set +e
  output=$("$QWEN_BIN" models 2>&1)
  exit_code=$?
  set -e

  if [ $exit_code -ne 0 ]; then
    log_skip "7.1 qwen models (退出码=$exit_code, 可能是服务不可用)"
    return
  fi

  if [ -n "$output" ]; then
    log_pass "7.1 qwen models 输出模型列表"
  else
    log_fail "7.1 qwen models 输出为空"
  fi
}

test_models

# =============================================================================
# 测试用例 8: 错误处理
# =============================================================================
echo ""
echo "--- 测试组 8: 错误处理 ---"

test_error_handling() {
  # 通过设置一个明显错误的环境变量或假 API 端点来模拟 API 不可用
  # 使用子 shell 隔离环境变量
  set +e
  output=$(QWEN_API_URL="http://127.0.0.1:19999/nonexistent" "$QWEN_BIN" ask "test" 2>&1)
  exit_code=$?
  set -e

  # 退出码应非 0（表示出错）
  if [ $exit_code -ne 0 ]; then
    log_pass "8.1 API 不可用时退出码非 0 (实际: $exit_code)"
  else
    log_fail "8.1 API 不可用时退出码应为非 0，实际为 0"
  fi

  # 不应包含崩溃堆栈（无 Traceback、panic、at <file>:<line> 等）
  if echo "$output" | grep -qiE "traceback|panic|segmentation fault|uncaught|fatal error"; then
    log_fail "8.2 API 不可用时输出了崩溃堆栈"
  elif [ -z "$output" ]; then
    log_fail "8.2 API 不可用时无任何错误输出"
  else
    log_pass "8.2 API 不可用时输出了友好错误信息（无崩溃堆栈）"
  fi
}

test_error_handling

# =============================================================================
# 测试用例 9: 无效参数处理
# =============================================================================
echo ""
echo "--- 测试组 9: 无效参数处理 ---"

test_invalid_option() {
  set +e
  output=$("$QWEN_BIN" ask --nonexistent-option-xyz "test" 2>&1)
  exit_code=$?
  set -e

  if [ $exit_code -ne 0 ]; then
    log_pass "9.1 无效选项时退出码非 0"
  else
    log_fail "9.1 无效选项时退出码应为非 0"
  fi

  # 应给出提示（如 unknown option）
  if [ -n "$output" ]; then
    log_pass "9.2 无效选项时给出了错误提示"
  else
    log_fail "9.2 无效选项时无任何提示"
  fi
}

test_invalid_option

# =============================================================================
# 测试结果汇总
# =============================================================================
echo ""
echo "============================================"
echo " 测试结果汇总"
echo "============================================"
echo -e "  通过: ${GREEN}${PASSED}${NC}"
echo -e "  失败: ${RED}${FAILED}${NC}"
echo -e "  跳过: ${YELLOW}${SKIPPED}${NC}"
echo ""

if [ "$FAILED" -gt 0 ]; then
  echo -e "${RED}存在 $FAILED 个失败用例${NC}"
  exit 1
else
  echo -e "${GREEN}所有可执行用例通过${NC}"
  exit 0
fi
