/** #标签 / @项目 的轻量解析。提取失败不报错，原文永远完整保留。 */

/**
 * 名称识别规则：`#` 或 `@` 之后、直到首个空白或标点为止的一段连续字符即为名称。
 * 标点包含中英文常见分隔符（冒号、逗号、句号、顿号、括号、引号等），因此
 * "@AI：编写需求矩阵" 的项目名是 "AI"，"："及其后内容不计入名称。
 * 允许出现在名称中的字符示例：字母、数字、汉字、下划线、连字符。
 */
const NAME_CHARS = "[^\\s#@，。：；、！？,.:;!?（）()【】\\[\\]「」『』《》<>“”‘’\"'…|/\\\\]";
export const TAG_RE = new RegExp(`#(${NAME_CHARS}+)`, "g");
export const PROJ_RE = new RegExp(`@(${NAME_CHARS}+)`);
/** 输入框光标处正在键入的 #/@ 词缀（用于自动补全），到行尾为止 */
export const TOKEN_TAIL_RE = new RegExp(`([#@])(${NAME_CHARS}*)$`);

export function parseTags(content: string): string[] {
  return [...new Set([...content.matchAll(TAG_RE)].map((m) => m[1]))];
}

export function parseProject(content: string): string | null {
  const m = content.match(PROJ_RE);
  return m ? m[1] : null;
}

export const pad2 = (n: number) => String(n).padStart(2, "0");

export const fmtDate = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export const todayStr = () => fmtDate(new Date());

/** 从 created_at 取 HH:MM 显示 */
export const timeOf = (iso: string) => iso.slice(11, 16);
