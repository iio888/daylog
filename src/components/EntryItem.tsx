import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Entry } from "../types";
import { backend } from "../backend";
import { MAX_ENTRY_LEN, timeOf } from "../parse";
import { toast } from "../toast";

interface Props {
  entry: Entry;
  /** 任何修改/删除完成后通知父组件刷新 */
  onChanged: () => void;
  /** 额外的操作按钮，排在编辑/删除之前（回顾页搜索结果用它放"在日历中定位"） */
  extraOps?: ReactNode;
}

/** 单条记录：原文显示（不格式化），悬停出现编辑/删除，删除为行内二次确认 */
export default function EntryItem({ entry, onChanged, extraOps }: Props) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false); // 请求在途时锁住按钮，避免连点写两次
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  async function saveEdit() {
    if (busy) return;
    const v = taRef.current?.value.trim();
    if (!v) return;
    if (v.length > MAX_ENTRY_LEN) {
      toast(`超出长度上限（${MAX_ENTRY_LEN} 字符）`);
      return; // 保持编辑态，让用户就地改短
    }
    setBusy(true);
    try {
      await backend.update(entry.id, v);
    } catch (e) {
      toast(`更新失败：${e instanceof Error ? e.message : e}`);
      return;
    } finally {
      setBusy(false);
    }
    setEditing(false);
    toast("已更新");
    onChanged();
  }

  async function doDelete() {
    if (busy) return;
    setBusy(true);
    try {
      await backend.remove(entry.id);
    } catch (e) {
      toast(`删除失败：${e instanceof Error ? e.message : e}`);
      return;
    } finally {
      setBusy(false);
    }
    toast("已删除");
    onChanged();
  }

  return (
    <div className="entry">
      <time>{timeOf(entry.created_at)}</time>
      {editing ? (
        <textarea
          ref={taRef}
          className="inline"
          defaultValue={entry.content}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === "Enter") void saveEdit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <div className="txt">{entry.content}</div>
      )}
      <div className="ops">
        {editing ? (
          <>
            <button className="op" disabled={busy} onClick={() => void saveEdit()}>保存</button>
            <button className="op" onClick={() => setEditing(false)}>取消</button>
          </>
        ) : (
          <>
            {extraOps}
            <button className="op" onClick={() => setEditing(true)}>编辑</button>
            {confirming ? (
              <button className="op del" disabled={busy} onClick={() => void doDelete()} onMouseLeave={() => setConfirming(false)}>
                确认删除？
              </button>
            ) : (
              <button className="op del" onClick={() => setConfirming(true)}>删除</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
