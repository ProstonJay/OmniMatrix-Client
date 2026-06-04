use std::collections::HashMap;
use tauri::Manager;
use tokio::process::Command as TokioCommand;

/// 建立不彈出黑色控制台視窗的 tokio Command（僅 Windows 生效）
fn no_window_cmd(program: &std::path::Path) -> TokioCommand {
    let mut cmd = TokioCommand::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}


/// 用 reqwest async 直接發 GET 請求，完全繞過 WebView CORS 限制，不阻塞任何线程
#[tauri::command]
async fn native_get(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    resp.text().await.map_err(|e| e.to_string())
}

/// 用 reqwest async 直接發 POST 請求，不阻塞任何线程
#[tauri::command]
async fn native_post(url: String, body: String, headers: Option<HashMap<String, String>>) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.post(&url)
        .header("Content-Type", "application/json")
        .body(body);
    if let Some(hdrs) = headers {
        for (k, v) in hdrs {
            req = req.header(k, v);
        }
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    resp.text().await.map_err(|e| e.to_string())
}

/// 尝试找到 node 可执行文件：先试 PATH，再试 Windows 常见安装路径
fn find_node() -> Option<std::path::PathBuf> {
    // 1. 先试系统 PATH（用同步 std::process 探测，仅一次，无阻塞影响）
    if std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_ok()
    {
        return Some(std::path::PathBuf::from("node"));
    }
    // 2. Windows 常见安装位置 fallback
    let candidates = [
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
        r"C:\nodejs\node.exe",
    ];
    // 3. 从 APPDATA / LOCALAPPDATA 推导 nvm 路径（nvm-windows 常见位置）
    let mut paths: Vec<String> = candidates.iter().map(|s| s.to_string()).collect();
    if let Ok(appdata) = std::env::var("APPDATA") {
        paths.push(format!(r"{}\nvm\nodejs\node.exe", appdata));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        paths.push(format!(r"{}\Programs\nodejs\node.exe", local));
    }
    for p in &paths {
        let pb = std::path::PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    None
}

/// 调用 node 执行 replyTweet.js 脚本，使用 tokio::process 真正异步，不阻塞 Rust 线程池
#[tauri::command]
async fn run_reply_script(
    script_path: String,
    serial: String,
    ads_base: String,
    tweet_url: String,
    deepseek_key: String,
    system_prompt: String,
    append_url: String,
    append_text: String,
) -> Result<String, String> {
    let node = find_node()
        .ok_or_else(|| "找不到 Node.js，请确认已安装 Node.js 并可通过常见路径访问".to_string())?;

    let output = no_window_cmd(&node)
        .args([&script_path, &serial, &ads_base, &tweet_url, &deepseek_key, &system_prompt, &append_url, &append_text])
        .output()
        .await
        .map_err(|e| format!("启动 node 失败: {} (路径: {})", e, node.display()))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !stderr.is_empty() {
        eprintln!("[replyScript stderr] {}", stderr);
    }

    let result = stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .last()
        .unwrap_or("")
        .to_string();

    if result.is_empty() {
        return Err(format!("脚本无输出. stderr: {}", stderr));
    }

    Ok(result)
}

/// 异步写入 KV 文件存储，完全替代 JS localStorage，存于 AppData/store/<key>.json
#[tauri::command]
async fn store_write(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("store");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let file = dir.join(format!("{}.json", key));
    tokio::fs::write(&file, value.as_bytes())
        .await
        .map_err(|e| e.to_string())
}

/// 异步读取 KV 文件存储，不存在时返回 null
#[tauri::command]
async fn store_read(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let file = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("store")
        .join(format!("{}.json", key));
    match tokio::fs::read_to_string(&file).await {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 👇 核心：把更新器插件 (tauri-plugin-updater) 初始化加到这里
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![run_reply_script, native_get, native_post, store_write, store_read])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
