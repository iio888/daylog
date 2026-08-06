import { type KeyboardEvent, type RefObject, useRef, useState } from "react";
import { backend } from "./backend";
import { TOKEN_TAIL_RE } from "./parse";

/** 候选条数上限：够挑就行，多了反而挡住正在写的内容 */
const MAX_CANDIDATES = 8;

/**
 * `#标签` / `@项目` 的自动补全：候选来自全库去重列表，按频次排序、前缀匹配。
 *
 * 记录框（textarea）与搜索框（input）用的是同一套逻辑，差别只在宿主元素，
 * 所以行为放在这里，两个组件只保留各自的元素绑定。
 */
export function useAutocomplete(
  value: string,
  onChange: (v: string) => void,
  elRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>,
) {
  const [items, setItems] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const rangeRef = useRef<{ start: number; end: number } | null>(null);

  /** 输入变化后重算候选（光标前的那段 #/@ 词缀为准） */
  async function refresh() {
    const el = elRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const head = el.value.slice(0, caret);
    const m = head.match(TOKEN_TAIL_RE);
    if (!m) {
      setItems([]);
      return;
    }
    const list = m[1] === "#" ? await backend.listTags() : await backend.listProjects();
    const needle = m[0].toLowerCase();
    rangeRef.current = { start: head.length - m[0].length, end: caret };
    setSel(0);
    setItems(
      list
        .map(([t]) => m[1] + t)
        .filter((t) => t.toLowerCase().startsWith(needle) && t !== m[0])
        .slice(0, MAX_CANDIDATES),
    );
  }

  function pick(i: number) {
    const r = rangeRef.current;
    const el = elRef.current;
    if (!r || !el || !items[i]) return;
    onChange(value.slice(0, r.start) + items[i] + " " + value.slice(r.end));
    setItems([]);
    const pos = r.start + items[i].length + 1;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  const close = () => setItems([]);

  /** 候选打开时消费方向键 / 回车 / Esc；返回 true 表示这次按键已经处理完 */
  function handleKeyDown(e: KeyboardEvent): boolean {
    if (items.length === 0) return false;
    if (e.key === "ArrowDown") {
      setSel((s) => (s + 1) % items.length);
      e.preventDefault();
      return true;
    }
    if (e.key === "ArrowUp") {
      setSel((s) => (s - 1 + items.length) % items.length);
      e.preventDefault();
      return true;
    }
    if (e.key === "Enter" && !e.ctrlKey) {
      pick(sel);
      e.preventDefault();
      return true;
    }
    if (e.key === "Escape") {
      close();
      e.stopPropagation(); // 别让 Esc 冒到页面上去关面板
      return true;
    }
    return false;
  }

  return { items, sel, refresh, pick, close, handleKeyDown };
}

/** 候选下拉。mousedown 而非 click：click 之前 blur 已经把列表关掉了 */
export function AcList({
  items,
  sel,
  onPick,
}: {
  items: string[];
  sel: number;
  onPick: (i: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="ac">
      {items.map((t, i) => (
        <div
          key={t}
          className={i === sel ? "sel" : ""}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(i);
          }}
        >
          {t}
        </div>
      ))}
    </div>
  );
}
