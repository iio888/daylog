import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import { backend } from "../backend";
import { timeOf, todayStr } from "../parse";
import { toast } from "../toast";
import { aiConfigured, loadSettings } from "../settings";
import { aiFillDocxTemplate, aiSummarize } from "../ai";
import { copyText } from "../copy";
import {
  BUILTIN_TEMPLATES,
  REPORT_TYPE_LABEL,
  docxTemplate,
  parseTemplate,
  type ReportType,
  type Template,
} from "../templates";
import { computeRange, exportBaseName, fillTemplate, mdToPlain, wrapHtml } from "../report";
import {
  directFill,
  docxFilledToMarkdown,
  fillDocxTemplate,
  parseDocxTemplate,
  type DocxFilled,
} from "../docx";

const TYPES: ReportType[] = ["daily", "weekly", "quarterly", "yearly"];
const IMPORT_VALUE = "__import__";

interface Props {
  active: boolean;
}

export default function Report({ active }: Props) {
  const now = new Date();
  const [type, setType] = useState<ReportType>("weekly");
  // 各类型的范围选择器状态（互不干扰）
  const [day, setDay] = useState(todayStr());
  const [weekDay, setWeekDay] = useState(todayStr());
  const [qYear, setQYear] = useState(now.getFullYear());
  const [q, setQ] = useState<1 | 2 | 3 | 4>((Math.floor(now.getMonth() / 3) + 1) as 1 | 2 | 3 | 4);
  const [year, setYear] = useState(now.getFullYear());

  const [templates, setTemplates] = useState<Template[]>([]);
  const [tplFile, setTplFile] = useState("");
  const [years, setYears] = useState<number[]>([]);
  const [md, setMd] = useState("");
  // 当前生成结果若来自 Word 模板，保留其 .docx 字节（导出用；md 为屏幕预览）
  const [docxBytes, setDocxBytes] = useState<Uint8Array | null>(null);
  const [exportDir, setExportDirState] = useState("");
  const [tab, setTab] = useState<"render" | "src">("render");
  const [busy, setBusy] = useState(false);
  const [genMode, setGenMode] = useState<"direct" | "ai">("direct");
  const [aiReady, setAiReady] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const refresh = () =>
      void loadSettings().then((s) => {
        const ok = aiConfigured(s);
        setAiReady(ok);
        if (!ok) setGenMode("direct");
      });
    refresh();
    window.addEventListener("settings-changed", refresh);
    return () => window.removeEventListener("settings-changed", refresh);
  }, []);

  const reloadTemplates = useCallback(async () => {
    await backend.ensureTemplatesSeeded(BUILTIN_TEMPLATES);
    const [raw, docxNames] = await Promise.all([
      backend.listTemplates(),
      backend.listDocxTemplates(),
    ]);
    setTemplates([
      ...raw.map(([f, c]) => parseTemplate(f, c)),
      ...docxNames.map((f) => docxTemplate(f)),
    ]);
  }, []);

  // 进入报告页时重新扫描模板目录（支持用户在文件管理器中直接增删改）
  useEffect(() => {
    if (!active) return;
    void reloadTemplates().catch((e) => toast(`模板加载失败：${e}`));
    void backend.listYears().then(setYears);
    void backend.getExportDir().then(setExportDirState).catch(() => undefined);
  }, [active, reloadTemplates]);

  // 当前类型可用的模板（type 匹配或 any），默认选中第一个匹配项
  const usable = useMemo(
    () => templates.filter((t) => !t.error && (t.type === type || t.type === "any")),
    [templates, type],
  );
  const broken = useMemo(() => templates.filter((t) => t.error), [templates]);

  // 切换模板时丢弃上一次生成的 .docx，避免「导出 .docx」误用旧结果
  useEffect(() => {
    setDocxBytes(null);
  }, [tplFile]);

  useEffect(() => {
    if (!usable.find((t) => t.filename === tplFile)) {
      setTplFile(usable.find((t) => t.type === type)?.filename ?? usable[0]?.filename ?? "");
    }
  }, [usable, type, tplFile]);

  const range = computeRange(type, { day, weekDay, qYear, q, year });
  const yearOptions = useMemo(() => {
    const set = new Set(years);
    set.add(now.getFullYear());
    return [...set].sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [years]);

  async function generate(mode: "direct" | "ai" = genMode) {
    const tpl = templates.find((t) => t.filename === tplFile);
    if (!tpl) {
      toast("请先选择模板");
      return;
    }
    if (tpl.kind === "docx") return generateDocx(tpl, mode);
    setBusy(true);
    setAiError(null);
    try {
      setDocxBytes(null);
      const entries = await backend.listRange(range.start, range.end);
      let summaryOverride: string | undefined;
      if (mode === "ai") {
        if (entries.length === 0) {
          toast("该范围没有记录，无需 AI 总结");
          setBusy(false);
          return;
        }
        const entriesText = entries
          .map((e) => `[${e.entry_date} ${timeOf(e.created_at)}] ${e.content}`)
          .join("\n");
        const rangeLabel = range.start === range.end ? range.start : `${range.start} ~ ${range.end}`;
        try {
          summaryOverride = await aiSummarize(entriesText, REPORT_TYPE_LABEL[type], rangeLabel);
        } catch (e) {
          setAiError(e instanceof Error ? e.message : String(e));
          setBusy(false);
          return;
        }
      }
      const result = fillTemplate(tpl.body, entries, range, summaryOverride);
      setMd(result);
      setTab("render");
      void backend
        .saveReport(type, range.start, range.end, tpl.name, result)
        .catch(() => undefined); // 历史记录失败不打扰
      toast(
        mode === "ai"
          ? `已生成 AI 总结（基于 ${entries.length} 条记录）`
          : entries.length
            ? `已生成（${entries.length} 条记录）`
            : "已生成（该范围没有记录）",
      );
    } catch (e) {
      toast(`生成失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }

  /** Word 模板生成：解析 .docx 骨架 → AI/直接填充 → 回写为 .docx 字节（+ 屏幕预览 md） */
  async function generateDocx(tpl: Template, mode: "direct" | "ai") {
    setBusy(true);
    setAiError(null);
    try {
      const entries = await backend.listRange(range.start, range.end);
      const bytes = await backend.readTemplateBytes(tpl.filename);
      const template = await parseDocxTemplate(bytes);
      const rangeLabel = range.start === range.end ? range.start : `${range.start} ~ ${range.end}`;

      let filled: DocxFilled;
      if (mode === "ai") {
        if (entries.length === 0) {
          toast("该范围没有记录，无需 AI 填充");
          setBusy(false);
          return;
        }
        const entriesText = entries
          .map((e) => `[${e.entry_date} ${timeOf(e.created_at)}] ${e.content}`)
          .join("\n");
        try {
          filled = await aiFillDocxTemplate(template.outline, entriesText, REPORT_TYPE_LABEL[type], rangeLabel);
        } catch (e) {
          setAiError(e instanceof Error ? e.message : String(e));
          setBusy(false);
          return;
        }
      } else {
        filled = directFill(template.outline, entries, range);
      }

      const out = await fillDocxTemplate(template, filled);
      const previewMd = docxFilledToMarkdown(template.outline, filled);
      setDocxBytes(out);
      setMd(previewMd);
      setTab("render");
      void backend
        .saveReport(type, range.start, range.end, tpl.name, previewMd)
        .catch(() => undefined);
      toast(
        mode === "ai"
          ? `已生成 Word 报告（AI 填充，基于 ${entries.length} 条记录）`
          : `已生成 Word 报告（${entries.length} 条记录）`,
      );
    } catch (e) {
      toast(`生成失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }

  function exportName(ext: string): string {
    return `${exportBaseName(type, range)}.${ext}`;
  }

  async function doExportDocx() {
    if (!docxBytes) return toast("请先生成报告");
    try {
      const path = await backend.exportBytes(exportName("docx"), docxBytes);
      toast(path ? `已导出：${path}` : "已开始下载");
    } catch (e) {
      toast(`导出失败：${e instanceof Error ? e.message : e}`);
    }
  }

  async function copyExportDir() {
    try {
      await copyText(exportDir);
      toast("已复制导出路径");
    } catch (e) {
      toast(`${e instanceof Error ? e.message : e}`);
    }
  }

  async function configExportDir() {
    try {
      const picked = await backend.pickExportDir(exportDir);
      if (!picked) return;
      await backend.setExportDir(picked);
      const now = await backend.getExportDir();
      setExportDirState(now);
      toast(`导出位置已设为：${now}`);
    } catch (e) {
      toast(`设置失败：${e instanceof Error ? e.message : e}`);
    }
  }

  async function doCopy(kind: "md" | "plain") {
    if (!md) return toast("请先生成报告");
    try {
      await copyText(kind === "md" ? md : mdToPlain(md));
      toast(kind === "md" ? "已复制 Markdown" : "已复制纯文本");
    } catch (e) {
      toast(`${e instanceof Error ? e.message : e}`);
    }
  }

  async function doExport(kind: "md" | "html") {
    if (!md) return toast("请先生成报告");
    const body = kind === "md" ? md : wrapHtml(exportName("html"), marked.parse(md) as string);
    // 加 UTF-8 BOM：否则 WPS / Word / 记事本在中文 Windows 上按 GBK 打开会乱码
    const content = `\uFEFF${body}`;
    try {
      const path = await backend.exportFile(exportName(kind), content);
      toast(path ? `已导出：${path}` : "已开始下载");
    } catch (e) {
      toast(`导出失败：${e instanceof Error ? e.message : e}`);
    }
  }

  /** 打印 PDF：独立 HTML 塞进隐藏 iframe 调系统打印对话框（浏览器与 WebView2 均可用） */
  function doPrint() {
    if (!md) return toast("请先生成报告");
    const html = wrapHtml(exportName("pdf"), marked.parse(md) as string);
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    document.body.appendChild(iframe);
    iframe.srcdoc = html;
    iframe.onload = () => {
      iframe.contentWindow?.print();
      setTimeout(() => iframe.remove(), 60000);
    };
  }

  function onPickTemplate(v: string) {
    if (v !== IMPORT_VALUE) {
      setTplFile(v);
      return;
    }
    fileRef.current?.click();
  }

  async function onImportFile(file: File) {
    try {
      if (file.name.toLowerCase().endsWith(".docx")) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await backend.saveTemplateBytes(file.name, bytes);
        await reloadTemplates();
        setTplFile(file.name);
        toast(`已导入 Word 模板：${file.name.replace(/\.docx$/i, "")}`);
        return;
      }
      const content = await file.text();
      const filename = file.name.endsWith(".md") ? file.name : `${file.name}.md`;
      await backend.saveTemplate(filename, content);
      await reloadTemplates();
      const t = parseTemplate(filename, content);
      if (t.error) toast(`已导入，但格式有误：${t.error}`);
      else {
        if (t.type === type || t.type === "any") setTplFile(filename);
        toast(`已导入模板：${t.name}`);
      }
    } catch (e) {
      toast(`导入失败：${e instanceof Error ? e.message : e}`);
    }
  }

  return (
    <div className="report">
      <aside className="report-side">
        <div className="field">
          <label>报告类型</label>
          <select value={type} onChange={(e) => setType(e.target.value as ReportType)}>
            {TYPES.map((t) => (
              <option key={t} value={t}>{REPORT_TYPE_LABEL[t]}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>时间范围</label>
          {type === "daily" && (
            <input type="date" value={day} max={todayStr()} onChange={(e) => setDay(e.target.value || todayStr())} />
          )}
          {type === "weekly" && (
            <input
              type="date"
              value={weekDay}
              max={todayStr()}
              title="点选该周内任意一天"
              onChange={(e) => setWeekDay(e.target.value || todayStr())}
            />
          )}
          {type === "quarterly" && (
            <div className="row2">
              <select value={qYear} onChange={(e) => setQYear(+e.target.value)}>
                {yearOptions.map((y) => <option key={y} value={y}>{y} 年</option>)}
              </select>
              <select value={q} onChange={(e) => setQ(+e.target.value as 1 | 2 | 3 | 4)}>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>Q{n}</option>)}
              </select>
            </div>
          )}
          {type === "yearly" && (
            <select value={year} onChange={(e) => setYear(+e.target.value)}>
              {yearOptions.map((y) => <option key={y} value={y}>{y} 年</option>)}
            </select>
          )}
          <div className="note">实际范围：{range.start === range.end ? range.start : `${range.start} ~ ${range.end}`}</div>
        </div>

        <div className="field">
          <label>模板</label>
          <select value={tplFile} onChange={(e) => onPickTemplate(e.target.value)}>
            {usable.map((t) => (
              <option key={t.filename} value={t.filename}>
                {t.kind === "docx" ? `${t.name}（Word）` : t.name}
              </option>
            ))}
            {broken.map((t) => (
              <option key={t.filename} value={t.filename} disabled>
                {t.filename}（格式错误）
              </option>
            ))}
            <option value={IMPORT_VALUE}>导入模板（.md / .docx）…</option>
          </select>
          <input
            ref={fileRef}
            type="file"
            accept=".md,.markdown,.txt,.docx"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImportFile(f);
              e.target.value = "";
            }}
          />
          <button className="btn-ghost slim" onClick={() => void backend.openDir("templates").catch((e) => toast(`${e instanceof Error ? e.message : e}`))}>
            打开模板文件夹
          </button>
        </div>

        <div className="field">
          <label>生成方式</label>
          <div className="seg">
            <button className={genMode === "direct" ? "on" : ""} onClick={() => setGenMode("direct")}>
              直接整理
            </button>
            <button
              className={genMode === "ai" ? "on" : ""}
              disabled={!aiReady}
              title={aiReady ? "由所配置的模型生成提炼后的总结" : "需先在设置中配置 AI 服务（Base URL + 模型名）"}
              onClick={() => setGenMode("ai")}
            >
              AI 总结
            </button>
          </div>
          <div className="note">
            {genMode === "direct"
              ? "直接整理：离线把记录按模板占位符填充，原文呈现。"
              : "AI 总结：模型基于记录原文撰写 {{summary}} 部分，其余占位符仍精确填充。"}
          </div>
        </div>

        <button className="btn-primary" disabled={busy || !tplFile} onClick={() => void generate()}>
          {busy ? "生成中…" : "生成报告"}
        </button>

        <div className="field">
          <label>导出位置</label>
          <div className="export-path" title={exportDir}>{exportDir || "（默认）"}</div>
          <div className="row2">
            <button className="btn-ghost slim" onClick={() => void copyExportDir()}>复制路径</button>
            <button className="btn-ghost slim" onClick={() => void configExportDir()}>设置位置…</button>
          </div>
        </div>

        {aiError && (
          <div className="ai-error">
            <div>AI 总结失败：{aiError}</div>
            <button className="btn-ghost slim" onClick={() => void generate("direct")}>
              改用直接整理
            </button>
          </div>
        )}
      </aside>

      <div className="report-main">
        <div className="preview-tabs">
          <button className={`ptab${tab === "render" ? " on" : ""}`} onClick={() => setTab("render")}>预览</button>
          <button className={`ptab${tab === "src" ? " on" : ""}`} onClick={() => setTab("src")}>Markdown 源（可编辑）</button>
        </div>
        <div className="preview-body">
          {md === "" ? (
            <div className="empty">选择左侧条件后点击「生成报告」</div>
          ) : tab === "render" ? (
            <div className="md-render" dangerouslySetInnerHTML={{ __html: marked.parse(md) as string }} />
          ) : (
            <textarea className="md-src" value={md} onChange={(e) => setMd(e.target.value)} />
          )}
        </div>
        <div className="report-actions">
          <button className="btn-ghost" onClick={() => void doCopy("md")}>复制 Markdown</button>
          <button className="btn-ghost" onClick={() => void doCopy("plain")}>复制纯文本</button>
          {docxBytes && (
            <button className="btn-ghost" onClick={() => void doExportDocx()}>导出 .docx</button>
          )}
          <button className="btn-ghost" onClick={() => void doExport("md")}>导出 .md</button>
          <button className="btn-ghost" onClick={() => void doExport("html")}>导出 .html</button>
          <button className="btn-ghost" onClick={doPrint}>打印 / PDF</button>
        </div>
      </div>
    </div>
  );
}
