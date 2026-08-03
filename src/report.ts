/** 报告生成引擎：占位符填充（「直接整理」）与工作项总结渲染（「AI 总结」），纯前端、离线。 */

import type { Entry } from "./types";
import { pad2, timeOf, todayStr } from "./parse";
import type { ReportType } from "./templates";

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

function dayTitle(date: string): string {
  const d = new Date(date + "T00:00");
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAY[d.getDay()]}`;
}

/** 按天分组的记录列表（{{entries}}；直接整理模式下 {{summary}} 同此） */
function formatEntries(entries: Entry[]): string {
  if (entries.length === 0) return "（该时间范围内没有记录）";
  const out: string[] = [];
  let cur = "";
  for (const e of entries) {
    if (e.entry_date !== cur) {
      cur = e.entry_date;
      out.push(`### ${dayTitle(cur)}`);
    }
    out.push(`- ${timeOf(e.created_at)} ${e.content}`);
  }
  return out.join("\n");
}

function formatGrouped(entries: Entry[], keysOf: (e: Entry) => string[], prefix: string): string {
  if (entries.length === 0) return "（该时间范围内没有记录）";
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const keys = keysOf(e);
    for (const k of keys.length ? keys : ["__other__"]) {
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
    }
  }
  const names = [...groups.keys()].sort((a, b) =>
    a === "__other__" ? 1 : b === "__other__" ? -1 : groups.get(b)!.length - groups.get(a)!.length,
  );
  return names
    .map((k) => {
      const title = k === "__other__" ? "其他" : `${prefix}${k}`;
      const lines = groups
        .get(k)!
        .map((e) => `- [${e.entry_date.slice(5)} ${timeOf(e.created_at)}] ${e.content}`);
      return `### ${title}\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

function formatStats(entries: Entry[]): string {
  const days = new Set(entries.map((e) => e.entry_date)).size;
  const freq = new Map<string, number>();
  entries.forEach((e) => e.tags.forEach((t) => freq.set(t, (freq.get(t) ?? 0) + 1)));
  const top = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t, n]) => `#${t}(${n})`);
  let s = `共 ${entries.length} 条记录，覆盖 ${days} 天`;
  if (top.length) s += `；标签 Top${top.length}：${top.join(" ")}`;
  return s;
}

export type Range = { start: string; end: string };

/** 时间范围的显示写法：单日只写一个日期 */
export const rangeLabel = (range: Range) =>
  range.start === range.end ? range.start : `${range.start} ~ ${range.end}`;

/** 占位符全集（v1.0 定稿）。summary 缺省时等同 entries。 */
function sectionVars(entries: Entry[], range: Range, summary?: string): Record<string, () => string> {
  return {
    date: () => todayStr(),
    range: () => rangeLabel(range),
    entries: () => formatEntries(entries),
    entries_by_tag: () => formatGrouped(entries, (e) => e.tags, "#"),
    entries_by_project: () => formatGrouped(entries, (e) => (e.project ? [e.project] : []), "@"),
    summary: () => summary ?? formatEntries(entries),
    stats: () => formatStats(entries),
  };
}

/** 未知占位符原样保留，不报错 */
function applyVars(body: string, vars: Record<string, () => string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (raw, key: string) => (key in vars ? vars[key]() : raw));
}

/** 「直接整理」：把记录按占位符填进模板正文。
 *  summaryOverride 保留给调用方覆写 {{summary}}；AI 总结走 renderWorkSummary，不经过这里。 */
export function fillTemplate(
  body: string,
  entries: Entry[],
  range: Range,
  summaryOverride?: string,
): string {
  return applyVars(body, sectionVars(entries, range, summaryOverride));
}

/* ---------------- AI 总结：模板大纲 ---------------- */

/** 数据类占位符：由本文件精确渲染，绝不交给模型 */
const DATA_VARS = ["entries", "entries_by_tag", "entries_by_project", "stats"];

export interface MdSection {
  /** 章节名（{{date}}/{{range}} 已解析） */
  heading: string;
  /** 原始章节正文（含占位符） */
  body: string;
  /** prose = 由模型撰写；data = 由占位符精确填充 */
  kind: "prose" | "data";
  /** prose 节正文里的自由文字，作为写作要求喂给模型，不直接输出 */
  instructions: string;
}

export interface MdOutline {
  title: string;
  /** 标题与首个章节之间的内容（如「汇报人：」），原样保留 */
  preamble: string;
  sections: MdSection[];
}

/** 章节名归一化：去空白 + 小写。模型回填的章节名据此与模板对齐。 */
export const normHeading = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/** 标题与章节名里只解析 {{date}}/{{range}}——其余占位符是多行块，注进标题会炸掉 Markdown */
function fillLineVars(line: string, range: Range): string {
  return line.replace(/\{\{(date|range)\}\}/g, (_, k: string) =>
    k === "date" ? todayStr() : rangeLabel(range),
  );
}

function makeSection(heading: string, body: string, range: Range): MdSection {
  const keys = [...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
  // 含 {{summary}} 或压根没有数据类占位符 → 交给模型。含 {{summary}} 又含 {{stats}} 的混排节
  // 仍算 prose，渲染时逐个占位符就地替换，AI 结果不会被整节吞掉。
  const kind = keys.includes("summary") || !keys.some((k) => DATA_VARS.includes(k)) ? "prose" : "data";
  const instructions =
    kind === "prose"
      ? fillLineVars(body, range)
          .replace(/\{\{\w+\}\}/g, " ")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .join("\n")
      : "";
  return { heading, body, kind, instructions };
}

/** 解析 Markdown 模板为「标题 + 章节」大纲（AI 总结模式用）。二级及以下标题一律视作章节。 */
export function parseMdOutline(body: string, range: Range, fallbackTitle: string): MdOutline {
  let title = "";
  const preamble: string[] = [];
  const sections: MdSection[] = [];
  let cur: { heading: string; lines: string[] } | null = null;

  const flush = () => {
    if (cur) sections.push(makeSection(cur.heading, cur.lines.join("\n"), range));
    cur = null;
  };

  for (const line of body.split(/\r?\n/)) {
    const h2 = line.match(/^#{2,}\s+(.*)$/);
    if (h2) {
      flush();
      cur = { heading: fillLineVars(h2[1].trim(), range), lines: [] };
      continue;
    }
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1 && !cur && title === "") {
      title = fillLineVars(h1[1].trim(), range);
      continue;
    }
    (cur ? cur.lines : preamble).push(line);
  }
  flush();

  return { title: title || fallbackTitle, preamble: preamble.join("\n").trim(), sections };
}

/* ---------------- AI 总结：结果模型与渲染 ---------------- */

export interface WorkItem {
  title: string;
  /** 由 refs 反推的 @项目名（不含 @）；无则空串 */
  project: string;
  /** 依据的记录编号（1 起，对应传入的 entries 下标 +1） */
  refs: number[];
  /** 段落式 SMART 正文 */
  body: string;
}
export interface WorkSection {
  heading: string;
  items: WorkItem[];
}
export interface WorkSummary {
  overview: string;
  sections: WorkSection[];
}

const CN_DIGITS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 1→"一" … 99→"九十九"；超出范围回退阿拉伯数字 */
export function cnNum(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 99) return String(n);
  if (n < 10) return CN_DIGITS[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return `${t > 1 ? CN_DIGITS[t] : ""}十${o ? CN_DIGITS[o] : ""}`;
}

const SMART_LABEL_RE =
  /^\s*(?:[SMARTsmart]|具体|可衡量|可量化|可达成|可实现|相关性|相关|时限|时间)\s*(?:[（(][^）)]{0,10}[）)])?\s*[:：]\s*/;

/** 单段化：模型偶尔会吐出列表符号、加粗、SMART 要素标签或换行，这里确定性清除。
 *  提示词只是尽力而为，格式由这里保证。 */
export function sanitizeParagraph(s: string): string {
  let out = s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*+•·]|\d+\s*[.、)])\s+/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i < 5 && SMART_LABEL_RE.test(out); i++) out = out.replace(SMART_LABEL_RE, "");
  return out.trim();
}

/** 溯源行的日期由 refs 回查 entries 得出，不采信模型给的日期 */
function refDates(refs: number[], entries: Entry[]): string[] {
  const set = new Set<string>();
  for (const r of refs) {
    const e = entries[r - 1];
    if (e) set.add(e.entry_date.slice(5));
  }
  return [...set].sort();
}

/**
 * 把模型产出的工作项按模板大纲渲染为最终 Markdown。
 * entries 必须与生成时传给 aiWorkSummary 的是同一个数组、同一顺序——refs 就是它的下标 +1。
 */
export function renderWorkSummary(
  outline: MdOutline,
  summary: WorkSummary,
  entries: Entry[],
  range: Range,
  notes: string[] = [],
): string {
  // 模板允许重名章节，故按「归一化名 + 同名出现序号」建桶
  const bucketKey = (seen: Map<string, number>, heading: string) => {
    const k = normHeading(heading);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return `${k}#${n}`;
  };

  const aiSeen = new Map<string, number>();
  const aiBuckets = new Map<string, WorkItem[]>();
  for (const s of summary.sections) {
    const key = bucketKey(aiSeen, s.heading);
    aiBuckets.set(key, [...(aiBuckets.get(key) ?? []), ...s.items]);
  }

  const outSeen = new Map<string, number>();
  const matched = new Set<string>();
  const perSection = outline.sections.map((sec) => {
    if (sec.kind !== "prose") return [] as WorkItem[];
    const key = bucketKey(outSeen, sec.heading);
    matched.add(key);
    return aiBuckets.get(key) ?? [];
  });

  const firstProse = outline.sections.findIndex((s) => s.kind === "prose");
  if (firstProse >= 0) {
    // 模型自拟、模板没有的章节：并入第一个 prose 节。发明 ## 标题违反「模板即结构」，
    // 丢弃条目又会损失真实工作，两害相权取其轻。
    const orphans: WorkItem[] = [];
    for (const [key, items] of aiBuckets) if (!matched.has(key)) orphans.push(...items);
    perSection[firstProse] = [...perSection[firstProse], ...orphans];
  }

  let overviewUsed = false;
  const renderItems = (items: WorkItem[], lead: boolean): string => {
    const blocks: string[] = [];
    if (lead && !overviewUsed && summary.overview.trim()) {
      blocks.push(sanitizeParagraph(summary.overview));
      overviewUsed = true;
    }
    // 有 @项目 的直接用项目名作标题；同一项目在本节出现多次时光写项目名会得到几个
    // 一模一样的标题，这时才补上工作项名区分
    const projCount = new Map<string, number>();
    items.forEach((it) => {
      if (it.project) projCount.set(it.project, (projCount.get(it.project) ?? 0) + 1);
    });
    items.forEach((it, i) => {
      let label: string;
      if (!it.project) label = it.title;
      else if ((projCount.get(it.project) ?? 0) <= 1) label = `@${it.project}`;
      // 模型常把项目名写进 title，此时不再前缀，避免「@平台重构 · 平台重构 相关工作」
      else label = it.title.includes(it.project) ? it.title : `@${it.project} · ${it.title}`;
      blocks.push(`### ${cnNum(i + 1)}、${label}`);
      blocks.push(sanitizeParagraph(it.body));
      const dates = refDates(it.refs, entries);
      if (dates.length) blocks.push(`*依据：${dates.join("、")} 共 ${it.refs.length} 条记录*`);
    });
    if (blocks.length === 0) blocks.push("（本期无相关内容）");
    return blocks.join("\n\n");
  };

  const out: string[] = [`# ${outline.title}`];
  if (outline.preamble) out.push(applyVars(outline.preamble, sectionVars(entries, range)).trim());

  if (firstProse >= 0) {
    outline.sections.forEach((sec, i) => {
      out.push(`## ${sec.heading}`);
      if (sec.kind !== "prose") {
        out.push(applyVars(sec.body, sectionVars(entries, range)).trim());
        return;
      }
      const block = renderItems(perSection[i], i === firstProse);
      // 正文没有 {{summary}} 时，那些文字是写作要求而非正文，整节由模型结果替代
      out.push(
        /\{\{summary\}\}/.test(sec.body)
          ? applyVars(sec.body, sectionVars(entries, range, block)).trim()
          : block,
      );
    });
  } else {
    // 模板没有可写章节（存量用户的月/季/年模板）：此时且仅此时模型自拟的章节即最终章节
    summary.sections.forEach((s, i) => {
      out.push(`## ${s.heading}`);
      out.push(renderItems(s.items, i === 0));
    });
    outline.sections.forEach((sec) => {
      out.push(`## ${sec.heading}`);
      out.push(applyVars(sec.body, sectionVars(entries, range)).trim());
    });
  }

  // 截断、分段失败之类的如实注明，放在文末——首屏应该是报告，不是免责声明
  notes.forEach((n) => out.push(`> ${n}`));

  return out.filter((s) => s.trim() !== "").join("\n\n") + "\n";
}

/* ---------------- 时间范围计算（选择器 → [start, end]） ---------------- */

const fmt = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export function mondayOf(dateStr: string): Date {
  const d = new Date(dateStr + "T00:00");
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/** 周报：点选该周内任意一天 → 周一 ~ 周日；当周截至今天 */
export function weekRange(anyDay: string): { start: string; end: string } {
  const mon = mondayOf(anyDay);
  const sun = new Date(mon);
  sun.setDate(sun.getDate() + 6);
  const today = todayStr();
  const end = fmt(mon) <= today && fmt(sun) > today ? today : fmt(sun);
  return { start: fmt(mon), end };
}

/** 季度：Q1~Q4；当季截至今天 */
export function quarterRange(year: number, q: 1 | 2 | 3 | 4): { start: string; end: string } {
  const start = `${year}-${pad2(q * 3 - 2)}-01`;
  const lastDay = new Date(year, q * 3, 0).getDate();
  let end = `${year}-${pad2(q * 3)}-${pad2(lastDay)}`;
  const today = todayStr();
  if (start <= today && end > today) end = today;
  return { start, end };
}

/** 月度：当月 1 号 ~ 月末；当月截至今天 */
export function monthRange(year: number, month: number): { start: string; end: string } {
  const start = `${year}-${pad2(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  let end = `${year}-${pad2(month)}-${pad2(lastDay)}`;
  const today = todayStr();
  if (start <= today && end > today) end = today;
  return { start, end };
}

/** 年度：1/1 ~ 12/31；当年截至今天 */
export function yearRange(year: number): { start: string; end: string } {
  const start = `${year}-01-01`;
  let end = `${year}-12-31`;
  const today = todayStr();
  if (start <= today && end > today) end = today;
  return { start, end };
}

export function computeRange(
  type: ReportType,
  sel: { day: string; weekDay: string; mYear: number; month: number; qYear: number; q: 1 | 2 | 3 | 4; year: number },
): { start: string; end: string } {
  switch (type) {
    case "daily":
      return { start: sel.day, end: sel.day };
    case "weekly":
      return weekRange(sel.weekDay);
    case "monthly":
      return monthRange(sel.mYear, sel.month);
    case "quarterly":
      return quarterRange(sel.qYear, sel.q);
    case "yearly":
      return yearRange(sel.year);
  }
}

/** ISO 8601 周数（周一为一周起点，第一周含当年第一个周四）；年初年末可能归属相邻年份 */
export function isoWeek(dateStr: string): { year: number; week: number } {
  const d = new Date(dateStr + "T00:00");
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 3); // 本周四
  const isoYear = d.getFullYear();
  const jan4 = new Date(isoYear, 0, 4);
  const week =
    1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return { year: isoYear, week };
}

/** 导出文件名（不含扩展名，英文命名）：周报体现第几周（W24），季度体现 Q 序号，年度只写年份 */
export function exportBaseName(type: ReportType, range: { start: string; end: string }): string {
  switch (type) {
    case "daily":
      return `Daily_${range.start}`;
    case "weekly": {
      const { year, week } = isoWeek(range.start);
      return `Weekly_${year}-W${pad2(week)}`;
    }
    case "monthly":
      return `Monthly_${range.start.slice(0, 7)}`;
    case "quarterly": {
      const q = Math.floor((+range.start.slice(5, 7) - 1) / 3) + 1;
      return `Quarterly_${range.start.slice(0, 4)}-Q${q}`;
    }
    case "yearly":
      return `Yearly_${range.start.slice(0, 4)}`;
  }
}

/* ---------------- 导出格式 ---------------- */

/** Markdown → 去格式纯文本（复制纯文本用） */
export function mdToPlain(md: string): string {
  return md
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^- /gm, "")
    .replace(/`([^`]+)`/g, "$1");
}

/** 独立 HTML（内联样式，可直接发邮件/转 PDF） */
export function wrapHtml(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
  body { font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; max-width: 760px; margin: 40px auto; padding: 0 20px; line-height: 1.7; color: #1c1f26; }
  h1 { font-size: 22px; } h2 { font-size: 17px; border-bottom: 1px solid #e4e7ee; padding-bottom: 6px; margin-top: 28px; }
  h3 { font-size: 15px; color: #1c1f26; font-weight: 600; margin-top: 18px; }
  li { margin: 4px 0; }
  blockquote { margin: 12px 0; padding: 6px 12px; border-left: 3px solid #e4e7ee; color: #6b7280; }
  em { color: #6b7280; font-size: 13px; }
  @media print { body { margin: 0 auto; } }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}
