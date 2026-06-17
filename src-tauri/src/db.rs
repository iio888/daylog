use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct Entry {
    pub id: String,
    pub content: String,
    pub tags: Vec<String>,
    pub project: Option<String>,
    pub entry_date: String, // YYYY-MM-DD，归属日（支持补记）
    pub created_at: String, // ISO8601 本地时间
    pub updated_at: String,
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS entries (
            id         TEXT PRIMARY KEY,
            content    TEXT NOT NULL,
            tags       TEXT NOT NULL DEFAULT '[]',
            project    TEXT,
            entry_date TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(entry_date);

        CREATE TABLE IF NOT EXISTS reports (
            id          TEXT PRIMARY KEY,
            type        TEXT NOT NULL,
            range_start TEXT NOT NULL,
            range_end   TEXT NOT NULL,
            template    TEXT NOT NULL,
            content     TEXT NOT NULL,
            created_at  TEXT NOT NULL
        );",
    )
}

fn now_iso() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

fn from_row(row: &Row) -> rusqlite::Result<Entry> {
    let tags_json: String = row.get("tags")?;
    Ok(Entry {
        id: row.get("id")?,
        content: row.get("content")?,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        project: row.get("project")?,
        entry_date: row.get("entry_date")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn add(
    conn: &Connection,
    content: &str,
    tags: &[String],
    project: Option<&str>,
    entry_date: &str,
) -> rusqlite::Result<Entry> {
    let entry = Entry {
        id: uuid::Uuid::new_v4().to_string(),
        content: content.to_string(),
        tags: tags.to_vec(),
        project: project.map(str::to_string),
        entry_date: entry_date.to_string(),
        created_at: now_iso(),
        updated_at: now_iso(),
    };
    conn.execute(
        "INSERT INTO entries (id, content, tags, project, entry_date, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            entry.id,
            entry.content,
            serde_json::to_string(&entry.tags).unwrap(),
            entry.project,
            entry.entry_date,
            entry.created_at,
            entry.updated_at
        ],
    )?;
    Ok(entry)
}

pub fn list_range(conn: &Connection, start: &str, end: &str) -> rusqlite::Result<Vec<Entry>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM entries WHERE entry_date >= ?1 AND entry_date <= ?2
         ORDER BY entry_date ASC, created_at ASC",
    )?;
    let rows = stmt.query_map(params![start, end], from_row)?;
    rows.collect()
}

pub fn update(
    conn: &Connection,
    id: &str,
    content: &str,
    tags: &[String],
    project: Option<&str>,
) -> rusqlite::Result<Entry> {
    conn.execute(
        "UPDATE entries SET content = ?2, tags = ?3, project = ?4, updated_at = ?5 WHERE id = ?1",
        params![
            id,
            content,
            serde_json::to_string(tags).unwrap(),
            project,
            now_iso()
        ],
    )?;
    conn.query_row("SELECT * FROM entries WHERE id = ?1", params![id], from_row)
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM entries WHERE id = ?1", params![id])?;
    Ok(())
}

/// 搜索/过滤的统一入口：q 对正文 LIKE，tag/project 匹配，条件可叠加。
/// 均大小写不敏感（content/tags 走 LIKE 默认 ASCII 不区分大小写，project 加 COLLATE NOCASE）。
pub fn query(
    conn: &Connection,
    q: Option<&str>,
    tag: Option<&str>,
    project: Option<&str>,
) -> rusqlite::Result<Vec<Entry>> {
    let mut sql = String::from("SELECT * FROM entries WHERE 1=1");
    let mut binds: Vec<String> = Vec::new();
    if let Some(q) = q.filter(|s| !s.is_empty()) {
        sql.push_str(&format!(" AND content LIKE ?{}", binds.len() + 1));
        binds.push(format!("%{}%", q.replace('%', "\\%").replace('_', "\\_")));
    }
    if let Some(t) = tag.filter(|s| !s.is_empty()) {
        // tags 为 JSON 数组文本，按完整字符串元素匹配
        sql.push_str(&format!(" AND tags LIKE ?{}", binds.len() + 1));
        binds.push(format!("%\"{}\"%", t));
    }
    if let Some(p) = project.filter(|s| !s.is_empty()) {
        sql.push_str(&format!(" AND project = ?{} COLLATE NOCASE", binds.len() + 1));
        binds.push(p.to_string());
    }
    sql.push_str(" ORDER BY entry_date DESC, created_at DESC LIMIT 500");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(binds.iter()), from_row)?;
    rows.collect()
}

pub fn list_years(conn: &Connection) -> rusqlite::Result<Vec<i32>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT CAST(substr(entry_date, 1, 4) AS INTEGER) AS y FROM entries ORDER BY y",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, i32>(0))?;
    rows.collect()
}

/// 全库标签去重 + 频次（自动补全与过滤下拉的来源）
pub fn list_tags(conn: &Connection) -> rusqlite::Result<Vec<(String, u32)>> {
    let mut stmt = conn.prepare("SELECT tags FROM entries WHERE tags != '[]'")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut freq = std::collections::HashMap::<String, u32>::new();
    for row in rows {
        let tags: Vec<String> = serde_json::from_str(&row?).unwrap_or_default();
        for t in tags {
            *freq.entry(t).or_insert(0) += 1;
        }
    }
    let mut out: Vec<(String, u32)> = freq.into_iter().collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    Ok(out)
}

pub fn list_projects(conn: &Connection) -> rusqlite::Result<Vec<(String, u32)>> {
    let mut stmt = conn.prepare(
        "SELECT project, COUNT(*) FROM entries WHERE project IS NOT NULL
         GROUP BY project ORDER BY COUNT(*) DESC, project ASC",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?)))?;
    rows.collect()
}

/// JSON 备份导入：按 id 去重合并，返回实际新增条数
pub fn import_entries(conn: &Connection, entries: &[Entry]) -> rusqlite::Result<u32> {
    let mut inserted = 0u32;
    for e in entries {
        let n = conn.execute(
            "INSERT OR IGNORE INTO entries (id, content, tags, project, entry_date, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                e.id,
                e.content,
                serde_json::to_string(&e.tags).unwrap(),
                e.project,
                e.entry_date,
                e.created_at,
                e.updated_at
            ],
        )?;
        inserted += n as u32;
    }
    Ok(inserted)
}

/// 保存生成的报告（历史最多留最近 50 份）
pub fn save_report(
    conn: &Connection,
    report_type: &str,
    range_start: &str,
    range_end: &str,
    template: &str,
    content: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO reports (id, type, range_start, range_end, template, content, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            uuid::Uuid::new_v4().to_string(),
            report_type,
            range_start,
            range_end,
            template,
            content,
            now_iso()
        ],
    )?;
    conn.execute(
        "DELETE FROM reports WHERE id NOT IN
         (SELECT id FROM reports ORDER BY created_at DESC, id DESC LIMIT 50)",
        [],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        conn
    }

    #[test]
    fn add_and_list() {
        let conn = mem();
        add(&conn, "晨会 #会议", &["会议".into()], None, "2026-06-12").unwrap();
        add(&conn, "联调 @支付", &[], Some("支付"), "2026-06-12").unwrap();
        add(&conn, "上月的事", &[], None, "2026-05-01").unwrap();
        let june = list_range(&conn, "2026-06-01", "2026-06-30").unwrap();
        assert_eq!(june.len(), 2);
        assert_eq!(june[0].tags, vec!["会议"]);
        assert_eq!(june[1].project.as_deref(), Some("支付"));
    }

    #[test]
    fn update_and_delete() {
        let conn = mem();
        let e = add(&conn, "原文", &[], None, "2026-06-12").unwrap();
        let e2 = update(&conn, &e.id, "改后 #进展", &["进展".into()], None).unwrap();
        assert_eq!(e2.content, "改后 #进展");
        assert_eq!(e2.tags, vec!["进展"]);
        delete(&conn, &e.id).unwrap();
        assert!(list_range(&conn, "2026-06-12", "2026-06-12").unwrap().is_empty());
    }

    #[test]
    fn query_filters() {
        let conn = mem();
        add(&conn, "修复闪退 #踩坑", &["踩坑".into()], None, "2026-06-11").unwrap();
        add(&conn, "联调完成 #进展", &["进展".into()], Some("支付"), "2026-06-12").unwrap();
        assert_eq!(query(&conn, Some("闪退"), None, None).unwrap().len(), 1);
        assert_eq!(query(&conn, None, Some("进展"), None).unwrap().len(), 1);
        assert_eq!(query(&conn, None, None, Some("支付")).unwrap().len(), 1);
        assert_eq!(query(&conn, Some("联调"), Some("进展"), Some("支付")).unwrap().len(), 1);
        assert!(query(&conn, Some("不存在"), None, None).unwrap().is_empty());
    }

    #[test]
    fn import_dedup() {
        let conn = mem();
        let e = add(&conn, "已有", &[], None, "2026-06-12").unwrap();
        let new_entry = Entry {
            id: "fixed-id".into(),
            content: "导入的".into(),
            tags: vec![],
            project: None,
            entry_date: "2026-06-01".into(),
            created_at: "2026-06-01T10:00:00+08:00".into(),
            updated_at: "2026-06-01T10:00:00+08:00".into(),
        };
        // 一条重复（同 id）+ 一条新增 → 只增 1
        let n = import_entries(&conn, &[e.clone(), new_entry]).unwrap();
        assert_eq!(n, 1);
        assert_eq!(list_range(&conn, "2026-01-01", "2026-12-31").unwrap().len(), 2);
    }

    #[test]
    fn report_history_trim() {
        let conn = mem();
        for i in 0..55 {
            save_report(&conn, "weekly", "2026-06-08", "2026-06-12", "内置", &format!("第{i}份")).unwrap();
        }
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM reports", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 50);
    }

    #[test]
    fn meta_lists() {
        let conn = mem();
        add(&conn, "a #会议", &["会议".into()], Some("支付"), "2025-12-30").unwrap();
        add(&conn, "b #会议 #进展", &["会议".into(), "进展".into()], None, "2026-06-12").unwrap();
        assert_eq!(list_years(&conn).unwrap(), vec![2025, 2026]);
        let tags = list_tags(&conn).unwrap();
        assert_eq!(tags[0], ("会议".to_string(), 2));
        assert_eq!(list_projects(&conn).unwrap(), vec![("支付".to_string(), 1)]);
    }
}
