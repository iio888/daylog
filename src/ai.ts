/** AI 能力封装：提示词构造、响应解析、云端隐私确认。HTTP 由 backend.aiChat 完成。 */

import { backend } from "./backend";
import { todayStr } from "./parse";

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
  const raw = await backend.aiChat(SPLIT_SYSTEM(today), text);
  // 容错：剥离代码块围栏，截取首尾方括号之间的 JSON
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("AI 返回了无法解析的内容，请重试");
  let arr: unknown;
  try {
    arr = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error("AI 返回了非法 JSON，请重试");
  }
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

const SUMMARY_SYSTEM = (typeLabel: string, range: string) => `你是工作报告撰写助手。基于用户提供的工作记录原文，撰写「${typeLabel}」的工作总结正文（时间范围：${range}）。
要求：
1. 只基于记录内容归纳，不编造；信息不足之处直接说明，不要臆测。
2. 中文、Markdown 格式；合并同类项、按主题归纳，保留 #标签 与 @项目 涉及的关键信息。
3. 直接输出总结正文，不要大标题、前言或解释。`;

const MAX_INPUT_CHARS = 30000;

export async function aiSummarize(
  entriesText: string,
  typeLabel: string,
  range: string,
): Promise<string> {
  let input = entriesText;
  let note = "";
  if (input.length > MAX_INPUT_CHARS) {
    input = input.slice(0, MAX_INPUT_CHARS);
    note = "\n\n> 注：记录过长，总结基于截断后的内容。";
  }
  const out = await backend.aiChat(SUMMARY_SYSTEM(typeLabel, range), input);
  return out.trim() + note;
}

/** 设置页「测试连接」：仅凭 Base URL + Key 探活，成功后返回端点可用模型列表 */
export async function aiListModels(baseUrl: string, apiKey: string): Promise<string[]> {
  return backend.aiModels(baseUrl, apiKey);
}
