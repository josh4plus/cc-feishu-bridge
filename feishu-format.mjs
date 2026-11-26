/**
 * 飞书消息格式：把模型输出的 markdown 转成飞书 post 能渲染的样子，
 * 以及每次调用 Claude 时追加的系统提示（告诉它飞书里该怎么写）。
 *
 * 飞书 post 只认：纯文字、粗体、斜体、删除线、链接、@人、图片、emoji。
 * 不认：表格、代码块、标题层级、分隔线、引用块。所以这些在下面被降级处理。
 *
 * 注意：默认 replyFormat=text 时 mdToPost 不会被调用——纯文本消息根本不渲染 markdown，
 * 那就靠 FEISHU_RULES 让模型一开始就别写这些符号。
 */

/** 追加给模型的格式规范（走 --append-system-prompt，不进对话历史） */
export const FEISHU_RULES = `你在飞书里跟用户对话，输出会以飞书富文本渲染。按下面写：

1. 不要用 markdown 表格。一条数据写成一行，字段用「｜」隔开，例如：
   10-207 ｜ 41.11㎡ ｜ 到手 205 万 ｜ 4.99 万/㎡ ｜ 不满二
2. 不要用 # 标题、\`\`\` 代码块、--- 分隔线、> 引用。层级靠加粗和空行。
3. 加粗只给关键数字和结论，一句话里最多一处。
4. 列表最多两层，每条一行，一次不超过 10 条；超了就先给结论，问要不要展开。
5. 每段不超过 4 行，段与段之间空一行。
6. 结论放最前面，过程放后面。用户不想读长篇。
7. 不确定或需要用户拍板的地方，最后单独一行问出来。`;

const CELL_SPLIT = /\s*\|\s*/;

/** 把一段 markdown 表格转成「a ｜ b ｜ c」的行 */
function tableToLines(rows) {
  const out = [];
  let header = null;
  for (const raw of rows) {
    const cells = raw.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(CELL_SPLIT).map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue; // 分隔行
    if (!header) { header = cells; continue; }                          // 表头不单独占行
    out.push([{ tag: 'text', text: '' }]);
    out.push([{ tag: 'text', text: cells.join(' ｜ ') }]);
  }
  return out;
}

/** markdown -> 飞书 post 的 content 数组 */
export function mdToPost(md) {
  const lines = String(md || '').split('\n');
  const content = [];
  let inCode = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');

    // 代码块：去掉围栏，内容原样保留
    if (/^\s*```/.test(line)) { inCode = !inCode; continue; }

    // 表格：把连续的 | 行整体转成一行一条
    if (!inCode && /^\s*\|.*\|\s*$/.test(line)) {
      const block = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { block.push(lines[i]); i++; }
      i--;
      content.push(...tableToLines(block));
      continue;
    }

    if (!line.trim()) { content.push([{ tag: 'text', text: '' }]); continue; }
    if (!inCode && /^---+$/.test(line.trim())) continue;      // 分隔线直接丢掉

    let text = line;
    let isHeading = false;
    let prefix = '';
    if (!inCode && /^#{1,6}\s+/.test(text)) { text = text.replace(/^#{1,6}\s+/, ''); isHeading = true; }
    else if (!inCode && /^>\s?/.test(text)) { text = text.replace(/^>\s?/, ''); }
    else if (/^[-*]\s+/.test(text)) { text = text.replace(/^[-*]\s+/, ''); prefix = '· '; }

    // 行内：去反引号、链接降级成「文字 (url)」
    text = text.replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

    const runs = [];
    if (prefix) runs.push({ tag: 'text', text: prefix });
    if (isHeading) runs.push({ tag: 'text', text, style: ['bold'] });
    else {
      for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
        if (!part) continue;
        const m = part.match(/^\*\*([^*]+)\*\*$/);
        if (m) runs.push({ tag: 'text', text: m[1], style: ['bold'] });
        else runs.push({ tag: 'text', text: part });
      }
    }
    content.push(runs.length ? runs : [{ tag: 'text', text }]);
  }
  return { zh_cn: { content } };
}
