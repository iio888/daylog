/** 报告生成引擎（「直接整理」模式）：把时间范围内的记录按占位符填进模板，纯前端、离线。 */

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

/** 占位符全集（v1.0 定稿）。未知占位符原样保留，不报错。
 *  summaryOverride：AI 总结模式下由模型生成的 {{summary}} 内容；缺省时等同 {{entries}}。 */
export function fillTemplate(
  body: string,
  entries: Entry[],
  range: { start: string; end: string },
  summaryOverride?: string,
): string {
  const vars: Record<string, () => string> = {
    date: () => todayStr(),
    range: () => (range.start === range.end ? range.start : `${range.start} ~ ${range.end}`),
    entries: () => formatEntries(entries),
    entries_by_tag: () => formatGrouped(entries, (e) => e.tags, "#"),
    entries_by_project: () => formatGrouped(entries, (e) => (e.project ? [e.project] : []), "@"),
    summary: () => summaryOverride ?? formatEntries(entries),
    stats: () => formatStats(entries),
  };
  return body.replace(/\{\{(\w+)\}\}/g, (raw, key: string) => (key in vars ? vars[key]() : raw));
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
  h3 { font-size: 15px; color: #555; margin-top: 18px; }
  li { margin: 4px 0; }
  @media print { body { margin: 0 auto; } }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}
