//! The in-app browser's native side. Each tab is a child webview of the main window, positioned
//! by the panel's rect. Tauri draws these above the React tree, so the frontend hides them
//! whenever something must draw on top.
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

/// Every browser webview wears it, so a crash's leftovers are recognisable at startup.
pub const PREFIX: &str = "browser:";

const URL_EVENT: &str = "browser-url";
const TITLE_EVENT: &str = "browser-title";
const LOADING_EVENT: &str = "browser-loading";
const POPUP_EVENT: &str = "browser-popup";

#[derive(Clone, serde::Serialize)]
struct Said<T> {
    label: String,
    said: T,
}

fn say<T: Clone + serde::Serialize>(app: &tauri::AppHandle, event: &str, label: &str, said: T) {
    let _ = app.emit(
        event,
        Said {
            label: label.to_string(),
            said,
        },
    );
}

/// A page a browser can show. The panel never asks for anything else, and a page that redirects
/// itself to another scheme is a navigation this refuses rather than follows.
fn web(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|cause| format!("{url} did not read: {cause}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        scheme => Err(format!("{scheme} is not a web page")),
    }
}

fn webview(app: &tauri::AppHandle, label: &str) -> Result<tauri::webview::Webview, String> {
    app.get_webview(label)
        .ok_or_else(|| format!("no browser tab named {label}"))
}

/// Closes every browser webview the window still holds. A reloaded frontend has forgotten the
/// tabs it opened, and a page nothing can move is a page stuck over the UI, so the frontend calls
/// this before it opens its first tab.
#[tauri::command]
pub fn browser_reset(app: tauri::AppHandle) {
    for (label, view) in app.webviews() {
        if label.starts_with(PREFIX) {
            let _ = view.close();
        }
    }
}

#[tauri::command]
pub fn browser_open(
    app: tauri::AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if !label.starts_with(PREFIX) {
        return Err(format!("{label} is not a browser tab"));
    }
    if let Some(known) = app.get_webview(&label) {
        return known.navigate(web(&url)?).map_err(|cause| cause.to_string());
    }
    let window = app.get_window("main").ok_or("no main window")?;
    let target = web(&url)?;

    let moved = (app.clone(), label.clone());
    let titled = (app.clone(), label.clone());
    let loaded = (app.clone(), label.clone());
    let popped = (app.clone(), label.clone());
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target))
        .on_navigation(move |url| {
            let allowed = matches!(url.scheme(), "http" | "https");
            if allowed {
                say(&moved.0, URL_EVENT, &moved.1, url.to_string());
            }
            allowed
        })
        // A page that asks for a window gets a tab. Letting it through would put a page on screen
        // that the panel cannot move, size, or close.
        .on_new_window(move |url, _| {
            if matches!(url.scheme(), "http" | "https") {
                say(&popped.0, POPUP_EVENT, &popped.1, url.to_string());
            }
            NewWindowResponse::Deny
        })
        .on_document_title_changed(move |_, title| {
            say(&titled.0, TITLE_EVENT, &titled.1, title);
        })
        .on_page_load(move |_, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            say(&loaded.0, LOADING_EVENT, &loaded.1, loading);
            if !loading {
                say(&loaded.0, URL_EVENT, &loaded.1, payload.url().to_string());
            }
        });

    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map(|_| ())
        .map_err(|cause| cause.to_string())
}

#[tauri::command]
pub fn browser_bounds(
    app: tauri::AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let view = webview(&app, &label)?;
    view.set_position(LogicalPosition::new(x, y))
        .map_err(|cause| cause.to_string())?;
    view.set_size(LogicalSize::new(width, height))
        .map_err(|cause| cause.to_string())
}

#[tauri::command]
pub fn browser_show(app: tauri::AppHandle, label: String) -> Result<(), String> {
    webview(&app, &label)?.show().map_err(|cause| cause.to_string())
}

#[tauri::command]
pub fn browser_hide(app: tauri::AppHandle, label: String) -> Result<(), String> {
    webview(&app, &label)?.hide().map_err(|cause| cause.to_string())
}

/// Closing a tab the window never opened is the state the caller wanted, not a failure.
#[tauri::command]
pub fn browser_close(app: tauri::AppHandle, label: String) -> Result<(), String> {
    match app.get_webview(&label) {
        Some(view) => view.close().map_err(|cause| cause.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn browser_navigate(app: tauri::AppHandle, label: String, url: String) -> Result<(), String> {
    webview(&app, &label)?
        .navigate(web(&url)?)
        .map_err(|cause| cause.to_string())
}

#[tauri::command]
pub fn browser_reload(app: tauri::AppHandle, label: String) -> Result<(), String> {
    webview(&app, &label)?
        .reload()
        .map_err(|cause| cause.to_string())
}

/// Tauri exposes no history API, so the page's own history is what moves.
#[tauri::command]
pub fn browser_back(app: tauri::AppHandle, label: String) -> Result<(), String> {
    webview(&app, &label)?
        .eval("history.back()")
        .map_err(|cause| cause.to_string())
}

#[tauri::command]
pub fn browser_forward(app: tauri::AppHandle, label: String) -> Result<(), String> {
    webview(&app, &label)?
        .eval("history.forward()")
        .map_err(|cause| cause.to_string())
}
