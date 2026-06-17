/** 模板系统：UTF-8 Markdown + {{占位符}}，可选 YAML frontmatter（name / type） */

export type ReportType = "daily" | "weekly" | "quarterly" | "yearly";

export const REPORT_TYPE_LABEL: Record<ReportType, string> = {
  daily: "日报",
  weekly: "周报",
  quarterly: "季度总结",
  yearly: "年度总结",
};

export interface Template {
  filename: string;
  /** frontmatter name，缺省用文件名 */
  name: string;
  /** 适用报告类型；any = 全部 */
  type: ReportType | "any";
  /** 去掉 frontmatter 后的正文 */
  body: string;
  /** 解析失败原因（下拉中标灰） */
  error?: string;
}

const TYPES = new Set(["daily", "weekly", "quarterly", "yearly", "any"]);

export function parseTemplate(filename: string, raw: string): Template {
  const base = filename.replace(/\.md$/, "");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { filename, name: base, type: "any", body: raw };

  let name = base;
  let type: Template["type"] = "any";
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+)\s*:\s*(.+?)\s*(#.*)?$/);
    if (!kv) continue;
    if (kv[1] === "name") name = kv[2];
    if (kv[1] === "type") {
      if (!TYPES.has(kv[2])) {
        return { filename, name: base, type: "any", body: "", error: `未知 type：${kv[2]}` };
      }
      type = kv[2] as Template["type"];
    }
  }
  return { filename, name, type, body: raw.slice(m[0].length) };
}

/** 内置模板：首次启动播种到模板目录，用户可改可删（删后不自动恢复） */
export const BUILTIN_TEMPLATES: { filename: string; content: string }[] = [
  {
    filename: "内置-日报.md",
    content: `---
name: 日报（内置）
type: daily
---
# {{date}} 日报

## 今日工作
{{summary}}

## 数据
{{stats}}
`,
  },
  {
    filename: "内置-周报.md",
    content: `---
name: 周报（内置）
type: weekly
---
# {{range}} 周报

## 本周工作
{{summary}}

## 按项目
{{entries_by_project}}

## 数据
{{stats}}
`,
  },
  {
    filename: "内置-季度总结.md",
    content: `---
name: 季度总结（内置）
type: quarterly
---
# {{range}} 季度总结

## 重点事项（按标签）
{{entries_by_tag}}

## 全部记录
{{entries}}

## 数据
{{stats}}
`,
  },
  {
    filename: "内置-年度总结.md",
    content: `---
name: 年度总结（内置）
type: yearly
---
# {{range}} 年度总结

## 按项目回顾
{{entries_by_project}}

## 重点事项（按标签）
{{entries_by_tag}}

## 数据
{{stats}}
`,
  },
];
