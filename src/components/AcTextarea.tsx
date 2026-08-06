import { useRef } from "react";
import { AcList, useAutocomplete } from "../useAutocomplete";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onCtrlEnter?: () => void;
  placeholder?: string;
}

/** 带 #标签 / @项目 自动补全的输入框（候选 = 全库去重按频次排序，前缀匹配） */
export default function AcTextarea({ value, onChange, onCtrlEnter, placeholder }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const ac = useAutocomplete(value, onChange, taRef);

  return (
    <div className="ac-wrap">
      <textarea
        ref={taRef}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          void ac.refresh();
        }}
        onBlur={() => setTimeout(ac.close, 150)}
        onKeyDown={(e) => {
          if (ac.handleKeyDown(e)) return;
          if (e.ctrlKey && e.key === "Enter") onCtrlEnter?.();
        }}
      />
      <AcList items={ac.items} sel={ac.sel} onPick={ac.pick} />
    </div>
  );
}
