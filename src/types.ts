export interface Entry {
  id: string;
  content: string;
  tags: string[];
  project: string | null;
  /** 归属日 YYYY-MM-DD（支持补记） */
  entry_date: string;
  /** ISO8601 本地时间 */
  created_at: string;
  updated_at: string;
}

export type Page = "write" | "review" | "report";
