# gcli 项目决策与模式

<!-- tags: typescript, cli, node, parseArgs, passthrough -->
## parseArgs tokens 模式做通用 flag 透传

**场景**：CLI wrapper 需把自身未识别的 flag 透传给底层命令（如 gcli 把 claude/agy 的原生 flag `--dangerously-skip-permissions` 等透传），且不想逐个声明。

**做法**：`node:util` 的 `parseArgs` 用 `strict: false, tokens: true`。遍历 tokens：
- known option → 进 `values`（wrapper 自己消费）
- unknown option → reconstruct 成 argv 元素（用 token 的 `rawName`；若 `inlineValue` 则拼 `${rawName}=${value}`）
- positional → 直接透传 value

**避坑**：
- `strict:false` 下 `values` 类型变 `string | boolean | undefined`，构造强类型返回时用 `typeof === "string"` / `=== true` narrow（满足 strict TS）。
- reconstruct 透传时**不要追加 `--`**——会让后端把 flag 当 positional，flag 失效。直接 `args.push(...passthrough)`。
- unknown option 在 `strict:false` 下按 boolean 处理（不消费下一个 value），所以 `--unknown value` 会拆成两个 token，透传顺序仍正确。
- 反例：用 `allowPositionals:true` + positionals 当透传——bare positional（手误）也会被吞。tokens 模式更可控（可决定 positional 是否透传）。

**参考**：`src/cli.ts` 的 `parseCliArgs`（gcli v2.1）。
