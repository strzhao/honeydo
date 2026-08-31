# honeydo 仓库地图（for AI agents）

一个 CLI 打通所有 AI 能力（对话/视觉/生图/视频/音效/TTS），npm 单包发布（`npm i -g honeydo`，bin `honeydo` + `hd`）。

## 结构

```
packages/
  cli/       主壳 @honeydo/cli：零依赖 dispatcher，spawn 兄弟包 dist 入口并透传退出码
  gcli/      LLM 对话（claude/agy/api 三后端，cc-switch 可选 provider 源）；bin gcli
  qwen/      本地 OpenAI 兼容端点（ask/vision/models/status）；bin qwen（deprecated）
  lmedia/    本地图/视/音生成（node 壳 + python/ 推理脚本，外部栈目录供 venv）；bin lmedia
  doubao/    云端生图（火山方舟，模型 fallback 链）；bin doubao
  minimax/   云端 TTS/声纹克隆；bin minimax
```

## 关键约定

- **主壳薄转发**：`packages/cli/src/index.ts` 只路由，不翻译参数（唯二拦截：`ask --backend`、`image gen --engine`）。改能力去对应能力包，不要往主壳堆逻辑
- **发布布局自相似**：发布的 tarball = 仓库布局（`packages/*/dist`），所以主壳相对路径 `../../<pkg>/dist/<entry>` 在 repo 与全局安装下都成立；lmedia 的 `python/` 随包发布
- **退出码契约**：0 成功 / 1 运行错误 / 2 参数错误，全仓统一
- **stdout/stderr 纪律**：结果 stdout、进度/交互 stderr
- 各能力包 `private: true`，不独立发布；只有根包 honeydo 发 npm
- tag 命名空间：`honeydo-v*`（publish.yml 触发 OIDC provenance 发布）

## 命令

```bash
npm run build       # 全部包
npm test            # 全部测试（gcli 271 + lmedia 50 + doubao 12 + minimax 16；qwen 无单测）
npm run typecheck   # tsc --noEmit 全部
npm run lint        # biome（仅 packages/gcli、packages/cli 作用域）
```

## 边界

- lmedia 的推理栈（venv + 权重）在仓外，`LMEDIA_RUNTIME` 指定；仓内只有 node 壳 + python 驱动脚本
- gcli 不写 `~/.claude/settings.json`；provider token 走子进程 argv（README 安全节已说明）
- 别在能力包里加对兄弟包的 import——保持各自独立可拆
