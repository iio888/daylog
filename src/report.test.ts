import { describe, expect, it } from "vitest";
import type { Entry } from "./types";
import {
  exportBaseName,
  fillTemplate,
  isoWeek,
  mdToPlain,
  monthRange,
  parseMdOutline,
  quarterRange,
  weekRange,
  yearRange,
} from "./report";

// 日期算法与模板填充错一次，就是每一份报告都错，而且很难靠肉眼发现。
// 下面一律用过去的日期：weekRange 等对「当期」会截到今天，用历史区间才是确定值。

const entry = (over: Partial<Entry> = {}): Entry => ({
  id: Math.random().toString(36).slice(2),
  content: "做了点事",
  tags: [],
  project: null,
  entry_date: "2026-06-10",
  created_at: "2026-06-10T09:00:00+08:00",
  updated_at: "2026-06-10T09:00:00+08:00",
  ...over,
});

describe("weekRange", () => {
  it("周内任意一天都换算成周一到周日", () => {
    expect(weekRange("2020-06-10")).toEqual({ start: "2020-06-08", end: "2020-06-14" });
    expect(weekRange("2020-06-08")).toEqual({ start: "2020-06-08", end: "2020-06-14" });
    expect(weekRange("2020-06-14")).toEqual({ start: "2020-06-08", end: "2020-06-14" });
  });

  it("跨月跨年的那一周不被月末年末截断", () => {
    expect(weekRange("2020-01-01")).toEqual({ start: "2019-12-30", end: "2020-01-05" });
  });
});

describe("monthRange / quarterRange / yearRange", () => {
  it("月份取到真实月末，含闰年二月", () => {
    expect(monthRange(2020, 2)).toEqual({ start: "2020-02-01", end: "2020-02-29" });
    expect(monthRange(2021, 2)).toEqual({ start: "2021-02-01", end: "2021-02-28" });
    expect(monthRange(2020, 12)).toEqual({ start: "2020-12-01", end: "2020-12-31" });
  });

  it("季度按 1-3/4-6/7-9/10-12 切", () => {
    expect(quarterRange(2020, 1)).toEqual({ start: "2020-01-01", end: "2020-03-31" });
    expect(quarterRange(2020, 4)).toEqual({ start: "2020-10-01", end: "2020-12-31" });
  });

  it("年度是整年", () => {
    expect(yearRange(2020)).toEqual({ start: "2020-01-01", end: "2020-12-31" });
  });
});

describe("isoWeek", () => {
  it("年初可能归属上一年的最后一周", () => {
    expect(isoWeek("2021-01-01")).toEqual({ year: 2020, week: 53 });
  });

  it("年末可能归属下一年的第一周", () => {
    expect(isoWeek("2019-12-30")).toEqual({ year: 2020, week: 1 });
  });

  it("普通日期取本周四所在的 ISO 周", () => {
    expect(isoWeek("2020-06-10")).toEqual({ year: 2020, week: 24 });
  });
});

describe("exportBaseName", () => {
  it("文件名体现周期序号", () => {
    expect(exportBaseName("daily", { start: "2020-06-10", end: "2020-06-10" })).toBe("Daily_2020-06-10");
    expect(exportBaseName("weekly", { start: "2020-06-08", end: "2020-06-14" })).toBe("Weekly_2020-W24");
    expect(exportBaseName("monthly", { start: "2020-06-01", end: "2020-06-30" })).toBe("Monthly_2020-06");
    expect(exportBaseName("quarterly", { start: "2020-04-01", end: "2020-06-30" })).toBe("Quarterly_2020-Q2");
    expect(exportBaseName("yearly", { start: "2020-01-01", end: "2020-12-31" })).toBe("Yearly_2020");
  });
});

describe("fillTemplate", () => {
  const range = { start: "2026-06-08", end: "2026-06-14" };

  it("填充 range 与 entries", () => {
    const out = fillTemplate("# {{range}}\n\n{{entries}}", [entry({ content: "联调完成" })], range);
    expect(out).toContain("2026-06-08 ~ 2026-06-14");
    expect(out).toContain("联调完成");
  });

  it("单日范围只写一个日期", () => {
    expect(fillTemplate("{{range}}", [], { start: "2026-06-12", end: "2026-06-12" })).toBe("2026-06-12");
  });

  it("未知占位符原样保留，不报错", () => {
    expect(fillTemplate("{{不认识的}}", [], range)).toBe("{{不认识的}}");
  });

  it("按标签分组", () => {
    const out = fillTemplate("{{entries_by_tag}}", [entry({ tags: ["会议"], content: "晨会 #会议" })], range);
    expect(out).toContain("#会议");
    expect(out).toContain("晨会");
  });
});

describe("parseMdOutline", () => {
  const range = { start: "2026-06-08", end: "2026-06-14" };

  it("按占位符区分 prose 与 data 章节", () => {
    const o = parseMdOutline(
      "# {{range}} 周报\n\n汇报人：某某\n\n## 本周工作\n围绕阻塞项展开\n\n## 数据\n{{stats}}\n",
      range,
      "周报",
    );
    expect(o.title).toBe("2026-06-08 ~ 2026-06-14 周报");
    expect(o.preamble).toContain("汇报人");
    expect(o.sections.map((s) => [s.heading, s.kind])).toEqual([
      ["本周工作", "prose"],
      ["数据", "data"],
    ]);
    // prose 章节的正文是给模型的写作要求，不直接输出
    expect(o.sections[0].instructions).toBe("围绕阻塞项展开");
  });

  it("模板没有标题时用兜底标题", () => {
    expect(parseMdOutline("## 只有章节\n正文\n", range, "周报").title).toBe("周报");
  });
});

describe("mdToPlain", () => {
  it("清掉表格分隔行并把单元格压成空格", () => {
    const out = mdToPlain("| 指标 | 数值 |\n|---|:--:|\n| 记录条数 | 42 |");
    expect(out).not.toContain("|");
    expect(out).toContain("指标  数值");
    expect(out).toContain("记录条数  42");
  });

  it("去掉引用块前缀", () => {
    expect(mdToPlain("> 注：本期有 1 批提取失败")).toBe("注：本期有 1 批提取失败");
  });

  it("不误伤正文里的分割线", () => {
    expect(mdToPlain("上文\n---\n下文")).toBe("上文\n---\n下文");
  });

  it("标题、加粗、斜体、列表、行内代码", () => {
    expect(mdToPlain("## 标题\n- 列表 **粗** *斜* `码`")).toBe("标题\n列表 粗 斜 码");
  });
});
