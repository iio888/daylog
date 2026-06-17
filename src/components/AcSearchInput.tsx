import { forwardRef, useRef, useState } from "react";
import { backend } from "../backend";
import { TOKEN_TAIL_RE } from "../parse";

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
}

/**
 * 单行搜索框，键入 `#` 或 `@` 时弹出已有标签/项目候选（前缀匹配，按频次）。
 * 不再用下拉框罗列全部标签/项目——搜索时直接补全即可。
 */
const AcSearchInput = forwardRef<HTMLInputElement, Props>(function AcSearchInput(
  { value, onChange, placeholder, style },
  ref,
) {
  const innerRef = useRef<HTMLInputElement | null>(null);
  const [items, setItems] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const rangeRef = useRef<{ start: number; end: number } | null>(null);

  function setRef(el: HTMLInputElement | null) {
    innerRef.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  }

  async function refresh() {
    const el = innerRef.current;
    if (!el) return;
    const head = el.value.slice(0, el.selectionStart ?? el.value.length);
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
    rangeRef.current = { start: head.length - m[0].length, end: head.length };
    setSel(0);
    setItems(cands);
  }

  function pick(i: number) {
    const r = rangeRef.current;
    const el = innerRef.current;
    if (!r || !el || !items[i]) return;
    const next = value.slice(0, r.start) + items[i] + " " + value.slice(r.end);
    onChange(next);
    setItems([]);
    const pos = r.start + items[i].length + 1;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="ac-wrap" style={{ display: "inline-block", ...style }}>
      <input
        ref={setRef}
        value={value}
        placeholder={placeholder}
        style={{ width: "100%" }}
        onChange={(e) => {
          onChange(e.target.value);
          void refresh();
        }}
        onBlur={() => setTimeout(() => setItems([]), 150)}
        onKeyDown={(e) => {
          if (items.length > 0) {
            if (e.key === "ArrowDown") { setSel((s) => (s + 1) % items.length); e.preventDefault(); return; }
            if (e.key === "ArrowUp") { setSel((s) => (s - 1 + items.length) % items.length); e.preventDefault(); return; }
            if (e.key === "Enter") { pick(sel); e.preventDefault(); return; }
            if (e.key === "Escape") { setItems([]); e.stopPropagation(); return; }
          }
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
});

export default AcSearchInput;
