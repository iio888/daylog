/** AI 能力封装：提示词构造、响应解析。HTTP 由 backend.aiChat 完成。 */

import { backend } from "./backend";
import { timeOf, todayStr } from "./parse";
import type { Entry } from "./types";
import type { MdOutline, Range, WorkItem, WorkSection, WorkSummary } from "./report";
import { normHeading, rangeLabel, sanitizeParagraph } from "./report";

/** 容错解析模型输出的 JSON：剥代码块围栏，截取首尾括号之间的部分。 */
function parseAiJson<T>(raw: string, open: "{" | "["): T {
  const close = open === "{" ? "}" : "]";
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = cleaned.indexOf(open);
  const end = cleaned.lastIndexOf(close);
  if (start < 0 || end <= start) throw new Error("AI 返回了无法解析的内容，请重试");
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    throw new Error("AI 返回了非法 JSON，请重试");
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface SplitItem {
  date: string; // YYYY-MM-DD
  content: string;
  /** AI 无法确定日期（界面黄色高亮，默认今天） */
  unknown: boolean;
}

const SPLIT_SYSTEM = (today: string) => `你是日志拆分助手。用户会发来一段可能包含多天工作内容的自由文本，请拆分为独立的工作条目并推断每条的日期。
规则：
1. 只输出 JSON 数组，不要任何解释或代码块标记。元素格式：{"date":"YYYY-MM-DD","content":"…","unknown":false}
2. content 必须取自原文的连续片段，不得改写、润色、增删信息；仅可剥离行首的纯日期引导词（如"周一："、"6月3日 "）。
3. 今天是 ${today}。相对日期以今天为锚点，解析为不晚于今天的最近日期（例如今天是周五，"周一"指本周一，"周六"指上周六）。
4. 无法确定日期的条目：date 填 "${today}"，unknown 设为 true。禁止猜测日期。
5. 一行包含多天的事项时可拆为多条。`;

export async function aiSplit(text: string): Promise<SplitItem[]> {
  const today = todayStr();
  const arr = parseAiJson<unknown>(await backend.aiChat(SPLIT_SYSTEM(today), text), "[");
  if (!Array.isArray(arr) || arr.length === 0) throw new Error("AI 未拆分出任何条目");
  return arr
    .map((it) => {
      const o = it as Record<string, unknown>;
      const content = String(o.content ?? "").trim();
      let date = String(o.date ?? "");
      let unknown = Boolean(o.unknown);
      // 日期非法或晚于今天 → 视为未识别，归到今天（禁止未来日期）
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) {
        date = today;
        unknown = true;
      }
      return { date, content, unknown };
    })
    .filter((it) => it.content !== "");
}

const MAX_INPUT_CHARS = 30000;

/* ---------------- AI 总结：语义归类工作项 + SMART 段落式撰写 ---------------- */

/** 单批预算。批次越小，单次输出越短、越不容易撞上 180s 超时。 */
const BASE_BATCH_CHARS = 9000;
/** 批次数上限：避免年度报告发几十次请求 */
const MAX_BATCHES = 12;
/** 单条记录上限：超长记录只截断它自己，保证 [编号] 不错位 */
const MAX_ENTRY_CHARS = 4000;
const MAX_REFS = 8;
/** 全报告工作项上限。这不是文风偏好，是输出长度的超时控制。 */
const MAX_ITEMS = 15;
/** 每批提取的工作项上限 */
const MAX_DRAFTS_PER_BATCH = 12;

/** 用户中途取消的哨兵，调用方据此区分「出错」与「主动放弃」 */
const CANCELLED = "__daylog_cancelled__";
export const isCancelled = (e: unknown) => e instanceof Error && e.message === CANCELLED;

/** 第一阶段（分段提取）的中间产物 */
export interface WorkItemDraft {
  title: string;
  project: string;
  tags: string[];
  refs: number[];
  summary: string;
}

export interface WorkSummaryProgress {
  phase: "extract" | "write";
  /** 1 起 */
  index: number;
  total: number;
}

export interface AiWorkSummaryResult {
  summary: WorkSummary;
  /** 截断、分段失败之类需要在报告里如实注明的提示 */
  notes: string[];
}

const EXTRACT_SYSTEM = (range: string) => `你是工作项提取助手，负责从一段工作记录中客观提取「工作项」。这一步只做归并与提取，不写总结、不润色、不评价。
记录格式：每行形如 \`[编号] YYYY-MM-DD HH:MM 记录原文\`。编号在整份记录中全局唯一、跨段连续。
时间范围：${range}
只输出一个 JSON 对象，不要任何解释或代码块标记，结构：
{"items":[{"title":"…","project":"…","tags":["…"],"refs":[1,2],"summary":"…"}]}
规则：
1. 一个 item 表示一件可以独立汇报的工作。同一件工作分散在多天、多条记录里的，必须归并成一个 item，不要按天逐条罗列。
2. title：6~20 字的工作项名称，用词取自记录本身，不加形容与评价。title 里不要重复 @项目 名（项目另有字段），直接写这件工作本身叫什么。
3. project：该工作项相关记录中出现的 @项目 名（不含 @）；没有就填空字符串。tags：相关记录中出现的 #标签 名（不含 #），最多 5 个；没有就填空数组。
4. refs：该工作项所依据的记录编号，必须是上面出现过的编号，按升序排列，最多 ${MAX_REFS} 个。禁止编造编号。
5. summary：不超过 60 字的客观事实摘要，只写记录里写了的内容——做了什么、进展到哪一步、记录中出现的数字与专有名词。禁止补充记录中没有的数字、人名、系统名和结论。
6. 本段最多输出 ${MAX_DRAFTS_PER_BATCH} 个 item。工作项过多时，把粒度最细的若干项归并，不要遗漏重要工作。
7. 实在无法归入任何工作项的零散记录，归并为一个 title 为「其他事务」的 item。
8. 全部使用中文。`;

const WRITE_SYSTEM = (typeLabel: string, range: string, freeSections: boolean) =>
  `你是工作总结撰写助手，需要把用户提供的工作事实整理成一份「${typeLabel}」的工作总结（时间范围：${range}）。
用户的消息包含两部分：
- 「章节」：本次报告的章节名清单，每节可能附有写作要求。
- 「工作事实」：可能是编号的工作记录原文（每行 \`[编号] YYYY-MM-DD HH:MM 原文\`），也可能是已经从记录中整理出的工作项草稿（含 title / project / tags / refs / summary）。两种情况下编号的含义完全一致。
只输出一个 JSON 对象，不要任何解释或代码块标记，结构：
{"overview":"…","sections":[{"heading":"<与章节清单逐字一致>","items":[{"title":"…","project":"…","refs":[1,2],"body":"…"}]}]}
规则：
1. 先按语义把工作事实归并成工作项：同一件工作即使跨多天、跨多条记录、用词不同，也必须合并成一个 item；不要按天逐条罗列，不要一条记录一个 item。
2. heading 必须逐字取自章节清单，顺序一致，不得新增章节、改写章节名或省略章节。把每个工作项分配到语义最贴近的那一节；某节确实没有对应内容时，items 给空数组 []。
3. 各节若附有写作要求，按其要求组织该节内容。
4. title：6~20 字的工作项名称，写这件工作本身叫什么，不要重复 @项目 名（项目另有字段）。project：该工作项的 @项目 名（不含 @），没有则填空字符串。refs：所依据的记录编号，必须是输入中出现过的编号，升序，最多 ${MAX_REFS} 个，禁止编造。
5. body 是这个工作项的总结正文，必须是一个连贯的自然段，60~180 字，行文中自然覆盖五个要素：做了哪件具体的事、可衡量的结果、投入与协作方式、这件事对项目或业务目标的意义、起止时间。
6. body 严禁出现「S:」「M：」「具体：」「可衡量：」这类要素标签，严禁使用列表符号（- * 1.）、Markdown 标题或加粗，严禁换行——整个 body 就是一段话。
7. 数字只能引用工作事实中出现过的数字。没有量化数据的地方写「（记录中未量化）」或直接不写量化，禁止编造数量、比例、耗时、金额、完成率。日期只能用工作事实中出现过的日期。禁止编造人名、系统名、部门和结论。
8. overview：不超过 120 字的整体概述，同样是一个自然段，不含列表和要素标签。
9. 全报告最多 ${MAX_ITEMS} 个工作项。
10. 全部使用中文。${
    freeSections ? "\n补充：本次章节清单为空，你可以自拟 heading；除此之外全部规则不变。" : ""
  }`;

interface NumberedRecord {
  n: number;
  date: string;
  /** "[3] 2026-06-03 09:12 内容原文" */
  text: string;
}

/** 编号全局连续、跨批次唯一——合并阶段的 refs 才有意义 */
function numberRecords(entries: Entry[]): { recs: NumberedRecord[]; notes: string[] } {
  let truncated = 0;
  const recs = entries.map((e, i) => {
    let content = e.content;
    if (content.length > MAX_ENTRY_CHARS) {
      content = `${content.slice(0, MAX_ENTRY_CHARS)}…（本条记录过长，已截断）`;
      truncated++;
    }
    return {
      n: i + 1,
      date: e.entry_date,
      text: `[${i + 1}] ${e.entry_date} ${timeOf(e.created_at)} ${content}`,
    };
  });
  return {
    recs,
    notes: truncated ? [`注：有 ${truncated} 条超长记录已截断后参与总结。`] : [],
  };
}

/** 优先按天切；单天本身超预算时在天内按条切；永不切开一条记录（宁可超出一条）。 */
function buildBatches(recs: NumberedRecord[]): { batches: NumberedRecord[][]; notes: string[] } {
  const total = recs.reduce((s, r) => s + r.text.length + 1, 0);
  if (total <= BASE_BATCH_CHARS) return { batches: [recs], notes: [] };

  const budget = Math.min(MAX_INPUT_CHARS, Math.max(BASE_BATCH_CHARS, Math.ceil(total / MAX_BATCHES)));
  const batches: NumberedRecord[][] = [];
  let cur: NumberedRecord[] = [];
  let size = 0;
  for (const r of recs) {
    const len = r.text.length + 1;
    if (cur.length > 0 && size + len > budget && (cur[cur.length - 1].date !== r.date || size >= budget)) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(r);
    size += len;
  }
  if (cur.length) batches.push(cur);

  // 记录量极端偏大时（约 36 万字符以上）批次仍会超上限，此时截掉尾部并如实注明
  if (batches.length <= MAX_BATCHES) return { batches, notes: [] };
  const kept = batches.slice(0, MAX_BATCHES);
  const used = kept.reduce((n, b) => n + b.length, 0);
  return {
    batches: kept,
    notes: [`注：记录过多（共 ${recs.length} 条），本次总结基于其中前 ${used} 条。`],
  };
}

function sectionListBlock(outline: MdOutline): string {
  const prose = outline.sections.filter((s) => s.kind === "prose");
  if (prose.length === 0) {
    return "章节：\n（本报告未指定章节，请按工作主题自行分组，产出 2~5 个章节，heading 为 4~10 字的中文章节名。）";
  }
  const lines = prose.map(
    (s, i) =>
      `${i + 1}. ${s.heading}${s.instructions ? `（写作要求：${s.instructions.replace(/\s*\n\s*/g, " ")}）` : ""}`,
  );
  return `章节：\n${lines.join("\n")}`;
}

/* ---------------- 校验：模型输出一律不采信，逐字段夹紧 ---------------- */

const str = (v: unknown, limit: number) => String(v ?? "").trim().slice(0, limit);

function cleanRefs(raw: unknown, maxRef: number): number[] {
  if (!Array.isArray(raw)) return [];
  const set = new Set<number>();
  for (const v of raw) {
    const n = Math.trunc(Number(v));
    if (Number.isFinite(n) && n >= 1 && n <= maxRef) set.add(n);
  }
  return [...set].sort((a, b) => a - b).slice(0, MAX_REFS);
}

/** @项目由 refs 回查记录取众数得出；只有 refs 全废时才退回模型给的字符串 */
function projectOf(refs: number[], entries: Entry[], fallback: string): string {
  if (refs.length === 0) return fallback;
  const freq = new Map<string, number>();
  for (const r of refs) {
    const p = entries[r - 1]?.project;
    if (p) freq.set(p, (freq.get(p) ?? 0) + 1);
  }
  let best = "";
  let top = 0;
  for (const [p, c] of freq) {
    if (c > top) {
      best = p;
      top = c;
    }
  }
  return best;
}

function toDrafts(raw: unknown, maxRef: number): WorkItemDraft[] {
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => {
      const o = it as Record<string, unknown>;
      return {
        title: str(o.title, 40),
        project: str(o.project, 20).replace(/^@/, ""),
        tags: Array.isArray(o.tags)
          ? o.tags.map((t) => str(t, 20).replace(/^#/, "")).filter(Boolean).slice(0, 5)
          : [],
        refs: cleanRefs(o.refs, maxRef),
        summary: str(o.summary, 80),
      };
    })
    .filter((d) => d.title !== "" && d.summary !== "")
    .slice(0, MAX_DRAFTS_PER_BATCH);
}

function toWorkSummary(raw: unknown, entries: Entry[]): WorkSummary {
  const o = raw as { overview?: unknown; sections?: unknown };
  const maxRef = entries.length;

  const sections: WorkSection[] = (Array.isArray(o.sections) ? o.sections : [])
    .map((s) => {
      const so = s as Record<string, unknown>;
      const items: WorkItem[] = (Array.isArray(so.items) ? so.items : [])
        .map((it) => {
          const io = it as Record<string, unknown>;
          const refs = cleanRefs(io.refs, maxRef);
          return {
            title: str(io.title, 40),
            project: projectOf(refs, entries, str(io.project, 20).replace(/^@/, "")),
            refs,
            // 格式由这里保证，不指望提示词自觉
            body: sanitizeParagraph(str(io.body, 600)),
          };
        })
        // refs 全废的项保留 body 只丢溯源行——不能因为模型数错编号就扔掉本身正确的正文
        .filter((i) => i.title !== "" && i.body !== "");

      // 同节内重复标题合并：并 refs，留第一段正文
      const merged = new Map<string, WorkItem>();
      for (const it of items) {
        const k = normHeading(it.title);
        const prev = merged.get(k);
        if (prev) prev.refs = cleanRefs([...prev.refs, ...it.refs], maxRef);
        else merged.set(k, it);
      }
      return { heading: str(so.heading, 40), items: [...merged.values()] };
    })
    .filter((s) => s.heading !== "");

  // 全报告条数上限（超时控制）
  let budget = MAX_ITEMS;
  for (const s of sections) {
    s.items = s.items.slice(0, Math.max(0, budget));
    budget -= s.items.length;
  }

  if (sections.reduce((n, s) => n + s.items.length, 0) === 0) {
    throw new Error("AI 未提取出任何工作项，请重试或改用直接整理");
  }
  return { overview: sanitizeParagraph(str(o.overview, 400)), sections };
}

/** 传输错误与 JSON 解析失败都重试一次。stream:false 无副作用，重试安全。 */
async function callJson<T>(system: string, user: string, open: "{" | "["): Promise<T> {
  try {
    return parseAiJson<T>(await backend.aiChat(system, user), open);
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
    return parseAiJson<T>(await backend.aiChat(system, user), open);
  }
}

/**
 * AI 总结主入口：分段提取 → 合并撰写。单段时跳过提取直接撰写。
 * entries 的顺序即 refs 的编号顺序，渲染时必须传同一个数组。
 */
export async function aiWorkSummary(
  entries: Entry[],
  outline: MdOutline,
  typeLabel: string,
  range: Range,
  opts: { onProgress?: (p: WorkSummaryProgress) => void; shouldCancel?: () => boolean } = {},
): Promise<AiWorkSummaryResult> {
  const label = rangeLabel(range);
  const { recs, notes } = numberRecords(entries);
  const { batches, notes: batchNotes } = buildBatches(recs);
  notes.push(...batchNotes);

  const bail = () => {
    if (opts.shouldCancel?.()) throw new Error(CANCELLED);
  };

  let factsKind = "记录原文";
  let facts: string;

  if (batches.length === 1) {
    // 单段直接撰写：提取阶段会把记录压成 60 字摘要，对一份日报是纯损失，且平白多一次往返
    facts = batches[0].map((r) => r.text).join("\n");
  } else {
    const drafts: WorkItemDraft[] = [];
    let firstErr = "";
    for (let i = 0; i < batches.length; i++) {
      bail();
      opts.onProgress?.({ phase: "extract", index: i + 1, total: batches.length });
      const b = batches[i];
      try {
        const raw = await callJson<unknown>(
          EXTRACT_SYSTEM(label),
          `工作记录（第 ${i + 1}/${batches.length} 段，编号 ${b[0].n}~${b[b.length - 1].n}）：\n${b
            .map((r) => r.text)
            .join("\n")}`,
          "{",
        );
        drafts.push(...toDrafts(raw, recs.length));
      } catch (e) {
        // 一段失败不该丢掉其余几段的成果，如实注明后继续
        firstErr = firstErr || errMsg(e);
        notes.push(
          `注：第 ${i + 1}/${batches.length} 段记录提取失败（${errMsg(e)}），本次总结未覆盖 ${b[0].date} ~ ${
            b[b.length - 1].date
          } 的 ${b.length} 条记录。`,
        );
      }
    }
    if (drafts.length === 0) throw new Error(`AI 分段提取全部失败：${firstErr}`);

    factsKind = `工作项草稿，来自 ${batches.length} 段记录的提取结果`;
    facts = JSON.stringify({ items: drafts });
    if (facts.length > MAX_INPUT_CHARS) {
      const sorted = [...drafts].sort((a, b) => b.refs.length - a.refs.length);
      let kept = sorted;
      while (kept.length > 1 && JSON.stringify({ items: kept }).length > MAX_INPUT_CHARS) {
        kept = kept.slice(0, kept.length - 1);
      }
      facts = JSON.stringify({ items: kept });
      notes.push(`注：提取出的工作项过多，本次撰写保留了依据最充分的 ${kept.length} 项。`);
    }
  }

  bail();
  opts.onProgress?.({ phase: "write", index: 1, total: 1 });
  const freeSections = outline.sections.every((s) => s.kind !== "prose");
  const raw = await callJson<unknown>(
    WRITE_SYSTEM(typeLabel, label, freeSections),
    `${sectionListBlock(outline)}\n\n工作事实（${factsKind}）：\n${facts}`,
    "{",
  );
  return { summary: toWorkSummary(raw, entries), notes };
}

/* ---------------- Word 报告模板填充 ---------------- */

const DOCX_FILL_SYSTEM = (typeLabel: string, range: string) => `你是工作报告撰写助手，需要把用户的工作记录填进一份「${typeLabel}」Word 报告模板（时间范围：${range}）。
模板以 JSON 大纲给出：title 为报告标题；sections 为各章节，每节含 heading（章节名）、kind（table=表格 / prose=正文）、table 章节给出 columns（表头列名），prose 章节给出 instructions（写作要求）。
请只输出一个 JSON 对象（不要任何解释或代码块标记），结构：
{"title":"...","sections":[{"heading":"<与大纲完全一致>","rows":[["列1","列2",...]]},{"heading":"...","prose":"..."}]}
规则：
1. heading 必须与大纲中的章节名逐字一致，便于回填。
2. kind=table 的章节给 rows：二维数组，每个内层数组长度等于该节 columns 的列数、顺序一致；据记录归纳填写，无内容则给空数组 []。
3. kind=prose 的章节给 prose：按其 instructions 的字数/条理要求撰写；prose 内用换行分段，不要 Markdown 标题或符号。
4. title：依据时间范围把标题中的年份、月份、第几周等占位写法替换为真实值。
5. 只基于记录内容归纳，不编造；信息不足之处如实说明。`;

export async function aiFillDocxTemplate(
  outline: import("./docx").DocxOutline,
  entriesText: string,
  typeLabel: string,
  range: string,
): Promise<import("./docx").DocxFilled> {
  let input = entriesText;
  if (input.length > MAX_INPUT_CHARS) input = input.slice(0, MAX_INPUT_CHARS);
  const user = `模板大纲：\n${JSON.stringify(outline)}\n\n工作记录：\n${input}`;
  const obj = parseAiJson<{ title?: unknown; sections?: unknown }>(
    await backend.aiChat(DOCX_FILL_SYSTEM(typeLabel, range), user),
    "{",
  );
  const sections: import("./docx").DocxFilledSection[] = Array.isArray(obj.sections)
    ? obj.sections
        .map((s): import("./docx").DocxFilledSection | null => {
          const o = s as Record<string, unknown>;
          const heading = String(o.heading ?? "").trim();
          if (!heading) return null;
          const prose = typeof o.prose === "string" ? o.prose : undefined;
          const rows = Array.isArray(o.rows)
            ? o.rows.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "")) : []))
            : undefined;
          return { heading, prose, rows };
        })
        .filter((s): s is import("./docx").DocxFilledSection => s !== null)
    : [];
  if (sections.length === 0) throw new Error("AI 未返回任何章节内容，请重试");
  return { title: typeof obj.title === "string" ? obj.title : undefined, sections };
}

/** 设置页「测试连接」：仅凭 Base URL + Key 探活，成功后返回端点可用模型列表 */
export async function aiListModels(baseUrl: string, apiKey: string): Promise<string[]> {
  return backend.aiModels(baseUrl, apiKey);
}
