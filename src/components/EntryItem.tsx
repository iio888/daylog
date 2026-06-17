import { useEffect, useRef, useState } from "react";
import type { Entry } from "../types";
import { backend } from "../backend";
import { timeOf } from "../parse";
import { toast } from "../toast";

interface Props {
  entry: Entry;
  /** 任何修改/删除完成后通知父组件刷新 */
  onChanged: () => void;
}

/** 单条记录：原文显示（不格式化），悬停出现编辑/删除，删除为行内二次确认 */
export default function EntryItem({ entry, onChanged }: Props) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  async function saveEdit() {
    const v = taRef.current?.value.trim();
    if (!v) return;
    try {
      await backend.update(entry.id, v);
    } catch (e) {
      toast(`更新失败：${e instanceof Error ? e.message : e}`);
      return;
    }
    setEditing(false);
    toast("已更新");
    onChanged();
  }

  async function doDelete() {
    try {
      await backend.remove(entry.id);
    } catch (e) {
      toast(`删除失败：${e instanceof Error ? e.message : e}`);
      return;
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
            <button className="op" onClick={() => void saveEdit()}>保存</button>
            <button className="op" onClick={() => setEditing(false)}>取消</button>
          </>
        ) : (
          <>
            <button className="op" onClick={() => setEditing(true)}>编辑</button>
            {confirming ? (
              <button className="op del" onClick={() => void doDelete()} onMouseLeave={() => setConfirming(false)}>
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
