import { backend } from "./backend";

/** 主题：跟随系统 / 强制浅色 / 强制深色。默认浅色。 */
export type Theme = "system" | "light" | "dark";

/** 单一 OpenAI 兼容端点：本地模型（Ollama/LM Studio/vLLM）或云端（填对应 Base URL + Key）皆可。 */
export interface Settings {
  ai: { baseUrl: string; apiKey: string; model: string };
  theme: Theme;
}

export const DEFAULT_SETTINGS: Settings = {
  ai: { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "" },
  theme: "light",
};

/** 是否已具备调用条件：Base URL 与模型名都已填写 */
export function aiConfigured(s: Settings): boolean {
  return s.ai.baseUrl.trim() !== "" && s.ai.model.trim() !== "";
}

/** 把主题写到 <html data-theme>，CSS 据此切换；"system" 交给媒体查询 */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export async function loadSettings(): Promise<Settings> {
  const raw = (await backend.getSettings()) as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    ai: { ...DEFAULT_SETTINGS.ai, ...raw.ai },
  };
}

export async function persistSettings(s: Settings): Promise<void> {
  await backend.saveSettings(s);
  window.dispatchEvent(new Event("settings-changed"));
}
