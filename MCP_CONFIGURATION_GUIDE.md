# Doubao Image MCP Server Configuration Guide

## 项目信息

**项目路径**: `/Users/stringzhao/workspace_sync/personal_projects/doubao-image`

**服务器名称**: `doubao-image-mcp`

**可用工具**: `generate_image` - 使用豆包AI生成图像并保存到本地（只需提供prompt参数）

## 配置步骤

### 1. 设置环境变量

在终端中设置豆包API密钥：

```bash
# 临时设置（当前会话有效）
export DOUBAO_API_KEY="你的API密钥"

# 永久设置（添加到shell配置文件）
echo 'export DOUBAO_API_KEY="你的API密钥"' >> ~/.zshrc  # 如果使用zsh
# 或
echo 'export DOUBAO_API_KEY="你的API密钥"' >> ~/.bashrc  # 如果使用bash

# 使配置生效
source ~/.zshrc  # 或 source ~/.bashrc
```

### 2. 创建Claude Code配置文件

Claude Code的MCP服务器配置文件位于：`~/.claude/claude_desktop_config.json`

如果文件不存在，创建它：

```bash
mkdir -p ~/.claude
```

然后创建配置文件（选择以下一种方式）：

#### 方式一：使用node直接运行（推荐）

```json
{
  "mcpServers": {
    "doubao-image-mcp": {
      "command": "node",
      "args": ["/Users/stringzhao/workspace_sync/personal_projects/doubao-image/dist/index.js"]
    }
  }
}
```

#### 方式二：使用npm脚本运行

```json
{
  "mcpServers": {
    "doubao-image-mcp": {
      "command": "npm",
      "args": ["start"],
      "cwd": "/Users/stringzhao/workspace_sync/personal_projects/doubao-image"
    }
  }
}
```

### 3. 创建/更新配置文件的命令

如果你已经有配置文件，需要合并配置。可以使用以下命令：

```bash
# 备份现有配置
cp ~/.claude/claude_desktop_config.json ~/.claude/claude_desktop_config.json.backup 2>/dev/null || true

# 创建新的配置文件（如果不存在）或替换现有配置
cat > ~/.claude/claude_desktop_config.json << 'EOF'
{
  "mcpServers": {
    "doubao-image-mcp": {
      "command": "node",
      "args": ["/Users/stringzhao/workspace_sync/personal_projects/doubao-image/dist/index.js"]
    }
  }
}
EOF
```

### 4. 验证配置

#### 验证服务器构建
```bash
cd /Users/stringzhao/workspace_sync/personal_projects/doubao-image
npm run build
```

#### 测试服务器启动
```bash
cd /Users/stringzhao/workspace_sync/personal_projects/doubao-image
DOUBAO_API_KEY="test-key" timeout 3 npm run dev
# 应该看到 "MCP server running on stdio" 输出
```

#### 验证Claude Code配置
重启Claude Code后，服务器应该自动启动。你可以在Claude Code中测试工具调用。

### 5. 在Claude Code中使用

重启Claude Code后，`generate_image` 工具应该可用。使用示例：

```
请使用 generate_image 工具生成一张图片，描述为："一只可爱的猫在月球上跳舞"
```

## 故障排除

### 1. 服务器无法启动
- 检查 `DOUBAO_API_KEY` 环境变量是否设置
- 运行 `npm run build` 确保构建成功
- 检查 `dist/index.js` 文件是否存在

### 2. Claude Code无法连接
- 确保配置文件路径正确：`~/.claude/claude_desktop_config.json`
- 重启Claude Code
- 检查Claude Code日志

### 3. API调用失败
- 验证API密钥是否正确
- 检查网络连接，确保可以访问 `https://ark.cn-beijing.volces.com`
- 查看服务器错误日志

## 项目文件说明

- `src/index.ts` - 服务器源代码
- `dist/index.js` - 编译后的服务器
- `package.json` - 依赖和脚本
- `generated_images/` - 生成的图像保存目录
- `README.md` - 详细使用说明

## 快速配置脚本

如果你想要一键配置，可以运行以下脚本：

```bash
#!/bin/bash
# 设置环境变量（替换 YOUR_API_KEY 为实际密钥）
export DOUBAO_API_KEY="YOUR_API_KEY"
echo 'export DOUBAO_API_KEY="YOUR_API_KEY"' >> ~/.zshrc

# 创建Claude Code配置
mkdir -p ~/.claude
cat > ~/.claude/claude_desktop_config.json << 'EOF'
{
  "mcpServers": {
    "doubao-image-mcp": {
      "command": "node",
      "args": ["/Users/stringzhao/workspace_sync/personal_projects/doubao-image/dist/index.js"]
    }
  }
}
EOF

echo "配置完成！请重启Claude Code。"
```

## 支持

如果遇到问题，请检查：
1. 项目是否成功构建：`cd /Users/stringzhao/workspace_sync/personal_projects/doubao-image && npm run build`
2. 环境变量是否设置：`echo $DOUBAO_API_KEY`
3. 配置文件是否存在且格式正确：`cat ~/.claude/claude_desktop_config.json`