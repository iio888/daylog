/**
 * Word（.docx）模板引擎：解析「样式 + 固定结构」骨架，按节回填内容，重新打包为 .docx。
 *
 * 设计要点（见计划）：模板不含占位符，靠 heading 样式切分章节、表格首数据行克隆来回填。
 * 纯前端（JSZip + DOMParser），桌面端（WebView2）与浏览器预览模式共用同一套逻辑。
 */

import JSZip from "jszip";
import type { Entry } from "./types";
import { timeOf } from "./parse";
import { isoWeek } from "./report";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/* ---------------- 类型 ---------------- */

export interface DocxSectionOutline {
  heading: string;
  kind: "table" | "prose";
  /** 表格章节：表头列名 */
  columns?: string[];
  /** 正文章节：模板内嵌的写作说明（喂给 AI 作指引） */
  instructions?: string;
}

export interface DocxOutline {
  title: string;
  sections: DocxSectionOutline[];
}

/** AI / 直接整理产出的填充内容，按 heading 与模板对齐 */
export interface DocxFilledSection {
  heading: string;
  prose?: string;
  rows?: string[][];
}
export interface DocxFilled {
  title?: string;
  sections: DocxFilledSection[];
}

interface ParsedSection {
  heading: string;
  headingP: Element;
  /** 该节标题之后、下个标题之前的正文段落（不含表格内段落） */
  proseParas: Element[];
  tables: Element[];
}

export interface DocxTemplate {
  zip: JSZip;
  doc: XMLDocument;
  titleP: Element | null;
  sections: ParsedSection[];
  outline: DocxOutline;
}

/* ---------------- DOM 小工具 ---------------- */

function childElems(parent: Node, local: string): Element[] {
  const out: Element[] = [];
  const kids = parent.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i] as Element;
    if (n.nodeType === 1 && n.namespaceURI === W && n.localName === local) out.push(n);
  }
  return out;
}

function firstChildElem(parent: Node, local: string): Element | null {
  return childElems(parent, local)[0] ?? null;
}

/** 段落/单元格的纯文本（拼接其下所有 <w:t>） */
function elemText(el: Element): string {
  const ts = el.getElementsByTagNameNS(W, "t");
  let s = "";
  for (let i = 0; i < ts.length; i++) s += ts[i].textContent ?? "";
  return s;
}

/** 设置段落文本：保留首个 run 的 rPr，移除其余 run（pPr 不动） */
function setParaText(p: Element, text: string): void {
  const doc = p.ownerDocument;
  const runs = childElems(p, "r");
  const rPr = runs.length ? firstChildElem(runs[0], "rPr") : null;
  runs.forEach((r) => p.removeChild(r));
  const r = doc.createElementNS(W, "w:r");
  if (rPr) r.appendChild(rPr.cloneNode(true));
  const t = doc.createElementNS(W, "w:t");
  t.setAttributeNS(XML_NS, "xml:space", "preserve");
  t.textContent = text;
  r.appendChild(t);
  p.appendChild(r);
}

/** 设置单元格文本：写入首个段落，删除多余段落（tcPr 等保留） */
function setCellText(tc: Element, text: string): void {
  const doc = tc.ownerDocument;
  const ps = childElems(tc, "p");
  let p = ps[0];
  if (!p) {
    p = doc.createElementNS(W, "w:p");
    tc.appendChild(p);
  }
  for (let i = ps.length - 1; i >= 1; i--) tc.removeChild(ps[i]);
  setParaText(p, text);
}

/** 新建正文段落，pPr 从样式来源克隆（继承 Normal/缩进等） */
function makeBodyPara(doc: Document, text: string, styleSrc: Element | null): Element {
  const p = doc.createElementNS(W, "w:p");
  const pPr = styleSrc ? firstChildElem(styleSrc, "pPr") : null;
  if (pPr) p.appendChild(pPr.cloneNode(true));
  const r = doc.createElementNS(W, "w:r");
  const t = doc.createElementNS(W, "w:t");
  t.setAttributeNS(XML_NS, "xml:space", "preserve");
  t.textContent = text;
  r.appendChild(t);
  p.appendChild(r);
  return p;
}

/* ---------------- 解析 ---------------- */

/** 从 styles.xml 找出「标题类」样式 id（name 以 heading 开头或为 title） */
function headingStyleIds(stylesXml: string): Set<string> {
  const ids = new Set<string>();
  const doc = new DOMParser().parseFromString(stylesXml, "application/xml");
  const styles = doc.getElementsByTagNameNS(W, "style");
  for (let i = 0; i < styles.length; i++) {
    const st = styles[i];
    if (st.getAttributeNS(W, "type") !== "paragraph") continue;
    const id = st.getAttributeNS(W, "styleId");
    const nameEl = firstChildElem(st, "name");
    const name = (nameEl?.getAttributeNS(W, "val") ?? "").trim().toLowerCase();
    if (id && (name.startsWith("heading") || name === "title")) ids.add(id);
  }
  return ids;
}

function paraStyleId(p: Element): string | null {
  const pPr = firstChildElem(p, "pPr");
  if (!pPr) return null;
  const ps = firstChildElem(pPr, "pStyle");
  return ps?.getAttributeNS(W, "val") ?? null;
}

export async function parseDocxTemplate(bytes: Uint8Array): Promise<DocxTemplate> {
  const zip = await JSZip.loadAsync(bytes);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("不是有效的 Word 文档（缺少 document.xml）");
  const docXml = await docFile.async("string");
  const doc = new DOMParser().parseFromString(docXml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("Word 文档解析失败");
  }
  const stylesFile = zip.file("word/styles.xml");
  const headingIds = stylesFile ? headingStyleIds(await stylesFile.async("string")) : new Set<string>();

  const body = doc.getElementsByTagNameNS(W, "body")[0];
  if (!body) throw new Error("Word 文档结构异常（缺少 body）");

  // 按 body 直接子节点切分：首个标题段为文档标题，其后每个标题段起一节
  let titleP: Element | null = null;
  const sections: ParsedSection[] = [];
  let cur: ParsedSection | null = null;
  const kids = body.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i] as Element;
    if (el.nodeType !== 1 || el.namespaceURI !== W) continue;
    if (el.localName === "p") {
      const isHeading = headingIds.has(paraStyleId(el) ?? "");
      if (isHeading && !titleP) {
        titleP = el;
      } else if (isHeading) {
        cur = { heading: elemText(el).trim(), headingP: el, proseParas: [], tables: [] };
        sections.push(cur);
      } else if (cur) {
        cur.proseParas.push(el);
      }
    } else if (el.localName === "tbl" && cur) {
      cur.tables.push(el);
    }
  }

  const outline: DocxOutline = {
    title: titleP ? elemText(titleP).trim() : "",
    sections: sections.map((s) => {
      if (s.tables.length) {
        const header = firstChildElem(s.tables[0], "tr");
        const columns = header ? childElems(header, "tc").map((tc) => elemText(tc).trim()) : [];
        return { heading: s.heading, kind: "table", columns } as DocxSectionOutline;
      }
      const instructions = s.proseParas.map(elemText).map((t) => t.trim()).filter(Boolean).join("\n");
      return { heading: s.heading, kind: "prose", instructions } as DocxSectionOutline;
    }),
  };

  return { zip, doc, titleP, sections, outline };
}

/* ---------------- 回填 ---------------- */

function rowIsEmpty(tr: Element): boolean {
  return childElems(tr, "tc").every((tc) => elemText(tc).trim() === "");
}

/**
 * 用 rows 替换表格的「空数据行」，保留所有非空行（表头/标签/标题行）。
 * 以首个空行作克隆模板（保留其单元格格式/列宽）；无空行则退而克隆末行。
 */
function fillTable(tbl: Element, rows: string[][]): void {
  const trs = childElems(tbl, "tr");
  if (trs.length === 0) return;
  const emptyRows = trs.filter(rowIsEmpty);
  const rowTemplate = (emptyRows[0] ?? trs[trs.length - 1]).cloneNode(true) as Element;
  childElems(rowTemplate, "tc").forEach((tc) => setCellText(tc, ""));
  emptyRows.forEach((tr) => tbl.removeChild(tr));
  for (const row of rows) {
    const tr = rowTemplate.cloneNode(true) as Element;
    const tcs = childElems(tr, "tc");
    for (let c = 0; c < tcs.length; c++) setCellText(tcs[c], row[c] ?? "");
    tbl.appendChild(tr);
  }
}

/** 用 prose 文本替换正文章节的说明段落（按空行/换行拆段，继承原段样式） */
function fillProse(section: ParsedSection, text: string): void {
  const doc = section.headingP.ownerDocument;
  const parent = section.headingP.parentNode!;
  const styleSrc = section.proseParas[0] ?? null;
  section.proseParas.forEach((p) => parent.removeChild(p));
  const paras = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  let anchor: Node = section.headingP;
  for (const line of paras) {
    const p = makeBodyPara(doc, line, styleSrc);
    parent.insertBefore(p, anchor.nextSibling);
    anchor = p;
  }
}

function normHeading(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

/** 按填充内容回写模板 DOM，打包返回 .docx 字节 */
export async function fillDocxTemplate(tpl: DocxTemplate, filled: DocxFilled): Promise<Uint8Array> {
  if (filled.title && tpl.titleP) setParaText(tpl.titleP, filled.title);

  const byHeading = new Map<string, DocxFilledSection>();
  filled.sections.forEach((s) => byHeading.set(normHeading(s.heading), s));

  for (const section of tpl.sections) {
    const f = byHeading.get(normHeading(section.heading));
    if (!f) continue;
    if (section.tables.length) {
      if (f.rows && f.rows.length) fillTable(section.tables[0], f.rows);
    } else if (typeof f.prose === "string" && f.prose.trim()) {
      fillProse(section, f.prose);
    }
  }

  // 去掉序列化器可能保留的声明，统一前置标准 XML 声明（避免重复声明）
  const serialized = new XMLSerializer().serializeToString(tpl.doc).replace(/^<\?xml[^>]*\?>\s*/, "");
  tpl.zip.file("word/document.xml", XML_DECL + serialized);
  return tpl.zip.generateAsync({ type: "uint8array", mimeType: DOCX_MIME });
}

/* ---------------- 预览（filled → Markdown） ---------------- */

/** 生成屏幕预览用 Markdown（产物仍是 .docx；这里只为在现有预览面板展示） */
export function docxFilledToMarkdown(outline: DocxOutline, filled: DocxFilled): string {
  const byHeading = new Map<string, DocxFilledSection>();
  filled.sections.forEach((s) => byHeading.set(normHeading(s.heading), s));
  const out: string[] = [];
  out.push(`# ${filled.title || outline.title}`);
  for (const sec of outline.sections) {
    out.push(`\n## ${sec.heading}`);
    const f = byHeading.get(normHeading(sec.heading));
    if (sec.kind === "table") {
      const cols = sec.columns ?? [];
      out.push(`| ${cols.join(" | ")} |`);
      out.push(`| ${cols.map(() => "---").join(" | ")} |`);
      for (const row of f?.rows ?? []) {
        const cells = cols.map((_, i) => (row[i] ?? "").replace(/\|/g, "\\|"));
        out.push(`| ${cells.join(" | ")} |`);
      }
    } else {
      out.push(f?.prose?.trim() || "（暂无）");
    }
  }
  return out.join("\n");
}

/* ---------------- 标题变量 & 直接整理兜底 ---------------- */

/** 用实际时间范围替换标题里的占位写法：年份、X月、第X周 */
export function fillTitleVars(title: string, range: { start: string; end: string }): string {
  const year = +range.start.slice(0, 4);
  const month = +range.start.slice(5, 7);
  const { week } = isoWeek(range.start);
  return title
    .replace(/\d{4}\s*年/, `${year}年`)
    .replace(/(?:\d+|[xX])\s*月/, `${month}月`)
    .replace(/第\s*(?:\d+|[xX])\s*周/, `第${week}周`);
}

/** 离线兜底填充：标题按范围改写；表格逐条填记录；正文节填分组记录文本。结果较粗糙。 */
export function directFill(
  outline: DocxOutline,
  entries: Entry[],
  range: { start: string; end: string },
): DocxFilled {
  const sections: DocxFilledSection[] = outline.sections.map((sec) => {
    if (sec.kind === "table") {
      const cols = sec.columns ?? [];
      // 启发式列定位：含「时间/日期」的列放日期，含「目标/内容/事项/工作」的列放正文
      const timeCol = cols.findIndex((c) => /时间|日期/.test(c));
      let textCol = cols.findIndex((c) => /目标|内容|事项|工作|描述/.test(c));
      if (textCol < 0) textCol = timeCol === 0 ? 1 : 0;
      const rows = entries.map((e) => {
        const row = cols.map(() => "");
        if (timeCol >= 0) row[timeCol] = e.entry_date;
        row[textCol] = e.content;
        return row;
      });
      return { heading: sec.heading, rows };
    }
    const prose = entries.length
      ? entries.map((e) => `${e.entry_date} ${timeOf(e.created_at)} ${e.content}`).join("\n")
      : "（该时间范围内没有记录）";
    return { heading: sec.heading, prose };
  });
  return { title: fillTitleVars(outline.title, range), sections };
}
