#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The settings window talks to the SolidWorks add-in over stdin/stdout, one JSON message per line.
// It stays open between actions: requests go out with `send_to_host`, and the add-in's replies are
// picked up by the page through `next_message`.

use serde_json::Value;
use std::io::{self, BufRead, Write};
use std::sync::{mpsc, Arc, Mutex};
use tauri::State;

struct Inbox(Arc<Mutex<mpsc::Receiver<Value>>>);

#[tauri::command]
fn read_settings(input: State<'_, Value>) -> Value {
    input.inner().clone()
}

#[tauri::command]
fn send_to_host(message: Value) -> Result<(), String> {
    let mut output = io::stdout().lock();
    serde_json::to_writer(&mut output, &message).map_err(|error| error.to_string())?;
    writeln!(output).map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())
}

/// Waits for the add-in's next reply. Returns null once SolidWorks has gone away.
#[tauri::command]
async fn next_message(inbox: State<'_, Inbox>) -> Result<Option<Value>, String> {
    let receiver = inbox.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .lock()
            .map(|messages| messages.recv().ok())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn cancel(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut json = String::new();
    io::stdin()
        .lock()
        .read_line(&mut json)
        .map_err(|error| format!("Could not read the cut list from SolidWorks: {error}"))?;
    if json.trim().is_empty() {
        return Err("No cut-list data was received. Start this window from Tools > Auto Cut List in SolidWorks.".into());
    }
    let input: Value = serde_json::from_str(&json)
        .map_err(|error| format!("The cut-list data from SolidWorks could not be read: {error}"))?;

    // Every later line from the add-in is a reply. When the pipe closes, the sender is dropped and
    // `next_message` returns null, which tells the page to close.
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(message) = serde_json::from_str::<Value>(&line) {
                if sender.send(message).is_err() {
                    break;
                }
            }
        }
    });

    tauri::Builder::default()
        .manage(input)
        .manage(Inbox(Arc::new(Mutex::new(receiver))))
        .invoke_handler(tauri::generate_handler![read_settings, send_to_host, next_message, cancel])
        .run(tauri::generate_context!())
        .map_err(|error| format!("The settings window could not open: {error}"))
}
