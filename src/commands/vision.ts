import { Command } from 'commander';
import { visionCompletions } from '../lib/api.js';
import { extractContent, formatJson, formatError } from '../lib/format.js';

export function registerVision(program: Command) {
  const cmd = new Command('vision')
    .description('图片识别，分析图片内容并返回文本回复')
    .requiredOption('-i, --image <file|url>', '图片文件路径或 URL')
    .argument('[prompt]', '识别提示词，默认为"描述这张图片的内容"')
    .option('-t, --tokens <N>', '最大输出 token 数，默认 3000', (v) => parseInt(v, 10))
    .option('--json', '输出完整 JSON response')
    .action(async (prompt: string | undefined, options: Record<string, unknown>) => {
      try {
        const imageInput = options.image as string;
        const promptText = prompt || '描述这张图片的内容';

        const data = await visionCompletions(imageInput, promptText, {
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
