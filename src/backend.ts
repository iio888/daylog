import type { Entry } from "./types";
import { parseProject, parseTags } from "./parse";

/**
 * 统一后端接口。
 * Tauri 环境（Windows 正式运行）→ Rust + SQLite；
 * 纯浏览器环境（vite dev/preview，用于开发预览）→ localStorage mock。
 */
/** 搜索结果条数上限，与 src-tauri/src/db.rs 的 query() LIMIT 一致；命中上限时 UI 需提示已截断 */
export const SEARCH_LIMIT = 500;

/** 一份生成过的报告。字段名与 reports 表逐字一致，方便直接对照 SQL */
export interface ReportRecord {
  id: string;
  type: string;
  range_start: string;
  range_end: string;
  /** 生成时所用模板的展示名 */
  template: string;
  /** 报告正文（Markdown）。Word 模板生成的只存文字，不含 .docx 二进制 */
  content: string;
  created_at: string;
}

export interface Backend {
  add(content: string, entryDate: string): Promise<Entry>;
  listRange(start: string, end: string): Promise<Entry[]>;
  update(id: string, content: string): Promise<Entry>;
  remove(id: string): Promise<void>;
  /** 搜索/过滤统一入口，条件可叠加，结果按日期倒序 */
  query(q?: string, tag?: string, project?: string): Promise<Entry[]>;
  listYears(): Promise<number[]>;
  listTags(): Promise<[string, number][]>;
  listProjects(): Promise<[string, number][]>;

  /* ---- M2：模板与报告 ---- */
  /** 首次启动播种内置模板（带标记，用户删除后不恢复） */
  ensureTemplatesSeeded(builtins: { filename: string; content: string }[]): Promise<void>;
  /** 返回 [文件名, 原始内容]；frontmatter 解析在前端做 */
  listTemplates(): Promise<[string, string][]>;
  saveTemplate(filename: string, content: string): Promise<void>;
  /** 导出文件。Tauri：写入 exports/ 并返回完整路径；浏览器：触发下载并返回 null */
  exportFile(filename: string, content: string): Promise<string | null>;

  /* ---- Word 模板（二进制） ---- */
  /** 列出模板目录下的 .docx 文件名 */
  listDocxTemplates(): Promise<string[]>;
  /** 读取模板目录下某文件的二进制内容 */
  readTemplateBytes(filename: string): Promise<Uint8Array>;
  /** 保存二进制模板（导入 .docx 用） */
  saveTemplateBytes(filename: string, bytes: Uint8Array): Promise<void>;
  /** 导出二进制文件（.docx）。Tauri：写 exports/ 返回路径；浏览器：触发下载返回 null */
  exportBytes(filename: string, bytes: Uint8Array): Promise<string | null>;
  /** 打开数据/模板/导出目录（仅桌面版有效） */
  openDir(kind: "data" | "templates" | "exports"): Promise<void>;
  /** 当前导出目录的完整路径（供展示） */
  getExportDir(): Promise<string>;
  /** 设置导出目录；传空字符串恢复默认 */
  setExportDir(dir: string): Promise<void>;
  /** 弹出文件夹选择框，返回所选路径；取消返回 null（浏览器用输入框兜底） */
  pickExportDir(current: string): Promise<string | null>;
  saveReport(type: string, start: string, end: string, template: string, content: string): Promise<void>;
  /** 生成历史，最近的在前（最多 50 份，由后端裁剪） */
  listReports(): Promise<ReportRecord[]>;
  deleteReport(id: string): Promise<void>;

  /* ---- M3：设置与 AI ---- */
  getSettings(): Promise<unknown>;
  saveSettings(settings: unknown): Promise<void>;
  /** 统一 AI 调用（提示词在 src/ai.ts 构造）。Tauri：Rust reqwest；浏览器：模拟模型 */
  aiChat(system: string, user: string): Promise<string>;
  /** 放弃在途的 AI 请求；没有在途请求时是空操作 */
  aiCancel(): Promise<void>;
  /** 探活并列出端点可用模型（仅 Base URL + Key，供「测试连接」用） */
  aiModels(baseUrl: string, apiKey: string): Promise<string[]>;
  /** JSON 备份导入（按 id 去重），返回实际新增条数 */
  importEntries(entries: Entry[]): Promise<number>;
}

const isTauri = "__TAURI_INTERNALS__" in window;

/* ---------------- base64 ↔ 字节（二进制桥接） ---------------- */

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------------- Tauri 实现 ---------------- */

function tauriBackend(): Backend {
  // 动态 import 避免纯浏览器环境加载失败
  const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  };
  return {
    add: (content, entryDate) =>
      call("add_entry", {
        content,
        tags: parseTags(content),
        project: parseProject(content),
        entryDate,
      }),
    listRange: (start, end) => call("list_range", { start, end }),
    update: (id, content) =>
      call("update_entry", {
        id,
        content,
        tags: parseTags(content),
        project: parseProject(content),
      }),
    remove: (id) => call("delete_entry", { id }),
    query: (q, tag, project) => call("query_entries", { q, tag, project }),
    listYears: () => call("list_years"),
    listTags: () => call("list_tags"),
    listProjects: () => call("list_projects"),
    ensureTemplatesSeeded: (builtins) =>
      call("ensure_templates_seeded", { builtins: builtins.map((b) => [b.filename, b.content]) }),
    listTemplates: () => call("list_templates"),
    saveTemplate: (filename, content) => call("save_template", { filename, content }),
    exportFile: (filename, content) => call("export_report", { filename, content }),
    listDocxTemplates: () => call("list_docx_templates"),
    readTemplateBytes: async (filename) =>
      b64ToBytes(await call<string>("read_template_bytes", { filename })),
    saveTemplateBytes: (filename, bytes) =>
      call("save_template_bytes", { filename, dataB64: bytesToB64(bytes) }),
    exportBytes: (filename, bytes) =>
      call<string>("export_report_bytes", { filename, dataB64: bytesToB64(bytes) }),
    openDir: (kind) => call("open_dir", { kind }),
    getExportDir: () => call("get_export_dir"),
    setExportDir: (dir) => call("set_export_dir", { dir }),
    async pickExportDir(current) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false, defaultPath: current || undefined });
      return typeof picked === "string" ? picked : null;
    },
    saveReport: (reportType, rangeStart, rangeEnd, template, content) =>
      call("save_report", { reportType, rangeStart, rangeEnd, template, content }),
    listReports: () => call("list_reports"),
    deleteReport: (id) => call("delete_report", { id }),
    getSettings: () => call("get_settings"),
    saveSettings: (settings) => call("save_settings", { settings }),
    aiChat: (system, user) => call("ai_chat", { system, user }),
    aiCancel: () => call("ai_cancel"),
    aiModels: (baseUrl, apiKey) => call("ai_models", { baseUrl, apiKey }),
    importEntries: (entries) => call("import_entries", { entries }),
  };
}

/* ---------------- localStorage mock（开发预览用） ---------------- */

const LS_KEY = "daylog-entries";

/** crypto.randomUUID 仅在安全上下文（HTTPS/localhost）存在；局域网 IP 访问预览时需手动生成 v4 */
function genId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function mockBackend(): Backend {
  const load = (): Entry[] => JSON.parse(localStorage.getItem(LS_KEY) ?? "[]");
  const save = (list: Entry[]) => localStorage.setItem(LS_KEY, JSON.stringify(list));
  const nowIso = () => {
    const d = new Date();
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const abs = Math.abs(off);
    return (
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
      `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
      `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
    );
  };
  const p = (n: number) => String(n).padStart(2, "0");

  return {
    async add(content, entryDate) {
      const list = load();
      const e: Entry = {
        id: genId(),
        content,
        tags: parseTags(content),
        project: parseProject(content),
        entry_date: entryDate,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      list.push(e);
      save(list);
      return e;
    },
    async listRange(start, end) {
      return load()
        .filter((e) => e.entry_date >= start && e.entry_date <= end)
        .sort(
          (a, b) =>
            a.entry_date.localeCompare(b.entry_date) ||
            a.created_at.localeCompare(b.created_at),
        );
    },
    async update(id, content) {
      const list = load();
      const e = list.find((x) => x.id === id);
      if (!e) throw new Error("entry not found");
      e.content = content;
      e.tags = parseTags(content);
      e.project = parseProject(content);
      e.updated_at = nowIso();
      save(list);
      return e;
    },
    async remove(id) {
      save(load().filter((x) => x.id !== id));
    },
    async query(q, tag, project) {
      const qq = q?.toLowerCase();
      const tg = tag?.toLowerCase();
      const pj = project?.toLowerCase();
      return load()
        .filter(
          (e) =>
            (!qq || e.content.toLowerCase().includes(qq)) &&
            (!tg || e.tags.some((t) => t.toLowerCase() === tg)) &&
            (!pj || e.project?.toLowerCase() === pj),
        )
        .sort(
          (a, b) =>
            b.entry_date.localeCompare(a.entry_date) ||
            b.created_at.localeCompare(a.created_at),
        )
        .slice(0, SEARCH_LIMIT);
    },
    async listYears() {
      return [...new Set(load().map((e) => +e.entry_date.slice(0, 4)))].sort();
    },
    async listTags() {
      const freq = new Map<string, number>();
      load().forEach((e) => e.tags.forEach((t) => freq.set(t, (freq.get(t) ?? 0) + 1)));
      return [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    },
    async listProjects() {
      const freq = new Map<string, number>();
      load().forEach((e) => {
        if (e.project) freq.set(e.project, (freq.get(e.project) ?? 0) + 1);
      });
      return [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    },

    /* ---- M2：模板与报告（localStorage 实现） ---- */
    async ensureTemplatesSeeded(builtins) {
      if (localStorage.getItem("daylog-templates-seeded")) return;
      const map: Record<string, string> = JSON.parse(
        localStorage.getItem("daylog-templates") ?? "{}",
      );
      builtins.forEach((b) => (map[b.filename] = b.content));
      localStorage.setItem("daylog-templates", JSON.stringify(map));
      localStorage.setItem("daylog-templates-seeded", "1");
    },
    async listTemplates() {
      const map: Record<string, string> = JSON.parse(
        localStorage.getItem("daylog-templates") ?? "{}",
      );
      return Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
    },
    async saveTemplate(filename, content) {
      const map: Record<string, string> = JSON.parse(
        localStorage.getItem("daylog-templates") ?? "{}",
      );
      map[filename] = content;
      localStorage.setItem("daylog-templates", JSON.stringify(map));
    },
    async exportFile(filename, content) {
      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      return null; // 浏览器下载，无本地路径
    },
    async listDocxTemplates() {
      const map: Record<string, string> = JSON.parse(
        localStorage.getItem("daylog-docx-templates") ?? "{}",
      );
      return Object.keys(map).sort();
    },
    async readTemplateBytes(filename) {
      const map: Record<string, string> = JSON.parse(
        localStorage.getItem("daylog-docx-templates") ?? "{}",
      );
      const b64 = map[filename];
      if (!b64) throw new Error(`找不到模板：${filename}`);
      return b64ToBytes(b64);
    },
    async saveTemplateBytes(filename, bytes) {
      const map: Record<string, string> = JSON.parse(
        localStorage.getItem("daylog-docx-templates") ?? "{}",
      );
      map[filename] = bytesToB64(bytes);
      localStorage.setItem("daylog-docx-templates", JSON.stringify(map));
    },
    async exportBytes(filename, bytes) {
      const blob = new Blob([bytes as BlobPart], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      return null;
    },
    async openDir() {
      throw new Error("浏览器预览模式不支持打开本地目录（桌面版可用）");
    },
    async getExportDir() {
      return localStorage.getItem("daylog-export-dir") || "浏览器默认下载目录";
    },
    async setExportDir(dir) {
      if (dir.trim()) localStorage.setItem("daylog-export-dir", dir.trim());
      else localStorage.removeItem("daylog-export-dir");
    },
    async pickExportDir(current) {
      // 浏览器无原生文件夹选择，用输入框兜底（仅预览用，实际下载位置由浏览器决定）
      const v = window.prompt("输入导出目录的完整路径（浏览器预览仅作记录，实际下载位置由浏览器决定）", current);
      return v && v.trim() ? v.trim() : null;
    },
    // 字段名必须与 reports 表一致（range_start / range_end）：此前写成 start / end，
    // 因为一直没人读所以没暴露，现在有历史列表了，写错就是读出来一片 undefined
    async saveReport(type, start, end, template, content) {
      const list: ReportRecord[] = JSON.parse(localStorage.getItem("daylog-reports") ?? "[]");
      list.push({
        id: genId(),
        type,
        range_start: start,
        range_end: end,
        template,
        content,
        created_at: new Date().toISOString(),
      });
      localStorage.setItem("daylog-reports", JSON.stringify(list.slice(-50)));
    },
    async listReports() {
      const list: ReportRecord[] = JSON.parse(localStorage.getItem("daylog-reports") ?? "[]");
      return list.slice().reverse(); // 最近的在前
    },
    async deleteReport(id) {
      const list: ReportRecord[] = JSON.parse(localStorage.getItem("daylog-reports") ?? "[]");
      localStorage.setItem("daylog-reports", JSON.stringify(list.filter((r) => r.id !== id)));
    },

    /* ---- M3：设置与 AI（浏览器实现） ---- */
    async getSettings() {
      return JSON.parse(localStorage.getItem("daylog-settings") ?? "{}");
    },
    async saveSettings(settings) {
      localStorage.setItem("daylog-settings", JSON.stringify(settings));
    },
    // 预览模式的"请求"只是个 setTimeout，没有在途连接可打断
    async aiCancel() {},
    async aiChat(system, user) {
      // 预览模式没有真模型：按提示词意图给出可验收的模拟响应
      await new Promise((r) => setTimeout(r, 500));
      // 这两条必须排在最前：撰写助手的提示词里含「总结」，会被下面的分支抢走
      if (system.includes("工作项提取助手")) return JSON.stringify(mockExtract(user));
      if (system.includes("工作总结撰写助手")) return JSON.stringify(mockWorkSummary(user));
      if (system.includes("拆分")) return JSON.stringify(mockSplit(user));
      if (system.includes("Word 报告模板")) return JSON.stringify(mockDocxFill(user));
      return "正常（预览模式模拟响应）";
    },
    async aiModels(baseUrl) {
      // 预览模式没有真端点：校验填了 Base URL 后返回一组示例模型
      await new Promise((r) => setTimeout(r, 400));
      if (!baseUrl.trim()) throw new Error("请先填写 Base URL");
      return ["qwen3:14b", "qwen2.5:7b", "llama3.1:8b", "gpt-4o-mini"];
    },
    async importEntries(entries) {
      const list = load();
      const have = new Set(list.map((e) => e.id));
      const fresh = entries.filter((e) => e.id && !have.has(e.id));
      save([...list, ...fresh]);
      return fresh.length;
    },
  };
}

/** 预览模式的 Word 模板填充（模拟 AI 返回；桌面版由真实模型完成） */
function mockDocxFill(user: string): unknown {
  let outline: { title?: string; sections?: { heading: string; kind: string; columns?: string[] }[] } = {};
  try {
    const m = user.match(/模板大纲：\n([\s\S]*?)\n\n工作记录：/);
    if (m) outline = JSON.parse(m[1]);
  } catch {
    /* 容错：大纲解析失败则返回空填充 */
  }
  const recs = (user.split("工作记录：")[1] ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  const sections = (outline.sections ?? []).map((sec) => {
    if (sec.kind === "table") {
      const cols = sec.columns ?? [];
      let textCol = cols.findIndex((c) => /目标|内容|事项|工作/.test(c));
      if (textCol < 0) textCol = 0;
      const rows = recs.slice(0, 8).map((line) => {
        const text = line.replace(/^\[[^\]]*\]\s*/, "");
        return cols.map((_, i) => (i === textCol ? text : ""));
      });
      return { heading: sec.heading, rows };
    }
    return { heading: sec.heading, prose: `（预览模式模拟）\n${recs.slice(0, 6).map((l) => l.replace(/^\[[^\]]*\]\s*/, "")).join("\n")}` };
  });
  return { title: outline.title ?? "", sections };
}

/** `[3] 2026-06-03 09:12 内容` → { n, project, text }。refs 必须是真实编号，
 *  否则预览模式下溯源行与 @项目 反推这两条路径完全走不到。 */
function mockRecords(block: string): { n: number; project: string; text: string }[] {
  return block
    .split("\n")
    .map((l) => l.match(/^\[(\d+)\]\s*\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}\s*(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ n: +m[1], project: m[2].match(/@(\S+?)(?=[\s，。：；]|$)/)?.[1] ?? "", text: m[2] }));
}

/** 工作项名取自记录本身，且不重复 @项目 名——真实模型也是这个要求 */
function mockTitle(text: string): string {
  const s = text.replace(/[@#][^\s，。：；]+\s*/g, "").replace(/\s+/g, "").slice(0, 12);
  return s || "其他事务";
}

/** 按 @项目 归组；没有项目的每 3 条凑一组 */
function mockGroups(block: string): { project: string; recs: { n: number; text: string }[] }[] {
  const groups = new Map<string, { project: string; recs: { n: number; text: string }[] }>();
  mockRecords(block).forEach((r, i) => {
    const k = r.project || `__other${Math.floor(i / 3)}`;
    const g = groups.get(k) ?? { project: r.project, recs: [] };
    g.recs.push({ n: r.n, text: r.text });
    groups.set(k, g);
  });
  return [...groups.values()];
}

/** 预览模式的工作项提取（模拟 AI 返回；桌面版由真实模型完成） */
function mockExtract(user: string): unknown {
  const items = mockGroups(user)
    .slice(0, 12)
    .map((g) => ({
      title: mockTitle(g.recs[0].text),
      project: g.project,
      tags: [],
      refs: g.recs.slice(0, 8).map((r) => r.n),
      summary: g.recs[0].text.slice(0, 60),
    }));
  return { items: items.length ? items : [{ title: "其他事务", project: "", tags: [], refs: [], summary: "（预览模式）" }] };
}

/** 预览模式的总结撰写（模拟 AI 返回；桌面版由真实模型完成） */
function mockWorkSummary(user: string): unknown {
  const headings = (user.match(/章节：\n([\s\S]*?)\n\n工作事实/)?.[1] ?? "")
    .split("\n")
    .map((l) => l.replace(/^\d+\.\s*/, "").replace(/（写作要求：[\s\S]*?）\s*$/, "").trim())
    .filter((h) => h && !h.startsWith("（"));

  const facts = user.split(/工作事实（[^）]*）：\n/)[1] ?? "";
  let items: { title: string; project: string; refs: number[] }[] = [];
  try {
    // 多段模式下工作事实是草稿 JSON；单段模式下是编号记录原文
    const drafts = JSON.parse(facts) as { items?: { title: string; project: string; refs: number[] }[] };
    items = (drafts.items ?? []).map((d) => ({ title: d.title, project: d.project, refs: d.refs }));
  } catch {
    items = mockGroups(facts).map((g) => ({
      title: mockTitle(g.recs[0].text),
      project: g.project,
      refs: g.recs.slice(0, 8).map((r) => r.n),
    }));
  }

  const names = headings.length ? headings : ["主要工作"];
  const sections = names.map((heading, i) => ({
    heading,
    items: items
      .filter((_, j) => j % names.length === i)
      .slice(0, 5)
      .map((it) => ({
        ...it,
        body: `（预览模式模拟）围绕${it.title}推进了本期工作，依据 ${it.refs.length} 条记录归纳，量化数据以记录为准（记录中未量化的不做补充），桌面版接真实模型后此处为符合 SMART 的正式行文。`,
      })),
  }));
  return { overview: "（预览模式模拟）本期工作概述，桌面版接真实模型后此处为模型撰写的整体概述。", sections };
}

/** 预览模式的启发式拆分（模拟 AI 返回；桌面版由真实模型完成） */
function mockSplit(text: string): { date: string; content: string; unknown: boolean }[] {
  const today = new Date();
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const offset = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return fmt(d);
  };
  const W: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
  const dow = ((today.getDay() + 6) % 7) + 1; // 周一=1
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      let m = line.match(/^(\d{1,2})月(\d{1,2})[日号]\s*[:：，,]?\s*/);
      if (m) {
        const d = `${today.getFullYear()}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
        return { date: d, content: line.slice(m[0].length), unknown: false };
      }
      m = line.match(/^周([一二三四五六日天])\s*[:：，,]?\s*/);
      if (m) {
        const diff = W[m[1]] - dow;
        return { date: offset(diff > 0 ? diff - 7 : diff), content: line.slice(m[0].length), unknown: false };
      }
      m = line.match(/^昨天\s*[:：，,]?\s*/);
      if (m) return { date: offset(-1), content: line.slice(m[0].length), unknown: false };
      m = line.match(/^前天\s*[:：，,]?\s*/);
      if (m) return { date: offset(-2), content: line.slice(m[0].length), unknown: false };
      m = line.match(/^今天\s*[:：，,]?\s*/);
      if (m) return { date: fmt(today), content: line.slice(m[0].length), unknown: false };
      return { date: fmt(today), content: line, unknown: true };
    });
}

export const backend: Backend = isTauri ? tauriBackend() : mockBackend();
export const isMock = !isTauri;
