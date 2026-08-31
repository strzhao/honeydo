# gcli 知识库索引

- [parseArgs tokens 通用透传](patterns.md#parseargs-tokens-模式做通用-flag-透传) — CLI wrapper 透传未知 flag 的可复用模式（strict:false + tokens:true）
- [gcli api 后端绕过 agent thinking 放大](patterns.md#gcli-api-后端纯-http-绕过-claude-agent-的-thinking-放大) — 纯 HTTP vs claude agent（53min→45s / thinking 259×）；model sanitize k3[1M]→k3；不要 disabled thinking
- [交互 CLI 的 TTY 硬门控](patterns.md#交互式-cli-wrapper-的-tty-硬门控pickerprompt-类交互) — picker/prompt 交互必须 isInteractive() 闭集门控：非 TTY 零 prompt 零外部读；UI 走 stderr 保 stdout 纯净
- [pty 驱动 TTY 交互验证](patterns.md#pty-驱动-tty-交互-cli-的真实场景验证零-api-成本) — `printf | script -q /dev/null` 伪终端实测交互 CLI + `-- --version` 透传短路锚点，零 API 成本
- [兼容生态辅助 API 字段类型须实测](patterns.md#anthropic-兼容生态辅助-api-的字段类型必须-curl-实测不可从工具源码推断) — jq 不暴露类型差异：GLM nextResetTime=epoch-ms vs kimi resetTime=ISO；curl 实测+类型归一化，勿按臆断类型拒数据
