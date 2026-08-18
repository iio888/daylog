/**
 * Excel（.xlsx）模板引擎：解析表头与填写说明，把工作事项按列语义回填，重新打包为 .xlsx。
 *
 * 与 docx.ts 同源思路——JSZip 解包、DOM 改 XML、原样打回，保留样式、列宽与合并单元格。
 * 模板不含占位符：靠表头列名对位，表头下方的说明文字作为写作要求喂给模型。
 */

import JSZip from "jszip";

const S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** 一行最多写这么多列，防止畸形模板把内存撑爆 */
const MAX_COLS = 64;

/* ---------------- 类型 ---------------- */

export interface XlsxOutline {
  /** 表头列名，按列序排列；模板留空的列为 "" */
  columns: string[];
  /** 表头下方模板自带的填写说明，作为写作要求交给模型（不参与输出） */
  instructions: string;
}

export interface XlsxTemplate {
  zip: JSZip;
  sheetPath: string;
  doc: XMLDocument;
  outline: XlsxOutline;
  /** 表头所在行号（1 起） */
  headerRow: number;
  /** 表头之后首个非空行（填写说明区起点）；没有则为 0，数据区不受限 */
  trailingStart: number;
}

/* ---------------- A1 引用 ---------------- */

/** "AB12" → 27（0 起）。列字母是 26 进制但没有 0，所以逐位 *26 再加。 */
export function colIndex(ref: string): number {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 0 → "A"，26 → "AA" */
export function colName(i: number): string {
  let n = i + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const rowOf = (ref: string): number => Number(/(\d+)$/.exec(ref)?.[1] ?? 0);

/* ---------------- 解析 ---------------- */

const kids = (el: Element | Document, name: string): Element[] =>
  Array.from(el.getElementsByTagNameNS(S, name));

/** 富文本的 <si> 下可能有多段 <t>，要拼起来 */
function readSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return kids(doc, "si").map((si) =>
    kids(si, "t")
      .map((t) => t.textContent ?? "")
      .join(""),
  );
}

function cellText(c: Element, shared: string[]): string {
  const t = c.getAttribute("t");
  if (t === "inlineStr") {
    return kids(c, "t")
      .map((x) => x.textContent ?? "")
      .join("");
  }
  const v = kids(c, "v")[0]?.textContent ?? "";
  if (t === "s") return shared[Number(v)] ?? "";
  return v;
}

/** workbook 里第一个 sheet 的实际路径（经 rels 解析，别假定是 sheet1.xml） */
async function firstSheetPath(zip: JSZip): Promise<string> {
  const wb = await zip.file("xl/workbook.xml")?.async("string");
  if (!wb) throw new Error("不是有效的 Excel 文件（缺少 workbook.xml）");
  const sheet = kids(new DOMParser().parseFromString(wb, "application/xml"), "sheet")[0];
  const rid = sheet?.getAttributeNS(DOC_REL, "id");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (rid && relsXml) {
    const rels = new DOMParser().parseFromString(relsXml, "application/xml");
    for (const r of Array.from(rels.getElementsByTagNameNS(REL, "Relationship"))) {
      if (r.getAttribute("Id") === rid) {
        const target = r.getAttribute("Target") ?? "";
        return target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
      }
    }
  }
  return "xl/worksheets/sheet1.xml";
}

export async function parseXlsxTemplate(bytes: Uint8Array): Promise<XlsxTemplate> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error("Excel 文件解析失败");
  }
  const sheetPath = await firstSheetPath(zip);
  const sheetXml = await zip.file(sheetPath)?.async("string");
  if (!sheetXml) throw new Error("不是有效的 Excel 文件（缺少工作表）");

  const doc = new DOMParser().parseFromString(sheetXml, "application/xml");
  if (kids(doc, "sheetData").length === 0) throw new Error("Excel 文件解析失败");
  const shared = readSharedStrings(
    (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? null,
  );

  // 行号 → 该行各列文字
  const rowTexts = new Map<number, Map<number, string>>();
  for (const row of kids(doc, "row")) {
    const r = Number(row.getAttribute("r") ?? 0);
    if (!r) continue;
    const m = new Map<number, string>();
    for (const c of kids(row, "c")) {
      const txt = cellText(c, shared).trim();
      if (txt !== "") m.set(colIndex(c.getAttribute("r") ?? "A1"), txt);
    }
    if (m.size) rowTexts.set(r, m);
  }

  const filled = [...rowTexts.keys()].sort((a, b) => a - b);
  // 表头 = 首个有两列以上内容的行。只有一格的行通常是标题或说明，不是表头。
  const headerRow = filled.find((r) => (rowTexts.get(r)?.size ?? 0) >= 2) ?? filled[0] ?? 1;
  const head = rowTexts.get(headerRow) ?? new Map();
  const width = Math.min(MAX_COLS, Math.max(...[...head.keys()], 0) + 1);
  const columns = Array.from({ length: width }, (_, i) => head.get(i) ?? "");

  // 表头之后的首个非空行起，都是模板自带的填写说明；夹在中间的空行就是数据区
  const trailingStart = filled.find((r) => r > headerRow) ?? 0;
  const instructions = filled
    .filter((r) => trailingStart > 0 && r >= trailingStart)
    .map((r) =>
      [...(rowTexts.get(r) ?? new Map()).entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v)
        .join(" ")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");

  return { zip, sheetPath, doc, outline: { columns, instructions }, headerRow, trailingStart };
}

/* ---------------- 回填 ---------------- */

function makeCell(doc: XMLDocument, ref: string, text: string): Element {
  const c = doc.createElementNS(S, "c");
  c.setAttribute("r", ref);
  // 一律写 inlineStr：省去维护 sharedStrings 索引，且不会与模板既有共享串冲突
  c.setAttribute("t", "inlineStr");
  const is = doc.createElementNS(S, "is");
  const t = doc.createElementNS(S, "t");
  t.setAttributeNS(XML_NS, "xml:space", "preserve");
  t.appendChild(doc.createTextNode(text));
  is.appendChild(t);
  c.appendChild(is);
  return c;
}

/**
 * 把 rows 写进数据区（表头下一行起）。行数超过模板预留的空行时，把填写说明整体下移，
 * 并同步重映射合并单元格区域——不重映射 Excel 会判定文件损坏。
 */
export async function fillXlsxTemplate(tpl: XlsxTemplate, rows: string[][]): Promise<Uint8Array> {
  const { doc, headerRow, trailingStart } = tpl;
  const sheetData = kids(doc, "sheetData")[0];
  const width = tpl.outline.columns.length;

  // 表头之后的行先摘出来，回填完再按新行号挂回去（XML 里 row 必须按行号升序）
  const trailing = kids(sheetData, "row").filter((r) => Number(r.getAttribute("r") ?? 0) > headerRow);
  trailing.forEach((r) => r.remove());

  rows.forEach((cells, i) => {
    const r = headerRow + 1 + i;
    const row = doc.createElementNS(S, "row");
    row.setAttribute("r", String(r));
    row.setAttribute("spans", `1:${width}`);
    cells.slice(0, width).forEach((text, ci) => {
      if (text !== "") row.appendChild(makeCell(doc, `${colName(ci)}${r}`, text));
    });
    sheetData.appendChild(row);
  });

  // 预留的空行够用就不动说明区；不够才下移，且只增不减
  const shift =
    trailingStart > 0 ? Math.max(0, headerRow + 1 + rows.length - trailingStart) : 0;
  for (const row of trailing) {
    const r = Number(row.getAttribute("r") ?? 0) + shift;
    row.setAttribute("r", String(r));
    for (const c of kids(row, "c")) {
      c.setAttribute("r", `${colName(colIndex(c.getAttribute("r") ?? "A1"))}${r}`);
    }
    sheetData.appendChild(row);
  }

  if (shift > 0) {
    for (const mc of kids(doc, "mergeCell")) {
      const ref = mc.getAttribute("ref") ?? "";
      const [a, b] = ref.split(":");
      if (!b || rowOf(a) < trailingStart) continue;
      mc.setAttribute(
        "ref",
        `${colName(colIndex(a))}${rowOf(a) + shift}:${colName(colIndex(b))}${rowOf(b) + shift}`,
      );
    }
  }

  const lastRow = Math.max(
    headerRow + rows.length,
    ...kids(sheetData, "row").map((r) => Number(r.getAttribute("r") ?? 0)),
  );
  kids(doc, "dimension")[0]?.setAttribute("ref", `A1:${colName(Math.max(0, width - 1))}${lastRow}`);

  const xml = new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^>]*\?>\s*/, "");
  tpl.zip.file(tpl.sheetPath, XML_DECL + xml);
  return tpl.zip.generateAsync({ type: "uint8array", mimeType: XLSX_MIME });
}

/* ---------------- 序号列 ---------------- */

const SEQ_COL_RE = /^(序号|序列号?|编号|行号|no\.?|#)$/i;

/** 模型不擅长连续编号，序号类的列一律由这里统一填 1,2,3… */
export function fillSeqColumn(columns: string[], rows: string[][]): string[][] {
  const i = columns.findIndex((c) => SEQ_COL_RE.test(c.trim()));
  if (i < 0) return rows;
  return rows.map((cells, n) => {
    const out = [...cells];
    out[i] = String(n + 1);
    return out;
  });
}

/* ---------------- 离线兜底与预览 ---------------- */

const DATE_COL_RE = /时间|日期/;
/** 描述类优先于名称类：「事项维度」也含「事项」，按单一正则取首个匹配会填错列 */
const DESC_COL_RE = /描述|详情|说明|内容/;
const NAME_COL_RE = /名称|标题|事项|工作/;
/** 枚举/编码类的列没法从记录推出来，别往里塞正文 */
const SKIP_COL_RE = /序号|序列号?|编号|行号|维度|类型|类别|编码|代码|code|no\.?|#/i;

/**
 * 「直接整理」：不联网时按列名粗填，一条记录一行。结果较糙，但保证断网也能出表。
 * 与 docx.ts 的 directFill 同一套列名启发式。
 */
export function directFillXlsx(
  outline: XlsxOutline,
  entries: { entry_date: string; content: string }[],
): string[][] {
  const cols = outline.columns;
  const pick = (re: RegExp, exclude: number[] = []) =>
    cols.findIndex((c, i) => !exclude.includes(i) && !SKIP_COL_RE.test(c) && re.test(c));

  const dateCol = cols.findIndex((c) => DATE_COL_RE.test(c));
  let descCol = pick(DESC_COL_RE);
  let nameCol = pick(NAME_COL_RE, [descCol]);
  if (descCol < 0) [descCol, nameCol] = [nameCol, -1];
  // 一列都没认出来时，退到第一个非枚举/编号列，总比整表空着强
  if (descCol < 0) descCol = cols.findIndex((c) => !SKIP_COL_RE.test(c));

  const rows = entries.map((e) => {
    const row = cols.map(() => "");
    if (dateCol >= 0) row[dateCol] = e.entry_date;
    if (nameCol >= 0) row[nameCol] = e.content.slice(0, 20);
    // 没有日期列就把日期并进正文，否则这条记录哪天做的就丢了
    if (descCol >= 0) row[descCol] = dateCol >= 0 ? e.content : `${e.entry_date} ${e.content}`;
    return row;
  });
  return fillSeqColumn(cols, rows);
}

/** 屏幕预览：实际产物是 .xlsx 字节，这里出一张等价的 Markdown 表 */
export function xlsxToMarkdown(title: string, outline: XlsxOutline, rows: string[][]): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const head = outline.columns.map((c) => esc(c) || " ");
  const out = [`# ${title}`, "", `| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const r of rows) out.push(`| ${outline.columns.map((_, i) => esc(r[i] ?? "")).join(" | ")} |`);
  if (rows.length === 0) out.push(`| ${head.map(() => " ").join(" | ")} |`);
  return `${out.join("\n")}\n`;
}

/** 把模型返回的行规整成「每行长度等于列数」的字符串矩阵 */
export function normalizeRows(raw: unknown, width: number, maxRows: number): string[][] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(Array.isArray)
    .map((r) =>
      Array.from({ length: width }, (_, i) =>
        String((r as unknown[])[i] ?? "")
          .replace(/\s+/g, " ")
          .trim(),
      ),
    )
    .filter((r) => r.some((c) => c !== ""))
    .slice(0, maxRows);
}
