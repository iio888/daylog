import { forwardRef, useRef } from "react";
import { AcList, useAutocomplete } from "../useAutocomplete";

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
  const ac = useAutocomplete(value, onChange, innerRef);

  function setRef(el: HTMLInputElement | null) {
    innerRef.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
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
          void ac.refresh();
        }}
        onBlur={() => setTimeout(ac.close, 150)}
        onKeyDown={(e) => void ac.handleKeyDown(e)}
      />
      <AcList items={ac.items} sel={ac.sel} onPick={ac.pick} />
    </div>
  );
});

export default AcSearchInput;
