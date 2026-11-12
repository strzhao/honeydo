/** h3-prompt 纯函数单测：组装矩阵（双轴/单轴/无轴/模板覆写/负向合并/槽位丢弃） */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NEGATIVES,
  DEFAULT_TEMPLATE,
  FALLBACK_CHAR_IDENTITY,
  FALLBACK_STYLE_SENTENCE,
  composePrompt,
  parseQuality,
  parseSize,
} from '../src/lib/h3-prompt.js';
import type { ResolvedChar, ResolvedStyle } from '../src/lib/h3-assets.js';

const style: ResolvedStyle = {
  key: 'picturebook',
  source: 'builtin',
  anchor: '/anchor.png',
  styleSentence: '水彩纸纹与洇开边缘',
  negatives: '无文字，无水印，无柔焦光晕，无圆形光斑。',
};
const char: ResolvedChar = {
  key: 'pipi',
  source: 'builtin',
  ref: '/ref.png',
  identity: '小蜜蜂男孩皮皮，黄头圆滚',
};

describe('composePrompt 组装矩阵', () => {
  it('双轴：Picture 1 角色 / Picture 2 风格 / 场景 / 负向，images 顺序 = [角色, 风格]', () => {
    const r = composePrompt({ scene: '草地上推红色小汽车', style, char });
    expect(r.prompt).toContain('Picture 1 是角色参考：小蜜蜂男孩皮皮，黄头圆滚，不要改变比例，不要简化特征。');
    expect(r.prompt).toContain('Picture 2 是画风参考：水彩纸纹与洇开边缘，画风自由适配到新构图。');
    expect(r.prompt).toContain('草地上推红色小汽车');
    expect(r.prompt.endsWith(DEFAULT_NEGATIVES)).toBe(true);
    expect(r.images).toEqual(['/ref.png', '/anchor.png']);
  });

  it('仅 style：无 Picture 1 行，char 为空轴', () => {
    const r = composePrompt({ scene: 's', style, char: null });
    expect(r.prompt).not.toContain('Picture 1');
    expect(r.prompt).toContain('Picture 2 是画风参考：水彩纸纹与洇开边缘');
    expect(r.images).toEqual(['/anchor.png']);
  });

  it('仅 char：无 Picture 2 行，style 为空轴', () => {
    const r = composePrompt({ scene: 's', style: null, char });
    expect(r.prompt).toContain('Picture 1 是角色参考：小蜜蜂男孩皮皮');
    expect(r.prompt).not.toContain('Picture 2');
    expect(r.images).toEqual(['/ref.png']);
  });

  it('无轴：t2i 纯文本（场景 + 负向），images 空', () => {
    const r = composePrompt({ scene: '一只鹤', style: null, char: null });
    expect(r.prompt).toBe(`一只鹤\n${DEFAULT_NEGATIVES}`);
    expect(r.images).toEqual([]);
  });

  it('用户库条目无句式 → 兜底句式注入（图即锚）', () => {
    const userChar: ResolvedChar = { key: 'x', source: 'user', ref: '/x.png', identity: '' };
    const r = composePrompt({ scene: 's', char: userChar });
    expect(r.prompt).toContain(FALLBACK_CHAR_IDENTITY);
    expect(r.prompt).toContain('Picture 1');
  });

  it('自定义模板（style.json 覆写）：槽位替换生效', () => {
    const custom: ResolvedStyle = {
      ...style,
      template: '角色：{char_identity}\n场景：{scene}\n{negatives}',
    };
    const r = composePrompt({ scene: '海边', style: custom, char });
    expect(r.prompt).toBe(`角色：小蜜蜂男孩皮皮，黄头圆滚\n场景：海边\n${DEFAULT_NEGATIVES}`);
  });

  it('自定义模板缺某轴 → 含缺失轴占位符的整行丢弃', () => {
    const custom: ResolvedStyle = {
      ...style,
      template: '角色：{char_identity}\n场景：{scene}\n{negatives}',
    };
    const r = composePrompt({ scene: '海边', style: custom, char: null });
    expect(r.prompt).toBe(`场景：海边\n${DEFAULT_NEGATIVES}`);
  });

  it('自定义模板已含负向句 → 不重复追加', () => {
    const custom: ResolvedStyle = {
      ...style,
      negatives: '无水印。',
      template: '场景：{scene}\n{negatives}',
    };
    const r = composePrompt({ scene: 's', style: custom });
    expect(r.prompt).toBe('场景：s\n无水印。');
    expect(r.prompt.match(/无水印。/g)?.length).toBe(1);
  });

  it('默认模板冻结：槽位形态与 C1c 配方一致', () => {
    expect(DEFAULT_TEMPLATE).toContain('Picture 1 是角色参考：{char_identity}，不要改变比例，不要简化特征。');
    expect(DEFAULT_TEMPLATE).toContain('Picture 2 是画风参考：{style_sentence}，画风自由适配到新构图。');
    expect(DEFAULT_TEMPLATE).toContain('{scene}');
    expect(DEFAULT_TEMPLATE).toContain('{negatives}');
  });
});

describe('quality / size 解析', () => {
  it('quality：缺省与 draft → draft；publish → publish；非法 → RangeError', () => {
    expect(parseQuality(undefined)).toBe('draft');
    expect(parseQuality('draft')).toBe('draft');
    expect(parseQuality('publish')).toBe('publish');
    expect(() => parseQuality('ultra')).toThrow(RangeError);
  });

  it('size：WxH 正整数合法；格式错/非正整数 → RangeError', () => {
    expect(parseSize('2048x1152')).toEqual({ width: 2048, height: 1152 });
    expect(parseSize(undefined)).toBeUndefined();
    expect(() => parseSize('abc')).toThrow(/WxH/);
    expect(() => parseSize('0x100')).toThrow(/WxH/);
    expect(() => parseSize('100')).toThrow(/WxH/);
  });
});
