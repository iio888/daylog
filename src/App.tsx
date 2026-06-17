import { useEffect, useState } from "react";
import type { Page } from "./types";
import { isMock } from "./backend";
import { applyTheme, loadSettings } from "./settings";
import Write from "./pages/Write";
import Review from "./pages/Review";
import Report from "./pages/Report";
import SettingsModal from "./components/SettingsModal";

const PAGES: { id: Page; label: string }[] = [
  { id: "write", label: "记录" },
  { id: "review", label: "回顾" },
  { id: "report", label: "报告" },
];

export default function App() {
  const [page, setPage] = useState<Page>("write");
  const [focusSearchSignal, setFocusSearchSignal] = useState(0);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 全局快捷键：Ctrl+1/2/3 切页，Ctrl+Tab / Ctrl+Shift+Tab 循环切页，Ctrl+F 跳搜索
  useEffect(() => {
    const order: Page[] = PAGES.map((p) => p.id);
    function onKey(e: KeyboardEvent) {
      if (!e.ctrlKey) return;
      if (e.key === "Tab") {
        // 在三页之间循环（Shift 反向）；不劫持普通 Tab，故不影响表单内焦点移动
        setPage((p) => {
          const i = order.indexOf(p);
          const n = (i + (e.shiftKey ? -1 : 1) + order.length) % order.length;
          return order[n];
        });
        e.preventDefault();
      } else if (e.key === "1") { setPage("write"); e.preventDefault(); }
      else if (e.key === "2") { setPage("review"); e.preventDefault(); }
      else if (e.key === "3") { setPage("report"); e.preventDefault(); }
      else if (e.key === "f") {
        setPage("review");
        setFocusSearchSignal((n) => n + 1);
        e.preventDefault();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 主题：启动时应用，设置保存后（settings-changed）重新应用
  useEffect(() => {
    const refresh = () => void loadSettings().then((s) => applyTheme(s.theme));
    refresh();
    window.addEventListener("settings-changed", refresh);
    return () => window.removeEventListener("settings-changed", refresh);
  }, []);

  // 全局 toast
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function onToast(e: Event) {
      setToastMsg((e as CustomEvent<string>).detail);
      clearTimeout(timer);
      timer = setTimeout(() => setToastMsg(null), 1600);
    }
    window.addEventListener("app-toast", onToast);
    return () => {
      window.removeEventListener("app-toast", onToast);
      clearTimeout(timer);
    };
  }, []);

  return (
    <>
      <nav>
        <div className="logo">
          Day<b>Log</b>
        </div>
        {PAGES.map((p) => (
          <button
            key={p.id}
            className={`nav-tab${page === p.id ? " active" : ""}`}
            onClick={() => setPage(p.id)}
          >
            {p.label}
          </button>
        ))}
        <div className="nav-right">
          {isMock && <span className="mock-badge">预览模式 · 数据存于浏览器</span>}
          <button className="icon-btn" title="设置" onClick={() => setSettingsOpen(true)}>
            ⚙
          </button>
        </div>
      </nav>
      {/* 三页常驻挂载，hidden 切换显示：页内状态（草稿、月份、搜索词…）天然保留 */}
      <main>
        <div className="page" hidden={page !== "write"}>
          <Write active={page === "write"} />
        </div>
        <div className="page" hidden={page !== "review"}>
          <Review active={page === "review"} focusSearchSignal={focusSearchSignal} />
        </div>
        <div className="page" hidden={page !== "report"}>
          <Report active={page === "report"} />
        </div>
      </main>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </>
  );
}
