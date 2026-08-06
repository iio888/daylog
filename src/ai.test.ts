import { describe, expect, it } from "vitest";
import type { Entry } from "./types";
import { buildBatches, cleanRefs, numberRecords, toWorkSummary } from "./ai";

// 这些是「模型输出一律不采信、逐字段夹紧」那条防线的实现本体，
// 所以喂的都是对抗性输入：越界、重复、类型不对、超上限。

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

describe("cleanRefs", () => {
  it("丢掉越界编号、去重并升序", () => {
    expect(cleanRefs([3, 1, 1, 99, 0, -2], 5)).toEqual([1, 3]);
  });

  it("非数组或非数字一律丢掉，不抛错", () => {
    expect(cleanRefs(null, 5)).toEqual([]);
    expect(cleanRefs("1,2", 5)).toEqual([]);
    expect(cleanRefs([{}, "abc", NaN, Infinity], 5)).toEqual([]);
  });

  it("字符串数字与小数按整数收下", () => {
    expect(cleanRefs(["2", 3.7], 5)).toEqual([2, 3]);
  });

  it("最多留 8 条依据", () => {
    expect(cleanRefs([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 20)).toHaveLength(8);
  });
});

describe("numberRecords", () => {
  it("编号从 1 起全局连续", () => {
    const { recs, notes } = numberRecords([entry(), entry(), entry()]);
    expect(recs.map((r) => r.n)).toEqual([1, 2, 3]);
    expect(recs[0].text.startsWith("[1] 2026-06-10 09:00")).toBe(true);
    expect(notes).toEqual([]);
  });

  it("超长记录只截断它自己，并如实注明", () => {
    const { recs, notes } = numberRecords([entry({ content: "长".repeat(5000) }), entry()]);
    expect(recs[0].text).toContain("已截断");
    expect(recs[1].n).toBe(2); // 截断不影响后续编号
    expect(notes[0]).toContain("1 条超长记录");
  });
});

describe("buildBatches", () => {
  it("总量不超预算时不分批", () => {
    const { recs } = numberRecords([entry(), entry()]);
    const { batches, notes } = buildBatches(recs);
    expect(batches).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  it("长区间会分成多批，且每条记录只出现一次", () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      entry({ content: "内容".repeat(30), entry_date: `2026-06-${String((i % 28) + 1).padStart(2, "0")}` }),
    );
    const { recs } = numberRecords(many);
    const { batches } = buildBatches(recs);
    expect(batches.length).toBeGreaterThan(1);
    const flat = batches.flat().map((r) => r.n);
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat).toEqual([...flat].sort((a, b) => a - b));
  });

  it("记录量极端偏大时截掉尾部并注明，而不是闷头发几十次请求", () => {
    const huge = Array.from({ length: 400 }, () => entry({ content: "长".repeat(3000) }));
    const { recs } = numberRecords(huge);
    const { batches, notes } = buildBatches(recs);
    expect(batches.length).toBeLessThanOrEqual(12);
    expect(notes[0]).toContain("本次总结基于其中前");
  });
});

describe("toWorkSummary", () => {
  const entries = [
    entry({ project: "支付" }),
    entry({ project: "支付" }),
    entry({ project: "风控" }),
  ];

  it("@项目由 refs 回查得出，不采信模型给的字符串", () => {
    const s = toWorkSummary(
      {
        overview: "本周主要做了联调。",
        sections: [
          { heading: "本周工作", items: [{ title: "联调", body: "完成了联调工作。", refs: [1, 2], project: "瞎写的" }] },
        ],
      },
      entries,
    );
    expect(s.sections[0].items[0].project).toBe("支付");
  });

  it("越界 refs 被丢掉，但正文保留——模型数错编号不该连累本来正确的内容", () => {
    const s = toWorkSummary(
      { sections: [{ heading: "本周工作", items: [{ title: "联调", body: "完成了联调。", refs: [99] }] }] },
      entries,
    );
    expect(s.sections[0].items[0].refs).toEqual([]);
    expect(s.sections[0].items[0].body).toContain("完成了联调");
  });

  it("同节内重名工作项合并，refs 取并集", () => {
    const s = toWorkSummary(
      {
        sections: [
          {
            heading: "本周工作",
            items: [
              { title: "联调", body: "第一段。", refs: [1] },
              { title: " 联 调 ", body: "第二段。", refs: [3] },
            ],
          },
        ],
      },
      entries,
    );
    expect(s.sections[0].items).toHaveLength(1);
    expect(s.sections[0].items[0].refs).toEqual([1, 3]);
    expect(s.sections[0].items[0].body).toContain("第一段");
  });

  it("全报告工作项不超过 15 个", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      title: `工作项${i}`,
      body: `这是第 ${i} 项的正文。`,
      refs: [1],
    }));
    const s = toWorkSummary({ sections: [{ heading: "本周工作", items }] }, entries);
    expect(s.sections.reduce((n, x) => n + x.items.length, 0)).toBe(15);
  });

  it("一个工作项都提不出来时抛错，而不是产出一份空报告", () => {
    expect(() => toWorkSummary({ sections: [] }, entries)).toThrow();
    expect(() => toWorkSummary({ sections: [{ heading: "本周工作", items: [] }] }, entries)).toThrow();
  });

  it("body 里的列表符号与 SMART 要素标签被确定性剥掉", () => {
    const s = toWorkSummary(
      { sections: [{ heading: "本周工作", items: [{ title: "联调", body: "- S: 完成了联调。", refs: [1] }] }] },
      entries,
    );
    expect(s.sections[0].items[0].body).not.toMatch(/^-|S:/);
  });
});
