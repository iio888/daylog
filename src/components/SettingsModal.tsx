import { useEffect, useRef, useState } from "react";
import { backend } from "../backend";
import { aiListModels } from "../ai";
import { applyTheme, loadSettings, persistSettings, type Settings, type Theme } from "../settings";
import { BUILTIN_TEMPLATES } from "../templates";
import { todayStr } from "../parse";
import { toast } from "../toast";
import type { Entry } from "../types";

interface Props {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: Props) {
  const [s, setS] = useState<Settings | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const importRef = useRef<HTMLInputElement>(null);
  const initialTheme = useRef<Theme>("light"); // 用于"取消"时撤销主题预览

  useEffect(() => {
    void loadSettings().then((v) => {
      initialTheme.current = v.theme;
      setS(v);
    });
  }, []);

  // 取消/关闭：撤销未保存的主题预览，再关闭
  function cancel() {
    applyTheme(initialTheme.current);
    onClose();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") cancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  /** 主题即时预览（保存前先看效果） */
  function pickTheme(t: Theme) {
    setS((cur) => (cur ? { ...cur, theme: t } : cur));
    applyTheme(t);
  }

  if (!s) return null;

  async function saveAndClose() {
    try {
      await persistSettings(s!);
      toast("设置已保存");
      onClose();
    } catch (e) {
      toast(`保存失败：${e instanceof Error ? e.message : e}`);
    }
  }

  /** 修改 AI 配置项；改动 Base URL / Key 会让上次测试结果失效，清空展示 */
  function setAi(patch: Partial<Settings["ai"]>, resetTest = false) {
    setS((cur) => (cur ? { ...cur, ai: { ...cur.ai, ...patch } } : cur));
    if (resetTest) {
      setTest(null);
      setModels([]);
    }
  }

  /** 测试连接：仅凭当前 Base URL + Key 探活并取回模型列表（无需先填模型名、不落盘） */
  async function testConn() {
    setTesting(true);
    setTest(null);
    try {
      const list = await aiListModels(s!.ai.baseUrl, s!.ai.apiKey);
      setModels(list);
      // 默认选中：当前模型名若不在返回列表中，自动填充第一个作为默认
      setAi({ model: list.includes(s!.ai.model) ? s!.ai.model : list[0] });
      setTest({ ok: true, msg: `连接成功 · ${list.length} 个模型` });
    } catch (e) {
      setModels([]);
      setTest({ ok: false, msg: `连接失败：${e instanceof Error ? e.message : e}` });
    } finally {
      setTesting(false);
    }
  }

  async function restoreBuiltins() {
    try {
      for (const b of BUILTIN_TEMPLATES) await backend.saveTemplate(b.filename, b.content);
      toast("内置模板已恢复");
    } catch (e) {
      toast(`恢复失败：${e instanceof Error ? e.message : e}`);
    }
  }

  async function exportAll() {
    try {
      const entries = await backend.listRange("0000-01-01", "9999-12-31");
      const path = await backend.exportFile(
        `DayLog-backup-${todayStr()}.json`,
        JSON.stringify(entries, null, 2),
      );
      toast(path ? `已导出：${path}` : "已开始下载");
    } catch (e) {
      toast(`导出失败：${e instanceof Error ? e.message : e}`);
    }
  }

  async function importJson(file: File) {
    try {
      const arr = JSON.parse(await file.text()) as Entry[];
      if (!Array.isArray(arr)) throw new Error("不是合法的备份文件");
      const n = await backend.importEntries(arr);
      toast(`导入完成：新增 ${n} 条（按 id 去重）`);
    } catch (e) {
      toast(`导入失败：${e instanceof Error ? e.message : e}`);
    }
  }

  return (
    <div
      className="modal-mask show"
      onClick={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div className="modal">
        <h2>设置</h2>

        <h4>外观</h4>
        <div className="seg">
          {([
            ["system", "跟随系统"],
            ["light", "浅色"],
            ["dark", "深色"],
          ] as [Theme, string][]).map(([t, label]) => (
            <button key={t} className={s.theme === t ? "on" : ""} onClick={() => pickTheme(t)}>
              {label}
            </button>
          ))}
        </div>

        <h4>AI 服务</h4>
        <div className="row">
          <input
            placeholder="Base URL，如 http://localhost:11434/v1"
            value={s.ai.baseUrl}
            onChange={(e) => setAi({ baseUrl: e.target.value }, true)}
          />
        </div>
        <div className="row">
          <input
            type="password"
            placeholder="API Key（本地模型可留空，仅存本机）"
            value={s.ai.apiKey}
            onChange={(e) => setAi({ apiKey: e.target.value }, true)}
          />
        </div>
        <div className="row">
          {models.length > 0 ? (
            // 测试连接成功后，模型名变为下拉框，列出端点返回的模型（已默认选中一个）
            <select value={s.ai.model} onChange={(e) => setAi({ model: e.target.value })}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input
              placeholder="模型名，如 qwen3:14b"
              value={s.ai.model}
              onChange={(e) => setAi({ model: e.target.value })}
            />
          )}
          <button className="btn-ghost" disabled={testing} onClick={() => void testConn()}>
            {testing ? "测试中…" : "测试连接"}
          </button>
          {test && <span className={`test-msg ${test.ok ? "ok" : "err"}`}>{test.msg}</span>}
        </div>
        <div className="row hint">
          OpenAI 兼容接口：本地模型（Ollama / LM Studio / vLLM）数据不出本机、完全离线可用；
          云端服务填对应 Base URL 与 Key 即可（需联网）。留空则不启用 AI 功能。
        </div>

        <h4>模板</h4>
        <div className="row">
          <button className="btn-ghost" onClick={() => void backend.openDir("templates").catch((e) => toast(String(e)))}>
            打开模板文件夹
          </button>
          <button className="btn-ghost" onClick={() => void restoreBuiltins()}>恢复内置模板</button>
        </div>

        <h4>数据</h4>
        <div className="row">
          <button className="btn-ghost" onClick={() => void backend.openDir("data").catch((e) => toast(String(e)))}>
            打开数据文件夹
          </button>
          <button className="btn-ghost" onClick={() => void exportAll()}>导出全部 JSON</button>
          <button className="btn-ghost" onClick={() => importRef.current?.click()}>导入 JSON</button>
          <input
            ref={importRef}
            type="file"
            accept=".json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importJson(f);
              e.target.value = "";
            }}
          />
        </div>

        <h4>关于</h4>
        <div className="row hint">DayLog v0.1.0 · 本地优先 · 无遥测</div>

        <div className="row end footer-actions">
          <button className="btn-ghost" onClick={cancel}>取消</button>
          <button className="btn-primary" onClick={() => void saveAndClose()}>保存</button>
        </div>
      </div>
    </div>
  );
}
