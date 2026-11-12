/**
 * H3 prompt 组装（纯函数，C1c 产线验证配方）。
 *
 * 组装顺序：Picture 1 = 角色锚（分工句）→ Picture 2 = 风格锚（分工句）→ 场景 → 负向表（合并进 prompt）。
 * 模板槽位：{char_identity} / {style_sentence} / {scene} / {negatives}；style.json 可覆写模板。
 * 省略轴不注入对应分工句（整行含该轴占位符则丢弃）。
 * images 顺序即参考图顺序：[角色卡, 风格锚页]（Picture 1/2 与 encode 阶段 images 数组对齐）。
 */
import type { ResolvedChar, ResolvedStyle } from './h3-assets.js';

/** 默认负向表（C1c 验证配方；style.json negatives 可覆写） */
export const DEFAULT_NEGATIVES = '无文字，无水印，无柔焦光晕，无圆形光斑。';

/** 默认模板（C1c 验证配方的槽位化形态；style.json template 可覆写） */
export const DEFAULT_TEMPLATE = [
  'Picture 1 是角色参考：{char_identity}，不要改变比例，不要简化特征。',
  'Picture 2 是画风参考：{style_sentence}，画风自由适配到新构图。',
  '{scene}',
  '{negatives}',
].join('\n');

/** 用户库角色无身份锁定句时的兜底（图即锚，句式 instruct 用） */
export const FALLBACK_CHAR_IDENTITY = '参考 Picture 1 图像中的角色，其五官、发型、服饰与整体外观特征完全保持一致';
/** 用户库风格无画风句时的兜底 */
export const FALLBACK_STYLE_SENTENCE = '严格参照 Picture 2 图像的画风：笔触、纸纹、色彩与光影语言保持一致';

export interface ComposeInput {
  scene: string;
  style?: ResolvedStyle | null;
  char?: ResolvedChar | null;
}

export interface ComposeOutput {
  prompt: string;
  /** 参考图绝对路径，顺序 = Picture 1（角色）、Picture 2（风格）；t2i 为空数组 */
  images: string[];
  negatives: string;
}

export function composePrompt(input: ComposeInput): ComposeOutput {
  const template = input.style?.template ?? DEFAULT_TEMPLATE;
  const negatives = input.style?.negatives ?? DEFAULT_NEGATIVES;
  const charIdentity = input.char?.identity || FALLBACK_CHAR_IDENTITY;
  const styleSentence = input.style?.styleSentence || FALLBACK_STYLE_SENTENCE;

  // 省略轴 → 整行丢弃（该行引用了缺失轴的占位符）
  const lines = template.split('\n').filter((line) => {
    if (!input.char && line.includes('{char_identity}')) return false;
    if (!input.style && line.includes('{style_sentence}')) return false;
    return true;
  });
  const filled = lines
    .join('\n')
    .replaceAll('{char_identity}', charIdentity)
    .replaceAll('{style_sentence}', styleSentence)
    .replaceAll('{scene}', input.scene)
    .replaceAll('{negatives}', negatives);

  // negatives 合并进 prompt（自定义模板已含则不重复追加）
  const prompt = filled.includes(negatives) ? filled : `${filled}\n${negatives}`;

  const images: string[] = [];
  if (input.char) images.push(input.char.ref); // Picture 1 = 角色锚
  if (input.style) images.push(input.style.anchor); // Picture 2 = 风格锚
  return { prompt, images, negatives };
}

/** quality 档：draft 2048x1152 直出 / publish 5472x3072 生成后 LANCZOS 缩回 2736x1536 */
export const QUALITIES = ['draft', 'publish'] as const;
export type H3Quality = (typeof QUALITIES)[number];

/** quality → 最终名义分辨率（与 python/h3_generate.py QUALITY_SIZES 的 final 尺寸对齐） */
export const QUALITY_RESOLUTION: Record<H3Quality, string> = {
  draft: '2048x1152',
  publish: '2736x1536',
};

export function parseQuality(v: string | undefined): H3Quality {
  if (v === undefined || v === '' || v === 'draft') return 'draft';
  if (v === 'publish') return 'publish';
  throw new RangeError(`--quality 仅支持 draft|publish: ${v}`);
}

/** batch 清单 size 值域："WxH"（两侧均为正整数） */
export const SIZE_RE = /^\d+x\d+$/;

export function parseSize(v: string | undefined): { width: number; height: number } | undefined {
  if (v === undefined || v === '') return undefined;
  if (!SIZE_RE.test(v)) throw new RangeError(`size 需为 "WxH"（两侧均为正整数）: ${v}`);
  const [w, h] = v.split('x').map((n) => parseInt(n, 10));
  if (w <= 0 || h <= 0) throw new RangeError(`size 需为 "WxH"（两侧均为正整数）: ${v}`);
  return { width: w, height: h };
}
