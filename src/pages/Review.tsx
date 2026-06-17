import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Entry } from "../types";
import { backend } from "../backend";
import { PROJ_RE, TAG_RE, pad2, parseProject, parseTags, timeOf, todayStr } from "../parse";
import { toast } from "../toast";
import EntryItem from "../components/EntryItem";
import AcTextarea from "../components/AcTextarea";
import AcSearchInput from "../components/AcSearchInput";

const DOW = ["一", "二", "三", "四", "五", "六", "日"];

interface Props {
  /** 当前是否为可见页：常驻挂载下，键盘快捷键仅在可见时生效，变为可见时刷新数据 */
  active: boolean;
  /** 递增信号：App 收到 Ctrl+F 时 +1，用于聚焦搜索框 */
  focusSearchSignal: number;
}

export default function Review({ active, focusSearchSignal }: Props) {
  const now = new Date();
  // 年月合并为单个 state：键盘监听只注册一次，必须用函数式更新避免闭包捕获旧值
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() + 1 });
  const { y: year, m: month } = ym;
  const [entries, setEntries] = useState<Entry[]>([]); // 当月数据
  const [years, setYears] = useState<number[]>([]);

  const [q, setQ] = useState("");
  const [flatResult, setFlatResult] = useState<Entry[] | null>(null);

  const [panelDate, setPanelDate] = useState<string | null>(null);
  const [addText, setAddText] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // 搜索框里混写自由文本与 #标签 / @项目，在此拆出三类过滤条件
  const { qText, qTag, qProject } = useMemo(() => {
    const tag = parseTags(q)[0] ?? "";
    const project = parseProject(q) ?? "";
    const text = q
      .replace(TAG_RE, " ")
      .replace(new RegExp(PROJ_RE.source, "g"), " ")
      .replace(/\s+/g, " ")
      .trim();
    return { qText: text, qTag: tag, qProject: project };
  }, [q]);

  const filtering = qText !== "" || qTag !== "" || qProject !== "";

  const reloadMonth = useCallback(async () => {
    const last = new Date(year, month, 0).getDate();
    setEntries(
      await backend.listRange(
        `${year}-${pad2(month)}-01`,
        `${year}-${pad2(month)}-${pad2(last)}`,
      ),
    );
  }, [year, month]);

  const reloadMeta = useCallback(async () => {
    setYears(await backend.listYears());
  }, []);

  // 变为可见时刷新（覆盖其他页面新增/修改数据的情况）；可见期间切换月份也经此刷新
  useEffect(() => {
    if (!active) return;
    void reloadMonth();
    void reloadMeta();
  }, [active, reloadMonth, reloadMeta]);

  // 搜索/过滤 → 扁平结果列表
  useEffect(() => {
    if (!filtering) {
      setFlatResult(null);
      return;
    }
    let cancelled = false;
    void backend
      .query(qText || undefined, qTag || undefined, qProject || undefined)
      .then((r) => {
        if (!cancelled) setFlatResult(r);
      });
    return () => {
      cancelled = true;
    };
  }, [qText, qTag, qProject, filtering]);

  // Ctrl+F 聚焦搜索框
  useEffect(() => {
    if (focusSearchSignal > 0) searchRef.current?.focus();
  }, [focusSearchSignal]);

  // ←/→ 翻月，PageUp/PageDown 翻年。常驻挂载：仅当前页可见时注册监听
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t.matches("input, textarea, select")) return;
      if (e.key === "ArrowLeft") shiftMonth(-1);
      else if (e.key === "ArrowRight") shiftMonth(1);
      else if (e.key === "PageUp") { setYm((s) => ({ ...s, y: s.y - 1 })); e.preventDefault(); }
      else if (e.key === "PageDown") { setYm((s) => ({ ...s, y: s.y + 1 })); e.preventDefault(); }
      else if (e.key === "Escape") setPanelDate(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  function shiftMonth(n: number) {
    setYm((s) => {
      const total = s.y * 12 + (s.m - 1) + n;
      return { y: Math.floor(total / 12), m: (total % 12) + 1 };
    });
  }

  const byDate = useMemo(() => {
    const map = new Map<string, Entry[]>();
    entries.forEach((e) => {
      (map.get(e.entry_date) ?? map.set(e.entry_date, []).get(e.entry_date)!).push(e);
    });
    return map;
  }, [entries]);

  // 月历格子（周一为第一天）
  const cells = useMemo(() => {
    const first = new Date(year, month - 1, 1);
    const offset = (first.getDay() + 6) % 7;
    const days = new Date(year, month, 0).getDate();
    const total = Math.ceil((offset + days) / 7) * 7;
    return Array.from({ length: total }, (_, i) => {
      const dnum = i - offset + 1;
      if (dnum < 1 || dnum > days) {
        const d = new Date(year, month - 1, dnum);
        return { key: `dim-${i}`, label: d.getDate(), date: null };
      }
      return { key: `${year}-${pad2(month)}-${pad2(dnum)}`, label: dnum, date: `${year}-${pad2(month)}-${pad2(dnum)}` };
    });
  }, [year, month]);

  const today = todayStr();
  const yearOptions = useMemo(() => {
    const set = new Set(years);
    set.add(now.getFullYear());
    set.add(year);
    return [...set].sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [years, year]);

  const panelEntries = panelDate ? (byDate.get(panelDate) ?? []) : [];

  async function backfill() {
    const v = addText.trim();
    if (!v || !panelDate) return;
    try {
      await backend.add(v, panelDate);
    } catch (e) {
      toast(`保存失败：${e instanceof Error ? e.message : e}`);
      return;
    }
    setAddText("");
    toast(`已补记到 ${panelDate}`);
    void reloadMonth();
    void reloadMeta();
  }

  function jumpTo(e: Entry) {
    setQ("");
    setYm({ y: +e.entry_date.slice(0, 4), m: +e.entry_date.slice(5, 7) });
    setPanelDate(e.entry_date);
  }

  function onDataChanged() {
    void reloadMonth();
    void reloadMeta();
  }

  // 搜索/过滤结果按日期分组渲染
  const flatGroups = useMemo(() => {
    if (!flatResult) return [];
    const groups: { date: string; list: Entry[] }[] = [];
    flatResult.forEach((e) => {
      const g = groups[groups.length - 1];
      if (g && g.date === e.entry_date) g.list.push(e);
      else groups.push({ date: e.entry_date, list: [e] });
    });
    return groups;
  }, [flatResult]);

  return (
    <div className="review">
      <div className="cal-toolbar">
        <button className="btn-ghost" onClick={() => shiftMonth(-1)}>◀</button>
        <select value={year} onChange={(e) => setYm((s) => ({ ...s, y: +e.target.value }))}>
          {yearOptions.map((y) => (
            <option key={y} value={y}>{y} 年</option>
          ))}
        </select>
        <select value={month} onChange={(e) => setYm((s) => ({ ...s, m: +e.target.value }))}>
          {Array.from({ length: 12 }, (_, i) => (
            <option key={i + 1} value={i + 1}>{i + 1} 月</option>
          ))}
        </select>
        <button className="btn-ghost" onClick={() => shiftMonth(1)}>▶</button>
        <button
          className="btn-ghost"
          onClick={() => setYm({ y: now.getFullYear(), m: now.getMonth() + 1 })}
        >
          回到今天
        </button>
        <div className="grow" />
        <AcSearchInput
          ref={searchRef}
          value={q}
          onChange={setQ}
          placeholder="搜索记录…（输入 # 或 @ 补全标签 / 项目）"
          style={{ width: 280 }}
        />
      </div>

      {filtering ? (
        <div className="flat-result">
          {flatGroups.length === 0 ? (
            <div className="empty">没有匹配的记录</div>
          ) : (
            flatGroups.map((g) => (
              <div key={g.date}>
                <div className="sr-day">{g.date}</div>
                {g.list.map((e) => (
                  <div key={e.id} className="entry" onClick={() => jumpTo(e)} title="点击跳转到所在月份">
                    <time>{timeOf(e.created_at)}</time>
                    <div className="txt">{e.content}</div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="cal-grid">
          {DOW.map((d) => (
            <div key={d} className="dow">{d}</div>
          ))}
          {cells.map((c) =>
            c.date === null ? (
              <div key={c.key} className="cell dim">
                <span className="d">{c.label}</span>
              </div>
            ) : (
              <div
                key={c.key}
                className={`cell${c.date === today ? " today" : ""}`}
                onClick={() => setPanelDate(c.date)}
              >
                <span className="d">{c.label}</span>
                {(byDate.get(c.date) ?? []).slice(0, 3).map((e) => (
                  <div key={e.id} className="e">
                    <time>{timeOf(e.created_at)}</time>
                    {e.content}
                  </div>
                ))}
                {(byDate.get(c.date)?.length ?? 0) > 3 && (
                  <div className="more">+{byDate.get(c.date)!.length - 3} 条</div>
                )}
              </div>
            ),
          )}
        </div>
      )}

      {panelDate && (
        <>
          <div className="panel-mask" onClick={() => setPanelDate(null)} />
          <aside className="day-panel">
            <header>
              <h3>
                {+panelDate.slice(0, 4)} 年 {+panelDate.slice(5, 7)} 月 {+panelDate.slice(8, 10)} 日
                · {panelEntries.length} 条
              </h3>
              <button className="icon-btn" onClick={() => setPanelDate(null)}>✕</button>
            </header>
            <div className="list">
              {panelEntries.length === 0 ? (
                <div className="empty">这一天没有记录</div>
              ) : (
                panelEntries.map((e) => (
                  <EntryItem key={e.id} entry={e} onChanged={onDataChanged} />
                ))
              )}
            </div>
            <div className="addbox">
              <AcTextarea
                value={addText}
                onChange={setAddText}
                onCtrlEnter={() => void backfill()}
                placeholder="补记这一天…（Ctrl+Enter 保存）"
              />
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
