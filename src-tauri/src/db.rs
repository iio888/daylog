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

type Migration = fn(&Connection) -> rusqlite::Result<()>;

/// 索引 i 表示「从 user_version=i 升到 i+1」要做的事，数组长度就是当前的目标版本号
/// ——不另设一个版本号常量，省掉「加了迁移忘了改常量」这类错配。
///
/// 以后加字段就在末尾追加一个闭包，例如：
/// `|c| c.execute_batch("ALTER TABLE entries ADD COLUMN mood TEXT;")`
const MIGRATIONS: &[Migration] = &[
    // → v1：建 entries / reports 两张表，与 v1.1.0 之前的 init() 逐字一致。
    // CREATE ... IF NOT EXISTS 天然幂等，所以这一步同时覆盖两种库：全新库照常建表；
    // v1.1.0 及更早的老库（表已存在、只是没有 user_version）重放一遍无副作用，
    // 只是顺手把版本号认领为 1。不需要额外去嗅探 sqlite_master 判断新旧。
    |conn| {
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
    },
];

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    // 用户可能同时用 DB Browser 之类的工具开着这个库，别一撞锁就报错退出
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    migrate(conn, MIGRATIONS)
}

/// 按 user_version 补跑差量迁移。每步各自一个事务：DDL 在 SQLite 里是事务性的，
/// 迁移失败会连同版本号推进一起回滚，不会留下「跑了一半却记成已升级」的库。
///
/// 单独接收 migrations 而不是直接读 MIGRATIONS，是为了能用测试专属的小数组
/// 验证「只补跑差量」——否则要等真加了第二个迁移才测得到。
fn migrate(conn: &Connection, migrations: &[Migration]) -> rusqlite::Result<()> {
    let mut version: i32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    while (version as usize) < migrations.len() {
        // unchecked_transaction 只要 &self；Connection::transaction 需要 &mut，
        // 会牵连 db.rs 全部函数签名。本项目单连接、外层 Mutex 串行，不存在嵌套事务。
        let tx = conn.unchecked_transaction()?;
        migrations[version as usize](&tx)?;
        version += 1;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }
    Ok(())
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
/// 转义 LIKE 的通配符。反斜杠必须先转，否则后两步引入的 `\` 会被自己再转一次。
/// 调用方必须配上 `ESCAPE '\'`，否则这里插入的反斜杠会被当成要匹配的普通字符。
fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

pub fn query(
    conn: &Connection,
    q: Option<&str>,
    tag: Option<&str>,
    project: Option<&str>,
) -> rusqlite::Result<Vec<Entry>> {
    let mut sql = String::from("SELECT * FROM entries WHERE 1=1");
    let mut binds: Vec<String> = Vec::new();
    if let Some(q) = q.filter(|s| !s.is_empty()) {
        sql.push_str(&format!(" AND content LIKE ?{} ESCAPE '\\'", binds.len() + 1));
        binds.push(format!("%{}%", escape_like(q)));
    }
    if let Some(t) = tag.filter(|s| !s.is_empty()) {
        // tags 为 JSON 数组文本，按完整字符串元素匹配
        sql.push_str(&format!(" AND tags LIKE ?{} ESCAPE '\\'", binds.len() + 1));
        binds.push(format!("%\"{}\"%", escape_like(t)));
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

/// JSON 备份导入：按 id 去重合并，返回实际新增条数。
/// 整批一个事务：中途失败要么全进要么全不进，不留下导入了一半的库。
pub fn import_entries(conn: &Connection, entries: &[Entry]) -> rusqlite::Result<u32> {
    let tx = conn.unchecked_transaction()?;
    let mut inserted = 0u32;
    for e in entries {
        let n = tx.execute(
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
    tx.commit()?;
    Ok(inserted)
}

/// 保存生成的报告（历史最多留最近 50 份）。
/// 插入与裁剪同一个事务：分开提交时，两步之间崩溃会留下超过 50 份的历史。
pub fn save_report(
    conn: &Connection,
    report_type: &str,
    range_start: &str,
    range_end: &str,
    template: &str,
    content: &str,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
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
    tx.execute(
        "DELETE FROM reports WHERE id NOT IN
         (SELECT id FROM reports ORDER BY created_at DESC, id DESC LIMIT 50)",
        [],
    )?;
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        conn
    }

    fn user_version(conn: &Connection) -> i32 {
        conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap()
    }

    #[test]
    fn fresh_db_is_at_latest_version() {
        let conn = mem();
        assert_eq!(user_version(&conn), MIGRATIONS.len() as i32);
    }

    /// v1.1.0 及更早版本装出去的库：表都在，user_version 还是默认的 0。
    /// 升级后必须就地认领为 v1，且一条记录都不能丢。
    #[test]
    fn legacy_db_without_user_version_is_claimed_in_place() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE entries (
                id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
                project TEXT, entry_date TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE reports (
                id TEXT PRIMARY KEY, type TEXT NOT NULL, range_start TEXT NOT NULL,
                range_end TEXT NOT NULL, template TEXT NOT NULL, content TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            INSERT INTO entries VALUES ('e1','老库里的记录','[\"会议\"]',NULL,'2026-01-01','t','t');",
        )
        .unwrap();
        assert_eq!(user_version(&conn), 0);

        init(&conn).unwrap();

        assert_eq!(user_version(&conn), 1);
        let kept = list_range(&conn, "2026-01-01", "2026-01-01").unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].content, "老库里的记录");
        assert_eq!(kept[0].tags, vec!["会议"]);
    }

    #[test]
    fn migrate_runs_only_the_missing_steps() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static RAN: AtomicUsize = AtomicUsize::new(0);

        let conn = Connection::open_in_memory().unwrap();
        let steps: &[Migration] = &[
            |_| panic!("已经在 v1，第 0 步不该再跑"),
            |c| {
                RAN.fetch_add(1, Ordering::SeqCst);
                c.execute_batch("CREATE TABLE step2 (x TEXT);")
            },
        ];
        conn.pragma_update(None, "user_version", 1).unwrap();

        migrate(&conn, steps).unwrap();

        assert_eq!(RAN.load(Ordering::SeqCst), 1);
        assert_eq!(user_version(&conn), 2);
        // 幂等：再跑一次不该重复执行（否则 CREATE TABLE 会报表已存在）
        migrate(&conn, steps).unwrap();
        assert_eq!(RAN.load(Ordering::SeqCst), 1);
    }

    /// 迁移失败必须连版本号一起回滚，不能留下「记成升过了、其实没升」的库
    #[test]
    fn failed_migration_rolls_back_version() {
        let conn = Connection::open_in_memory().unwrap();
        let steps: &[Migration] = &[|c| {
            c.execute_batch("CREATE TABLE half (x TEXT);")?;
            c.execute_batch("这不是合法 SQL")
        }];
        assert!(migrate(&conn, steps).is_err());
        assert_eq!(user_version(&conn), 0);
        let leftover: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'half'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(leftover, 0);
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
    fn query_treats_wildcards_as_literals() {
        let conn = mem();
        add(&conn, "进度到 50% 了", &[], None, "2026-06-11").unwrap();
        add(&conn, "进度到 99% 了", &[], None, "2026-06-12").unwrap();
        // 没有 ESCAPE 子句时这里返回 0：转义用的反斜杠会被当成要匹配的普通字符
        assert_eq!(query(&conn, Some("50%"), None, None).unwrap().len(), 1);
        // _ 是单字符通配符，不转义会把 "50x" 也算命中
        add(&conn, "编号 A_1", &[], None, "2026-06-13").unwrap();
        add(&conn, "编号 Ax1", &[], None, "2026-06-14").unwrap();
        assert_eq!(query(&conn, Some("A_1"), None, None).unwrap().len(), 1);

        add(&conn, "x", &["a_b".into()], None, "2026-06-15").unwrap();
        add(&conn, "y", &["axb".into()], None, "2026-06-16").unwrap();
        assert_eq!(query(&conn, None, Some("a_b"), None).unwrap().len(), 1);
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

    /// 导入中途失败必须整批回滚——半批数据落库比直接失败更难收拾：
    /// 用户不知道进了哪些，重导又会被 id 去重挡掉。
    #[test]
    fn import_rolls_back_on_mid_batch_failure() {
        let conn = mem();
        conn.execute_batch(
            "CREATE TRIGGER boom BEFORE INSERT ON entries WHEN NEW.id = 'bad'
             BEGIN SELECT RAISE(ABORT, '模拟写入失败'); END;",
        )
        .unwrap();
        let mk = |id: &str| Entry {
            id: id.into(),
            content: "x".into(),
            tags: vec![],
            project: None,
            entry_date: "2026-06-12".into(),
            created_at: "2026-06-12T10:00:00+08:00".into(),
            updated_at: "2026-06-12T10:00:00+08:00".into(),
        };
        assert!(import_entries(&conn, &[mk("ok1"), mk("bad"), mk("ok2")]).is_err());
        assert!(list_range(&conn, "2026-06-12", "2026-06-12").unwrap().is_empty());
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
