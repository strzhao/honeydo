import { Command } from 'commander';
import { chatCompletions } from '../lib/api.js';
import { extractContent, formatJson, formatError } from '../lib/format.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

export function registerAsk(program: Command) {
  const cmd = new Command('ask')
    .description('文本对话，调用 Qwen API 返回纯文本回复')
    .argument('[prompt]', '对话提示词')
    .option('-t, --tokens <N>', '最大输出 token 数，默认 1000', (v) => parseInt(v, 10))
    .option('--json', '输出完整 JSON response')
    .option('--stdin', '强制从 stdin 读取 prompt')
    .action(async (prompt: string | undefined, options: Record<string, unknown>) => {
      try {
        // 解析 prompt
        let finalPrompt = prompt || '';
        const useStdin = options.stdin || !process.stdin.isTTY;

        if (useStdin) {
          const stdinContent = await readStdin();
          if (stdinContent) {
            finalPrompt = finalPrompt ? `${finalPrompt}\n${stdinContent}` : stdinContent;
          }
        }

        if (!finalPrompt) {
          console.error('错误: 请提供对话内容（参数或管道输入）');
          console.error('用法: qwen ask "你的问题"  或  echo "你的问题" | qwen ask');
          process.exit(1);
        }

        const data = await chatCompletions(finalPrompt, {
          maxTokens: options.tokens as number | undefined,
        });

        if (options.json) {
          console.log(formatJson(data));
        } else {
          console.log(extractContent(data));
        }
      } catch (err) {
        console.error(formatError(err));
        process.exit(1);
      }
    });

  program.addCommand(cmd);
}
