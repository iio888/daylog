import type { Entry } from "./types";
import { parseProject, parseTags } from "./parse";

/**
 * 统一后端接口。
 * Tauri 环境（Windows 正式运行）→ Rust + SQLite；
 * 纯浏览器环境（vite dev/preview，用于开发预览）→ localStorage mock。
 */
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
  /** 打开数据/模板/导出目录（仅桌面版有效） */
  openDir(kind: "data" | "templates" | "exports"): Promise<void>;
  saveReport(type: string, start: string, end: string, template: string, content: string): Promise<void>;

  /* ---- M3：设置与 AI ---- */
  getSettings(): Promise<unknown>;
  saveSettings(settings: unknown): Promise<void>;
  /** 统一 AI 调用（提示词在 src/ai.ts 构造）。Tauri：Rust reqwest；浏览器：模拟模型 */
  aiChat(system: string, user: string): Promise<string>;
  /** 探活并列出端点可用模型（仅 Base URL + Key，供「测试连接」用） */
  aiModels(baseUrl: string, apiKey: string): Promise<string[]>;
  /** JSON 备份导入（按 id 去重），返回实际新增条数 */
  importEntries(entries: Entry[]): Promise<number>;
}

const isTauri = "__TAURI_INTERNALS__" in window;

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
    openDir: (kind) => call("open_dir", { kind }),
    saveReport: (reportType, rangeStart, rangeEnd, template, content) =>
      call("save_report", { reportType, rangeStart, rangeEnd, template, content }),
    getSettings: () => call("get_settings"),
    saveSettings: (settings) => call("save_settings", { settings }),
    aiChat: (system, user) => call("ai_chat", { system, user }),
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
        .slice(0, 500);
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
    async openDir() {
      throw new Error("浏览器预览模式不支持打开本地目录（桌面版可用）");
    },
    async saveReport(type, start, end, template, content) {
      const list: unknown[] = JSON.parse(localStorage.getItem("daylog-reports") ?? "[]");
      list.push({ id: genId(), type, start, end, template, content, created_at: new Date().toISOString() });
      localStorage.setItem("daylog-reports", JSON.stringify(list.slice(-50)));
    },

    /* ---- M3：设置与 AI（浏览器实现） ---- */
    async getSettings() {
      return JSON.parse(localStorage.getItem("daylog-settings") ?? "{}");
    },
    async saveSettings(settings) {
      localStorage.setItem("daylog-settings", JSON.stringify(settings));
    },
    async aiChat(system, user) {
      // 预览模式没有真模型：按提示词意图给出可验收的模拟响应
      await new Promise((r) => setTimeout(r, 500));
      if (system.includes("拆分")) return JSON.stringify(mockSplit(user));
      if (system.includes("总结")) {
        const lines = user
          .split("\n")
          .filter((l) => l.trim())
          .slice(0, 6)
          .map((l) => `- ${l.replace(/^\[[^\]]*\]\s*/, "")}`);
        return `（预览模式模拟 AI 总结，桌面版接真实模型）\n\n${lines.join("\n")}`;
      }
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
