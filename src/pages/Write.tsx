import { useCallback, useEffect, useState } from "react";
import type { Entry } from "../types";
import { backend } from "../backend";
import { todayStr } from "../parse";
import { toast } from "../toast";
import { aiConfigured, loadSettings } from "../settings";
import { aiSplit, type SplitItem } from "../ai";
import EntryItem from "../components/EntryItem";
import AcTextarea from "../components/AcTextarea";
import SplitModal from "../components/SplitModal";

const MAX_LEN = 10000;

interface Props {
  /** 当前是否为可见页：常驻挂载下，变为可见时刷新数据 */
  active: boolean;
}

export default function Write({ active }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [entryDate, setEntryDate] = useState(todayStr());
  const [text, setText] = useState("");
  const [aiReady, setAiReady] = useState(false);
  const [splitBusy, setSplitBusy] = useState(false);
  const [splitRows, setSplitRows] = useState<SplitItem[] | null>(null);

  const reload = useCallback(async () => {
    const today = todayStr();
    setEntries(await backend.listRange(today, today));
  }, []);

  const refreshAiReady = useCallback(() => {
    void loadSettings().then((s) => setAiReady(aiConfigured(s)));
  }, []);

  // 变为可见时刷新（其他页面可能补记了今天，或跨天后"今天"已变化）
  useEffect(() => {
    if (active) void reload();
  }, [active, reload]);

  useEffect(() => {
    refreshAiReady();
    window.addEventListener("settings-changed", refreshAiReady);
    return () => window.removeEventListener("settings-changed", refreshAiReady);
  }, [refreshAiReady]);

  async function save() {
    const v = text.trim();
    if (!v) return;
    if (v.length > MAX_LEN) {
      toast(`超出长度上限（${MAX_LEN} 字符）`);
      return;
    }
    try {
      await backend.add(v, entryDate);
    } catch (e) {
      toast(`保存失败：${e instanceof Error ? e.message : e}`);
      return;
    }
    setText("");
    toast(entryDate === todayStr() ? "已保存" : `已补记到 ${entryDate}`);
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

  const isToday = entryDate === todayStr();

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
            max={todayStr()}
            title={isToday ? "记录到今天；可改为过去日期补记" : "正在补记到过去日期"}
            onChange={(e) => setEntryDate(e.target.value || todayStr())}
          />
          <button className="btn-primary" onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>

      <div className="day-head">
        <h3>今天</h3>
        <span className="hint">{entries.length} 条</span>
      </div>
      {entries.length === 0 ? (
        <div className="empty">今天还没有记录</div>
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
