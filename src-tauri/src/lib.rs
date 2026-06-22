mod db;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::Connection;
use std::sync::Mutex;
use tauri::{Manager, State};

struct Db(Mutex<Connection>);

/// 数据根目录（db、templates/、exports/ 的父目录）
struct Dirs {
    data: std::path::PathBuf,
}

fn sanitize_filename(name: &str) -> Result<String, String> {
    if name.is_empty() || name.contains(['/', '\\']) || name.contains("..") {
        return Err(format!("非法文件名：{name}"));
    }
    Ok(name.to_string())
}

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
fn add_entry(
    state: State<Db>,
    content: String,
    tags: Vec<String>,
    project: Option<String>,
    entry_date: String,
) -> CmdResult<db::Entry> {
    let conn = state.0.lock().map_err(err)?;
    db::add(&conn, &content, &tags, project.as_deref(), &entry_date).map_err(err)
}

#[tauri::command]
fn list_range(state: State<Db>, start: String, end: String) -> CmdResult<Vec<db::Entry>> {
    let conn = state.0.lock().map_err(err)?;
    db::list_range(&conn, &start, &end).map_err(err)
}

#[tauri::command]
fn update_entry(
    state: State<Db>,
    id: String,
    content: String,
    tags: Vec<String>,
    project: Option<String>,
) -> CmdResult<db::Entry> {
    let conn = state.0.lock().map_err(err)?;
    db::update(&conn, &id, &content, &tags, project.as_deref()).map_err(err)
}

#[tauri::command]
fn delete_entry(state: State<Db>, id: String) -> CmdResult<()> {
    let conn = state.0.lock().map_err(err)?;
    db::delete(&conn, &id).map_err(err)
}

#[tauri::command]
fn query_entries(
    state: State<Db>,
    q: Option<String>,
    tag: Option<String>,
    project: Option<String>,
) -> CmdResult<Vec<db::Entry>> {
    let conn = state.0.lock().map_err(err)?;
    db::query(&conn, q.as_deref(), tag.as_deref(), project.as_deref()).map_err(err)
}

#[tauri::command]
fn list_years(state: State<Db>) -> CmdResult<Vec<i32>> {
    let conn = state.0.lock().map_err(err)?;
    db::list_years(&conn).map_err(err)
}

#[tauri::command]
fn list_tags(state: State<Db>) -> CmdResult<Vec<(String, u32)>> {
    let conn = state.0.lock().map_err(err)?;
    db::list_tags(&conn).map_err(err)
}

#[tauri::command]
fn list_projects(state: State<Db>) -> CmdResult<Vec<(String, u32)>> {
    let conn = state.0.lock().map_err(err)?;
    db::list_projects(&conn).map_err(err)
}

/// 首次启动播种内置模板：以 .seeded 标记文件判断，用户删除内置模板后不会被恢复
#[tauri::command]
fn ensure_templates_seeded(
    dirs: State<Dirs>,
    builtins: Vec<(String, String)>,
) -> CmdResult<()> {
    let dir = dirs.data.join("templates");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let flag = dir.join(".seeded");
    if flag.exists() {
        return Ok(());
    }
    for (filename, content) in builtins {
        let name = sanitize_filename(&filename)?;
        std::fs::write(dir.join(name), content).map_err(err)?;
    }
    std::fs::write(flag, "1").map_err(err)?;
    Ok(())
}

/// 扫描模板目录，返回 (文件名, 原始内容)；解析在前端做
#[tauri::command]
fn list_templates(dirs: State<Dirs>) -> CmdResult<Vec<(String, String)>> {
    let dir = dirs.data.join("templates");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let mut out = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(err)? {
        let e = e.map_err(err)?;
        let name = e.file_name().to_string_lossy().to_string();
        if name.ends_with(".md") {
            let content = std::fs::read_to_string(e.path()).map_err(err)?;
            out.push((name, content));
        }
    }
    out.sort();
    Ok(out)
}

#[tauri::command]
fn save_template(dirs: State<Dirs>, filename: String, content: String) -> CmdResult<()> {
    let dir = dirs.data.join("templates");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let name = sanitize_filename(&filename)?;
    std::fs::write(dir.join(name), content).map_err(err)?;
    Ok(())
}

/// 解析当前导出目录：优先用户在 export_dir.txt 配置的路径，否则数据目录下的 exports/
fn export_dir(dirs: &Dirs) -> std::path::PathBuf {
    let cfg = dirs.data.join("export_dir.txt");
    if let Ok(s) = std::fs::read_to_string(&cfg) {
        let s = s.trim();
        if !s.is_empty() {
            return std::path::PathBuf::from(s);
        }
    }
    dirs.data.join("exports")
}

/// 返回当前导出目录的完整路径（供前端展示）
#[tauri::command]
fn get_export_dir(dirs: State<Dirs>) -> CmdResult<String> {
    Ok(export_dir(&dirs).to_string_lossy().to_string())
}

/// 设置导出目录；传空字符串则恢复默认（exports/）
#[tauri::command]
fn set_export_dir(dirs: State<Dirs>, dir: String) -> CmdResult<()> {
    let cfg = dirs.data.join("export_dir.txt");
    let t = dir.trim();
    if t.is_empty() {
        let _ = std::fs::remove_file(&cfg); // 恢复默认
        return Ok(());
    }
    std::fs::create_dir_all(t).map_err(err)?; // 确保目录可用
    std::fs::write(&cfg, t).map_err(err)?;
    Ok(())
}

/// 导出报告到导出目录，返回完整路径
#[tauri::command]
fn export_report(dirs: State<Dirs>, filename: String, content: String) -> CmdResult<String> {
    let dir = export_dir(&dirs);
    std::fs::create_dir_all(&dir).map_err(err)?;
    let name = sanitize_filename(&filename)?;
    let path = dir.join(name);
    std::fs::write(&path, content).map_err(err)?;
    Ok(path.to_string_lossy().to_string())
}

/// 列出模板目录下的 .docx 文件名
#[tauri::command]
fn list_docx_templates(dirs: State<Dirs>) -> CmdResult<Vec<String>> {
    let dir = dirs.data.join("templates");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let mut out = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(err)? {
        let name = e.map_err(err)?.file_name().to_string_lossy().to_string();
        if name.to_lowercase().ends_with(".docx") {
            out.push(name);
        }
    }
    out.sort();
    Ok(out)
}

/// 读取模板目录下某文件的二进制内容，base64 返回（供前端 docx 引擎处理）
#[tauri::command]
fn read_template_bytes(dirs: State<Dirs>, filename: String) -> CmdResult<String> {
    let name = sanitize_filename(&filename)?;
    let bytes = std::fs::read(dirs.data.join("templates").join(name)).map_err(err)?;
    Ok(STANDARD.encode(bytes))
}

/// 保存二进制模板（导入 .docx 用），data_b64 为 base64 编码内容
#[tauri::command]
fn save_template_bytes(dirs: State<Dirs>, filename: String, data_b64: String) -> CmdResult<()> {
    let dir = dirs.data.join("templates");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let name = sanitize_filename(&filename)?;
    let bytes = STANDARD.decode(data_b64.as_bytes()).map_err(err)?;
    std::fs::write(dir.join(name), bytes).map_err(err)?;
    Ok(())
}

/// 导出二进制文件（.docx）到 exports/，data_b64 为 base64，返回完整路径
#[tauri::command]
fn export_report_bytes(dirs: State<Dirs>, filename: String, data_b64: String) -> CmdResult<String> {
    let dir = export_dir(&dirs);
    std::fs::create_dir_all(&dir).map_err(err)?;
    let name = sanitize_filename(&filename)?;
    let bytes = STANDARD.decode(data_b64.as_bytes()).map_err(err)?;
    let path = dir.join(name);
    std::fs::write(&path, bytes).map_err(err)?;
    Ok(path.to_string_lossy().to_string())
}

/// 用系统文件管理器打开 templates / exports / data 目录
#[tauri::command]
fn open_dir(dirs: State<Dirs>, kind: String) -> CmdResult<()> {
    let dir = match kind.as_str() {
        "templates" => dirs.data.join("templates"),
        "exports" => export_dir(&dirs),
        "data" => dirs.data.clone(),
        _ => return Err(format!("未知目录类型：{kind}")),
    };
    std::fs::create_dir_all(&dir).map_err(err)?;
    #[cfg(target_os = "windows")]
    let cmd = "explorer";
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let cmd = "xdg-open";
    std::process::Command::new(cmd).arg(&dir).spawn().map_err(err)?;
    Ok(())
}

#[tauri::command]
fn save_report(
    state: State<Db>,
    report_type: String,
    range_start: String,
    range_end: String,
    template: String,
    content: String,
) -> CmdResult<()> {
    let conn = state.0.lock().map_err(err)?;
    db::save_report(&conn, &report_type, &range_start, &range_end, &template, &content)
        .map_err(err)
}

#[tauri::command]
fn get_settings(dirs: State<Dirs>) -> CmdResult<serde_json::Value> {
    let path = dirs.data.join("settings.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(err),
        Err(_) => Ok(serde_json::json!({})),
    }
}

#[tauri::command]
fn save_settings(dirs: State<Dirs>, settings: serde_json::Value) -> CmdResult<()> {
    let path = dirs.data.join("settings.json");
    std::fs::write(&path, serde_json::to_string_pretty(&settings).map_err(err)?).map_err(err)
}

#[tauri::command]
fn import_entries(state: State<Db>, entries: Vec<db::Entry>) -> CmdResult<u32> {
    let conn = state.0.lock().map_err(err)?;
    db::import_entries(&conn, &entries).map_err(err)
}

fn trunc(s: &str) -> String {
    s.chars().take(300).collect()
}

/// 统一的 AI 调用：单一 OpenAI 兼容端点（/v1/chat/completions）。
/// 本地模型（Ollama 等）与云端（填对应 Base URL + Key）共用同一协议。
/// 提示词构造在前端（src/ai.ts），这里只做 HTTP。
#[tauri::command]
async fn ai_chat(dirs: State<'_, Dirs>, system: String, user: String) -> CmdResult<String> {
    let path = dirs.data.join("settings.json");
    let raw = std::fs::read_to_string(&path).map_err(|_| "尚未配置 AI 服务".to_string())?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(err)?;

    let base = v["ai"]["baseUrl"]
        .as_str()
        .unwrap_or("")
        .trim()
        .trim_end_matches('/')
        .to_string();
    let model = v["ai"]["model"].as_str().unwrap_or("").trim();
    if base.is_empty() {
        return Err("尚未配置 Base URL（设置 → AI 服务）".into());
    }
    if model.is_empty() {
        return Err("尚未配置模型名（设置 → AI 服务）".into());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(err)?;
    let body = serde_json::json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ]
    });
    let mut req = client.post(format!("{base}/chat/completions")).json(&body);
    if let Some(k) = v["ai"]["apiKey"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
        req = req.bearer_auth(k);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("无法连接 AI 服务（{base}）：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(err)?;
    if !status.is_success() {
        return Err(format!("AI 服务 {status}：{}", trunc(&text)));
    }
    let j: serde_json::Value = serde_json::from_str(&text).map_err(err)?;
    j["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "AI 服务响应格式异常".into())
}

/// 列出 OpenAI 兼容端点的可用模型（GET {base}/models）。
/// 仅需 Base URL + 可选 API Key，不依赖已保存的设置、也不需要模型名——专供「测试连接」。
#[tauri::command]
async fn ai_models(base_url: String, api_key: Option<String>) -> CmdResult<Vec<String>> {
    let base = base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("请先填写 Base URL".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(err)?;
    let mut req = client.get(format!("{base}/models"));
    if let Some(k) = api_key.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        req = req.bearer_auth(k);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("无法连接 AI 服务（{base}）：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(err)?;
    if !status.is_success() {
        return Err(format!("AI 服务 {status}：{}", trunc(&text)));
    }
    let j: serde_json::Value = serde_json::from_str(&text).map_err(err)?;
    // OpenAI 兼容响应：{ "data": [ { "id": "..." }, ... ] }
    let mut ids: Vec<String> = j["data"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if ids.is_empty() {
        return Err("已连接，但端点未返回任何模型".into());
    }
    ids.sort();
    Ok(ids)
}

/// 数据目录：exe 同目录存在 data\ 则用之（便携模式），否则用系统应用数据目录。
fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let portable = dir.join("data");
            if portable.is_dir() {
                return Ok(portable);
            }
        }
    }
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = data_dir(app.handle())?;
            app.manage(Dirs { data: dir.clone() });
            let db_path = dir.join("daylog.db");
            let conn = Connection::open(&db_path).map_err(|e| {
                // 数据库损坏时备份原文件再重建，避免启动失败
                let _ = std::fs::copy(&db_path, dir.join("daylog.db.bak"));
                e
            })?;
            db::init(&conn)?;
            app.manage(Db(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_entry,
            list_range,
            update_entry,
            delete_entry,
            query_entries,
            list_years,
            list_tags,
            list_projects,
            ensure_templates_seeded,
            list_templates,
            save_template,
            export_report,
            list_docx_templates,
            read_template_bytes,
            save_template_bytes,
            export_report_bytes,
            get_export_dir,
            set_export_dir,
            open_dir,
            save_report,
            get_settings,
            save_settings,
            import_entries,
            ai_chat,
            ai_models
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
