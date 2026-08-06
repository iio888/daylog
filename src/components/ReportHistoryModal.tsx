import { useCallback, useEffect, useState } from "react";
import { type ReportRecord, backend } from "../backend";
import { REPORT_TYPE_LABEL } from "../templates";
import { toast } from "../toast";

interface Props {
  onClose: () => void;
  /** 把某份历史报告载入报告页预览区，之后复用页面上现成的复制/导出/打印按钮 */
  onLoad: (record: ReportRecord) => void;
}

/** "2026-06-14T18:22:07+08:00" → "06-14 18:22" */
function stamp(iso: string): string {
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

function rangeOf(r: ReportRecord): string {
  return r.range_start === r.range_end ? r.range_start : `${r.range_start} ~ ${r.range_end}`;
}

/** 生成历史：reports 表一直在写、最多留 50 份，这里是它唯一的读取入口 */
export default function ReportHistoryModal({ onClose, onLoad }: Props) {
  const [list, setList] = useState<ReportRecord[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setList(await backend.listReports());
    } catch (e) {
      toast(`读取历史失败：${e instanceof Error ? e.message : e}`);
      setList([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function remove(id: string) {
    try {
      await backend.deleteReport(id);
    } catch (e) {
      toast(`删除失败：${e instanceof Error ? e.message : e}`);
      return;
    }
    setConfirming(null);
    void reload();
  }

  return (
    <div className="modal-mask show">
      <div className="modal">
        <h2>历史报告</h2>
        <div className="rh-list">
          {list === null ? null : list.length === 0 ? (
            <div className="empty">还没有生成过报告</div>
          ) : (
            list.map((r) => (
              <div key={r.id} className="rh-item">
                <button className="rh-main" title="载入到预览区" onClick={() => onLoad(r)}>
                  <span className="rh-title">
                    {REPORT_TYPE_LABEL[r.type as keyof typeof REPORT_TYPE_LABEL] ?? r.type} ·{" "}
                    {rangeOf(r)}
                  </span>
                  <span className="hint">
                    {r.template} · {stamp(r.created_at)}
                  </span>
                </button>
                {confirming === r.id ? (
                  <button
                    className="op del"
                    onClick={() => void remove(r.id)}
                    onMouseLeave={() => setConfirming(null)}
                  >
                    确认删除？
                  </button>
                ) : (
                  <button className="op del" onClick={() => setConfirming(r.id)}>
                    删除
                  </button>
                )}
              </div>
            ))
          )}
        </div>
        <div className="row hint">最多保留最近 50 份；Word 模板生成的历史只存文字，重新导出 .docx 需再生成一次。</div>
        <div className="row end footer-actions">
          <button className="btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
