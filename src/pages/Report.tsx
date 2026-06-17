import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import { backend } from "../backend";
import { timeOf, todayStr } from "../parse";
import { toast } from "../toast";
import { aiConfigured, loadSettings } from "../settings";
import { aiSummarize } from "../ai";
import { copyText } from "../copy";
import {
  BUILTIN_TEMPLATES,
  REPORT_TYPE_LABEL,
  parseTemplate,
  type ReportType,
  type Template,
} from "../templates";
import { computeRange, exportBaseName, fillTemplate, mdToPlain, wrapHtml } from "../report";

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
    const raw = await backend.listTemplates();
    setTemplates(raw.map(([f, c]) => parseTemplate(f, c)));
  }, []);

  // 进入报告页时重新扫描模板目录（支持用户在文件管理器中直接增删改）
  useEffect(() => {
    if (!active) return;
    void reloadTemplates().catch((e) => toast(`模板加载失败：${e}`));
    void backend.listYears().then(setYears);
  }, [active, reloadTemplates]);

  // 当前类型可用的模板（type 匹配或 any），默认选中第一个匹配项
  const usable = useMemo(
    () => templates.filter((t) => !t.error && (t.type === type || t.type === "any")),
    [templates, type],
  );
  const broken = useMemo(() => templates.filter((t) => t.error), [templates]);

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
    setBusy(true);
    setAiError(null);
    try {
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

  function exportName(ext: string): string {
    return `${exportBaseName(type, range)}.${ext}`;
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
    const content =
      kind === "md" ? md : wrapHtml(exportName("html"), marked.parse(md) as string);
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
    const content = await file.text();
    const filename = file.name.endsWith(".md") ? file.name : `${file.name}.md`;
    try {
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
              <option key={t.filename} value={t.filename}>{t.name}</option>
            ))}
            {broken.map((t) => (
              <option key={t.filename} value={t.filename} disabled>
                {t.filename}（格式错误）
              </option>
            ))}
            <option value={IMPORT_VALUE}>导入模板…</option>
          </select>
          <input
            ref={fileRef}
            type="file"
            accept=".md,.markdown,.txt"
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
          <button className="btn-ghost" onClick={() => void doExport("md")}>导出 .md</button>
          <button className="btn-ghost" onClick={() => void doExport("html")}>导出 .html</button>
          <button className="btn-ghost" onClick={doPrint}>打印 / PDF</button>
        </div>
      </div>
    </div>
  );
}
