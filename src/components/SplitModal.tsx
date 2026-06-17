import { useState } from "react";
import type { SplitItem } from "../ai";
import { todayStr } from "../parse";

interface Props {
  source: string;
  initial: SplitItem[];
  onCancel: () => void;
  onConfirm: (rows: SplitItem[]) => void;
}

/** 高度自适应内容的 textarea（无拖拽手柄） */
function fit(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/** AI 拆分确认弹窗：左原文只读，右结果可调（改日期/编辑/删除/新增）；未识别仅黄色高亮 */
export default function SplitModal({ source, initial, onCancel, onConfirm }: Props) {
  const [rows, setRows] = useState<SplitItem[]>(initial);

  function patch(i: number, p: Partial<SplitItem>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  }

  const valid = rows.filter((r) => r.content.trim() !== "");

  return (
    <div className="modal-mask show">
      <div className="modal wide">
        <h2>AI 拆分确认</h2>
        <div className="split-cols">
          <div className="split-src">
            <h4>原文（只读）</h4>
            <textarea readOnly value={source} />
          </div>
          <div className="split-right">
            <h4>拆分结果（可改日期 / 编辑 / 删除）</h4>
            <div className="split-items">
              {rows.length === 0 && <div className="empty">没有可导入的条目</div>}
              {rows.map((r, i) => (
                <div key={i} className={`sp-item${r.unknown ? " warn" : ""}`}>
                  <input
                    type="date"
                    value={r.date}
                    max={todayStr()}
                    onChange={(e) => patch(i, { date: e.target.value || todayStr(), unknown: false })}
                  />
                  <textarea
                    rows={1}
                    ref={fit}
                    value={r.content}
                    onChange={(e) => {
                      patch(i, { content: e.target.value });
                      fit(e.target);
                    }}
                  />
                  <button
                    className="rm"
                    title="删除"
                    onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button
              className="btn-ghost slim"
              onClick={() => setRows((rs) => [...rs, { date: todayStr(), content: "", unknown: false }])}
            >
              ＋ 新增条目
            </button>
          </div>
        </div>
        <div className="split-foot">
          <span className="hint">⚠ 黄色条目 = 未识别日期，已默认归到今天，请确认</span>
          <div className="split-foot-btns">
            <button className="btn-ghost" onClick={onCancel}>取消</button>
            <button className="btn-primary" disabled={valid.length === 0} onClick={() => onConfirm(valid)}>
              确认导入 {valid.length} 条
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
