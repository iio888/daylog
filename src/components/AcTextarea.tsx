import { useRef, useState } from "react";
import { backend } from "../backend";
import { TOKEN_TAIL_RE } from "../parse";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onCtrlEnter?: () => void;
  placeholder?: string;
}

/** 带 #标签 / @项目 自动补全的输入框（候选 = 全库去重按频次排序，前缀匹配） */
export default function AcTextarea({ value, onChange, onCtrlEnter, placeholder }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [items, setItems] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const rangeRef = useRef<{ start: number; end: number } | null>(null);

  async function refresh() {
    const ta = taRef.current;
    if (!ta) return;
    const head = ta.value.slice(0, ta.selectionStart);
    const m = head.match(TOKEN_TAIL_RE);
    if (!m) {
      setItems([]);
      return;
    }
    const list = m[1] === "#" ? await backend.listTags() : await backend.listProjects();
    const needle = m[0].toLowerCase();
    const cands = list
      .map(([t]) => m[1] + t)
      .filter((t) => t.toLowerCase().startsWith(needle) && t !== m[0])
      .slice(0, 8);
    rangeRef.current = { start: head.length - m[0].length, end: ta.selectionStart };
    setSel(0);
    setItems(cands);
  }

  function pick(i: number) {
    const r = rangeRef.current;
    const ta = taRef.current;
    if (!r || !ta || !items[i]) return;
    const next = value.slice(0, r.start) + items[i] + " " + value.slice(r.end);
    onChange(next);
    setItems([]);
    const pos = r.start + items[i].length + 1;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="ac-wrap">
      <textarea
        ref={taRef}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          void refresh();
        }}
        onBlur={() => setTimeout(() => setItems([]), 150)}
        onKeyDown={(e) => {
          if (items.length > 0) {
            if (e.key === "ArrowDown") { setSel((s) => (s + 1) % items.length); e.preventDefault(); return; }
            if (e.key === "ArrowUp") { setSel((s) => (s - 1 + items.length) % items.length); e.preventDefault(); return; }
            if (e.key === "Enter" && !e.ctrlKey) { pick(sel); e.preventDefault(); return; }
            if (e.key === "Escape") { setItems([]); e.stopPropagation(); return; }
          }
          if (e.ctrlKey && e.key === "Enter") onCtrlEnter?.();
        }}
      />
      {items.length > 0 && (
        <div className="ac">
          {items.map((t, i) => (
            <div
              key={t}
              className={i === sel ? "sel" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(i);
              }}
            >
              {t}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
