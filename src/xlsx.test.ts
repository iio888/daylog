import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  colIndex,
  colName,
  directFillXlsx,
  fillSeqColumn,
  fillXlsxTemplate,
  normalizeRows,
  parseXlsxTemplate,
  xlsxToMarkdown,
} from "./xlsx";

// 行位移和合并单元格重映射错一格，Excel 就直接判定「文件已损坏」并弹修复对话框，
// 而这在纯 TS 里看不出来。所以这里用合成的 xlsx 把 XML 结构逐项断言。

const S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/** 造一份最小 xlsx：表头 1 行 → 空数据区 → 说明区（整行合并） */
async function makeXlsx(opts: {
  header: string[];
  headerRow?: number;
  /** 说明区起始行；省略则没有说明区 */
  trailingStart?: number;
  trailingLines?: string[];
}): Promise<Uint8Array> {
  const { header, headerRow = 1, trailingStart, trailingLines = [] } = opts;
  const shared = [...header, ...trailingLines];
  const si = shared.map((t) => `<si><t>${t}</t></si>`).join("");
  const cell = (col: number, row: number, idx: number) =>
    `<c r="${colName(col)}${row}" t="s"><v>${idx}</v></c>`;

  const rows = [
    `<row r="${headerRow}" spans="1:${header.length}">${header
      .map((_, i) => cell(i, headerRow, i))
      .join("")}</row>`,
    ...trailingLines.map(
      (_, i) =>
        `<row r="${(trailingStart ?? 0) + i}">${cell(0, (trailingStart ?? 0) + i, header.length + i)}</row>`,
    ),
  ].join("");

  const merges = trailingLines.length
    ? `<mergeCells count="${trailingLines.length}">${trailingLines
        .map(
          (_, i) =>
            `<mergeCell ref="A${(trailingStart ?? 0) + i}:${colName(header.length - 1)}${(trailingStart ?? 0) + i}"/>`,
        )
        .join("")}</mergeCells>`
    : "";

  const zip = new JSZip();
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0"?><workbook xmlns="${S}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`,
  );
  zip.file("xl/sharedStrings.xml", `<?xml version="1.0"?><sst xmlns="${S}">${si}</sst>`);
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0"?><worksheet xmlns="${S}"><dimension ref="A1:A1"/><sheetData>${rows}</sheetData>${merges}</worksheet>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

/** 读回生成物的 sheet XML，供断言。回填只改说明区的行号引用、不动其内容，
 *  所以那些格子仍是 t="s" 共享串——助手得跟着解一层，否则读出来是空的。 */
async function readSheet(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  const sstXml = await zip.file("xl/sharedStrings.xml")!.async("string");
  const sst = Array.from(
    new DOMParser().parseFromString(sstXml, "application/xml").getElementsByTagNameNS(S, "si"),
  ).map((si) =>
    Array.from(si.getElementsByTagNameNS(S, "t"))
      .map((t) => t.textContent ?? "")
      .join(""),
  );
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const rows = Array.from(doc.getElementsByTagNameNS(S, "row")).map((r) => ({
    r: Number(r.getAttribute("r")),
    cells: Array.from(r.getElementsByTagNameNS(S, "c")).map((c) => {
      const inline = Array.from(c.getElementsByTagNameNS(S, "t"))
        .map((t) => t.textContent ?? "")
        .join("");
      const v = c.getElementsByTagNameNS(S, "v")[0]?.textContent ?? "";
      return {
        ref: c.getAttribute("r") ?? "",
        text: c.getAttribute("t") === "s" ? (sst[Number(v)] ?? "") : inline,
      };
    }),
  }));
  const merges = Array.from(doc.getElementsByTagNameNS(S, "mergeCell")).map(
    (m) => m.getAttribute("ref") ?? "",
  );
  const dim = doc.getElementsByTagNameNS(S, "dimension")[0]?.getAttribute("ref") ?? "";
  return { xml, rows, merges, dim };
}

describe("A1 引用", () => {
  it("列字母与序号互转（26 进制无 0）", () => {
    expect(colIndex("A1")).toBe(0);
    expect(colIndex("G10")).toBe(6);
    expect(colIndex("AA3")).toBe(26);
    expect(colIndex("AB3")).toBe(27);
    expect(colName(0)).toBe("A");
    expect(colName(6)).toBe("G");
    expect(colName(26)).toBe("AA");
    for (const i of [0, 1, 25, 26, 27, 51, 52, 701, 702]) {
      expect(colIndex(`${colName(i)}1`)).toBe(i);
    }
  });
});

describe("normalizeRows", () => {
  const w = 3;
  it("补齐/截断到列数，丢掉整行空的，超出上限截断", () => {
    expect(normalizeRows([["a"], ["a", "b", "c", "d"]], w, 10)).toEqual([
      ["a", "", ""],
      ["a", "b", "c"],
    ]);
    expect(normalizeRows([["", "", ""], ["x", "", ""]], w, 10)).toEqual([["x", "", ""]]);
    expect(normalizeRows([["1"], ["2"], ["3"]], w, 2)).toHaveLength(2);
  });
  it("非数组、非法元素一律安全降级", () => {
    expect(normalizeRows("nope", w, 10)).toEqual([]);
    expect(normalizeRows([null, ["ok"]], w, 10)).toEqual([["ok", "", ""]]);
  });
  it("单元格内的换行折叠成空格——xlsx 单元格换行要配 wrapText 样式，模板未必有", () => {
    expect(normalizeRows([["第一行\n第二行"]], 1, 10)).toEqual([["第一行 第二行"]]);
  });
});

describe("fillSeqColumn", () => {
  it("认出序号列并统一编号，模型自己写的会被覆盖", () => {
    const cols = ["序号", "事项名称"];
    expect(fillSeqColumn(cols, [["99", "甲"], ["", "乙"]])).toEqual([
      ["1", "甲"],
      ["2", "乙"],
    ]);
  });
  it("没有序号列则原样返回", () => {
    expect(fillSeqColumn(["名称", "描述"], [["甲", "乙"]])).toEqual([["甲", "乙"]]);
  });
});

describe("directFillXlsx（离线兜底）", () => {
  it("按列名语义把日期与内容各就各位", () => {
    const rows = directFillXlsx(
      { columns: ["序号", "日期", "工作事项描述"], instructions: "" },
      [
        { entry_date: "2026-06-08", content: "做了甲" },
        { entry_date: "2026-06-09", content: "做了乙" },
      ],
    );
    expect(rows).toEqual([
      ["1", "2026-06-08", "做了甲"],
      ["2", "2026-06-09", "做了乙"],
    ]);
  });

  // 真实模板踩过的坑：「事项维度」里含「事项」，用单一正则取首个匹配会把正文
  // 填进枚举列，而「工作事项描述」空着。
  it("描述列优先于名称列，枚举/编码类的列一律不碰", () => {
    const cols = ["序号", "事项维度", "事项名称", "工作事项描述", "项目编码", "项目名称", "备注"];
    const [row] = directFillXlsx({ columns: cols, instructions: "" }, [
      { entry_date: "2026-06-08", content: "梳理鉴权现状，列出 12 个待改造接口" },
    ]);
    expect(row[1]).toBe(""); // 事项维度：枚举，不填
    expect(row[2]).toBe("梳理鉴权现状，列出 12 个待改造接口".slice(0, 20)); // 事项名称
    expect(row[3]).toContain("梳理鉴权现状"); // 工作事项描述：正文在这儿
    expect(row[4]).toBe(""); // 项目编码：记录里没有
    // 模板没有日期列，日期必须并进正文，否则这条记录哪天做的就丢了
    expect(row[3]).toContain("2026-06-08");
  });

  it("一列都认不出来时退到首个非枚举列，不整表留白", () => {
    const [row] = directFillXlsx({ columns: ["序号", "甲", "乙"], instructions: "" }, [
      { entry_date: "2026-06-08", content: "内容" },
    ]);
    expect(row).toEqual(["1", "2026-06-08 内容", ""]);
  });
});

describe("xlsxToMarkdown", () => {
  it("竖线转义，否则表格会被 marked 拆错列", () => {
    const md = xlsxToMarkdown("标题", { columns: ["A", "B"], instructions: "" }, [["含|竖线", "x"]]);
    expect(md).toContain("含\\|竖线");
    expect(md.split("\n")[2]).toBe("| A | B |");
  });
});

describe("parseXlsxTemplate", () => {
  it("表头取首个有两列以上内容的行，其后首个非空行起算作填写说明", async () => {
    const bytes = await makeXlsx({
      header: ["序号", "事项名称", "描述"],
      trailingStart: 5,
      trailingLines: ["填写说明：", "描述要有数据支撑"],
    });
    const tpl = await parseXlsxTemplate(bytes);
    expect(tpl.headerRow).toBe(1);
    expect(tpl.outline.columns).toEqual(["序号", "事项名称", "描述"]);
    expect(tpl.trailingStart).toBe(5);
    expect(tpl.outline.instructions).toBe("填写说明：\n描述要有数据支撑");
  });

  it("没有说明区时 trailingStart 为 0，数据区不受限", async () => {
    const tpl = await parseXlsxTemplate(await makeXlsx({ header: ["甲", "乙"] }));
    expect(tpl.trailingStart).toBe(0);
    expect(tpl.outline.instructions).toBe("");
  });

  it("不是 Excel 文件时给中文错误而不是崩在 XML 上", async () => {
    await expect(parseXlsxTemplate(new Uint8Array([1, 2, 3]))).rejects.toThrow(/Excel/);
  });
});

describe("fillXlsxTemplate", () => {
  const header = ["序号", "事项名称", "描述"];

  it("数据从表头下一行写起，写成 inlineStr", async () => {
    const tpl = await parseXlsxTemplate(await makeXlsx({ header }));
    const out = await readSheet(await fillXlsxTemplate(tpl, [["1", "甲", "描述甲"]]));
    const data = out.rows.find((r) => r.r === 2)!;
    expect(data.cells.map((c) => c.ref)).toEqual(["A2", "B2", "C2"]);
    expect(data.cells.map((c) => c.text)).toEqual(["1", "甲", "描述甲"]);
    expect(out.xml).toContain('t="inlineStr"');
  });

  it("行数没超过预留空行时，说明区与合并区域都不动", async () => {
    const tpl = await parseXlsxTemplate(
      await makeXlsx({ header, trailingStart: 5, trailingLines: ["说明一", "说明二"] }),
    );
    const out = await readSheet(await fillXlsxTemplate(tpl, [["1", "甲", "d"], ["2", "乙", "d"]]));
    expect(out.rows.map((r) => r.r)).toEqual([1, 2, 3, 5, 6]);
    expect(out.merges).toEqual(["A5:C5", "A6:C6"]);
  });

  it("行数超出预留空行时，说明区整体下移且合并区域同步重映射", async () => {
    const tpl = await parseXlsxTemplate(
      await makeXlsx({ header, trailingStart: 5, trailingLines: ["说明一", "说明二"] }),
    );
    // 预留 2~4 共 3 行，这里写 6 行 → 下移 3 行
    const rows = Array.from({ length: 6 }, (_, i) => [String(i + 1), `事项${i}`, "d"]);
    const out = await readSheet(await fillXlsxTemplate(tpl, rows));

    expect(out.rows.map((r) => r.r)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(out.merges).toEqual(["A8:C8", "A9:C9"]);
    // 说明区的单元格引用必须跟着行号走，否则 Excel 报文件损坏
    const moved = out.rows.find((r) => r.r === 8)!;
    expect(moved.cells[0].ref).toBe("A8");
    expect(moved.cells[0].text).toBe("说明一");
    // 行必须按行号升序排列
    expect(out.rows.map((r) => r.r)).toEqual([...out.rows.map((r) => r.r)].sort((a, b) => a - b));
    expect(out.dim).toBe("A1:C9");
  });

  it("空单元格不写 <c>，且超出列数的多余值被丢弃", async () => {
    const tpl = await parseXlsxTemplate(await makeXlsx({ header }));
    const out = await readSheet(await fillXlsxTemplate(tpl, [["", "甲", "", "多余"]]));
    const data = out.rows.find((r) => r.r === 2)!;
    expect(data.cells.map((c) => c.ref)).toEqual(["B2"]);
  });

  it("零行时说明区留在原处", async () => {
    const tpl = await parseXlsxTemplate(
      await makeXlsx({ header, trailingStart: 5, trailingLines: ["说明一"] }),
    );
    const out = await readSheet(await fillXlsxTemplate(tpl, []));
    expect(out.rows.map((r) => r.r)).toEqual([1, 5]);
    expect(out.merges).toEqual(["A5:C5"]);
  });
});
