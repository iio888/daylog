import { useCallback, useEffect, useState } from "react";
import type { Entry } from "../types";
import { backend } from "../backend";
import { MAX_ENTRY_LEN } from "../parse";
import { useFollowToday, useToday } from "../useToday";
import { toast } from "../toast";
import { aiConfigured, loadSettings } from "../settings";
import { aiSplit, type SplitItem } from "../ai";
import EntryItem from "../components/EntryItem";
import AcTextarea from "../components/AcTextarea";
import SplitModal from "../components/SplitModal";

interface Props {
  /** 当前是否为可见页：常驻挂载下，变为可见时刷新数据 */
  active: boolean;
}

export default function Write({ active }: Props) {
  const today = useToday();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [entryDate, setEntryDate] = useState(today);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [aiReady, setAiReady] = useState(false);
  const [splitBusy, setSplitBusy] = useState(false);
  const [splitRows, setSplitRows] = useState<SplitItem[] | null>(null);

  // 跨零点后日期选择器跟到新的一天；已手动改成补记的日期不动
  useFollowToday(today, setEntryDate);

  // 下方列表跟着日期选择器走：切到补记日期就看那天的事项
  const reload = useCallback(async () => {
    setEntries(await backend.listRange(entryDate, entryDate));
  }, [entryDate]);

  const refreshAiReady = useCallback(() => {
    void loadSettings().then((s) => setAiReady(aiConfigured(s)));
  }, []);

  // 变为可见时刷新（其他页面可能改了这天）；切日期/跨天后 reload 变化也会重新拉取
  useEffect(() => {
    if (active) void reload();
  }, [active, reload]);

  useEffect(() => {
    refreshAiReady();
    window.addEventListener("settings-changed", refreshAiReady);
    return () => window.removeEventListener("settings-changed", refreshAiReady);
  }, [refreshAiReady]);

  async function save() {
    if (saving) return; // 连点两下保存 / 连按两次 Ctrl+Enter 会存成两条
    const v = text.trim();
    if (!v) return;
    if (v.length > MAX_ENTRY_LEN) {
      toast(`超出长度上限（${MAX_ENTRY_LEN} 字符）`);
      return;
    }
    setSaving(true);
    try {
      await backend.add(v, entryDate);
    } catch (e) {
      toast(`保存失败：${e instanceof Error ? e.message : e}`);
      return;
    } finally {
      setSaving(false);
    }
    setText("");
    toast(entryDate === today ? "已保存" : `已补记到 ${entryDate}`);
    void reload();
  }

  async function startSplit() {
    const v = text.trim();
    if (!v) {
      toast("请先在输入框粘贴/输入多日内容");
      return;
    }
    setSplitBusy(true);
    try {
      setSplitRows(await aiSplit(v));
    } catch (e) {
      toast(`拆分失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setSplitBusy(false);
    }
  }

  async function confirmSplit(rows: SplitItem[]) {
    // 先整体校验再入库：部分导入比直接拦下更难收拾，截断则等于丢数据
    const bad = rows.findIndex((r) => r.content.trim().length > MAX_ENTRY_LEN);
    if (bad >= 0) {
      toast(`第 ${bad + 1} 条超出长度上限（${MAX_ENTRY_LEN} 字符），请缩短后再导入`);
      return;
    }
    try {
      for (const r of rows) await backend.add(r.content.trim(), r.date);
    } catch (e) {
      toast(`导入失败：${e instanceof Error ? e.message : e}`);
      return;
    }
    setSplitRows(null);
    setText("");
    toast(`已导入 ${rows.length} 条到 ${new Set(rows.map((r) => r.date)).size} 天`);
    void reload();
  }

  const isToday = entryDate === today;

  return (
    <div className="write-wrap">
      <div className="editor">
        <AcTextarea
          value={text}
          onChange={setText}
          onCtrlEnter={() => void save()}
          placeholder="这会儿做了什么？随便写…"
        />
        <div className="editor-bar">
          <span className="hint">Ctrl+Enter 保存 · 键入 # 或 @ 自动补全</span>
          <div className="spacer" />
          <button
            className="btn-ghost"
            disabled={!aiReady || splitBusy}
            title={
              aiReady
                ? "一次性输入多天内容，由 AI 按日期拆分后确认导入"
                : "需先在设置中配置 AI 服务（Base URL + 模型名）"
            }
            onClick={() => void startSplit()}
          >
            {splitBusy ? "拆分中…" : "AI 拆分多日…"}
          </button>
          <input
            type="date"
            className="date-pick"
            value={entryDate}
            max={today}
            title={isToday ? "记录到今天；可改为过去日期补记" : "正在补记到过去日期"}
            onChange={(e) => setEntryDate(e.target.value || today)}
          />
          <button className="btn-primary" disabled={saving} onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>

      <div className="day-head">
        <h3>{isToday ? "今天" : entryDate}</h3>
        <span className="hint">{entries.length} 条</span>
      </div>
      {entries.length === 0 ? (
        <div className="empty">{isToday ? "今天还没有记录" : "这天还没有记录"}</div>
      ) : (
        [...entries]
          .reverse()
          .map((e) => <EntryItem key={e.id} entry={e} onChanged={() => void reload()} />)
      )}

      {splitRows && (
        <SplitModal
          source={text}
          initial={splitRows}
          onCancel={() => setSplitRows(null)}
          onConfirm={(rows) => void confirmSplit(rows)}
        />
      )}
    </div>
  );
}
