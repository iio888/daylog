import { useEffect, useRef, useState } from "react";
import { todayStr } from "./parse";

/**
 * 订阅"今天"：窗口长期开着不关时，跨零点后自动返回新的日期。
 * 除了零点定时器，还监听窗口重新可见/聚焦——机器休眠会让定时器失准，
 * 唤醒后立刻校正一次比等定时器可靠。
 */
export function useToday(): string {
  const [today, setToday] = useState(todayStr);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setToday(todayStr());
      clearTimeout(timer);
      // 按当前真实时间重排到下一个零点（多给 1 秒，避免刚好卡在边界上又算成昨天）
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
      timer = setTimeout(tick, Math.max(1000, next.getTime() - now.getTime()));
    };
    tick();

    const onWake = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, []);

  return today;
}

/**
 * 跨天时回调 (新的今天, 旧的今天)。回调放在 ref 里，调用方可以直接写内联箭头
 * 函数并读取当前 state，不必操心依赖数组。
 */
export function useDayChange(today: string, onChange: (next: string, prev: string) => void): void {
  const cb = useRef(onChange);
  // 先声明的 effect 先执行，故下面那个 effect 拿到的一定是本次渲染的回调
  useEffect(() => {
    cb.current = onChange;
  });

  const prevToday = useRef(today);
  useEffect(() => {
    if (prevToday.current === today) return;
    const stale = prevToday.current;
    prevToday.current = today;
    cb.current(today, stale);
  }, [today]);
}

/**
 * 跨天时把跟随"今天"的日期选择器推到新的一天；用户手动改成过去日期（补记）
 * 的选择保持不动。
 */
export function useFollowToday(
  today: string,
  setDate: (update: (prev: string) => string) => void,
): void {
  useDayChange(today, (next, prev) => setDate((d) => (d === prev ? next : d)));
}

/** "YYYY-MM-DD" → { y, m, q } */
export function ymqOf(date: string): { y: number; m: number; q: 1 | 2 | 3 | 4 } {
  const [y, m] = date.split("-").map(Number);
  return { y, m, q: (Math.floor((m - 1) / 3) + 1) as 1 | 2 | 3 | 4 };
}
