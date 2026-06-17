/** 极简全局 toast：任何模块调用 toast()，App 内的 <Toaster/> 负责展示 */
export function toast(msg: string) {
  window.dispatchEvent(new CustomEvent("app-toast", { detail: msg }));
}
