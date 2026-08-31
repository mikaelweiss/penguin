//! The in-app browser's native side. Each tab is a child webview of the main window, positioned
//! by the panel's rect. Tauri draws these above the React tree, so the frontend hides them
//! whenever something must draw on top.
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, Rect, Url, WebviewUrl};

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

/// How far the window's content area sits above the page's own viewport.
///
/// The panel measures a rect with getBoundingClientRect, which is relative to the viewport it is
/// drawn in. A child webview is placed against the window's content area, and on macOS that area
/// can reach up under the title bar, which the viewport does not. Rather than hard-code a title
/// bar height that is wrong on the next platform, the two heights are compared: whatever the
/// content area has that the viewport does not is the inset, and zero means they already agree.
fn inset(window: &tauri::Window, viewport: f64) -> f64 {
    let scale = match window.scale_factor() {
        Ok(scale) => scale,
        Err(_) => return 0.0,
    };
    match window.inner_size() {
        Ok(size) => size.to_logical::<f64>(scale).height - viewport,
        Err(_) => 0.0,
    }
}

fn rect(window: &tauri::Window, at: Bounds) -> Rect {
    Rect {
        position: LogicalPosition::new(at.x, at.y + inset(window, at.viewport)).into(),
        size: LogicalSize::new(at.width, at.height).into(),
    }
}

/// Where the panel wants a page, in the coordinates its own viewport measures.
#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    /// The height of the viewport the rect was measured in, which calibrates the inset.
    viewport: f64,
}

/// Always position and size at once. macOS measures a subview's origin from the bottom, so the top
/// a caller asked for is a function of the height, and setting either alone moves the page.
fn place(view: &tauri::webview::Webview, at: Rect) -> Result<(), String> {
    view.set_bounds(at).map_err(|cause| cause.to_string())
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
    at: Bounds,
) -> Result<(), String> {
    if !label.starts_with(PREFIX) {
        return Err(format!("{label} is not a browser tab"));
    }
    let window = app.get_window("main").ok_or("no main window")?;
    // Already a child: put it where the panel is. Loading the url again would throw away the page.
    if let Some(known) = app.get_webview(&label) {
        place(&known, rect(&window, at))?;
        return known.show().map_err(|cause| cause.to_string());
    }
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

    let made = window
        .add_child(
            builder,
            LogicalPosition::new(at.x, at.y),
            LogicalSize::new(at.width, at.height),
        )
        .map_err(|cause| cause.to_string())?;
    // After the child exists, never before. Until a window has one, tauri answers inner_size with
    // the main webview's own frame, which hides the very gap the inset is measuring. The frame a
    // child is born with also skips set_bounds, and the panel only pushes a rect that moved, so a
    // page placed wrong here would have no second chance.
    place(&made, rect(&window, at))
}

#[tauri::command]
pub fn browser_bounds(app: tauri::AppHandle, label: String, at: Bounds) -> Result<(), String> {
    let window = app.get_window("main").ok_or("no main window")?;
    place(&webview(&app, &label)?, rect(&window, at))
}

#[tauri::command]
pub fn browser_show(app: tauri::AppHandle, label: String) -> Result<(), String> {
    webview(&app, &label)?.show().map_err(|cause| cause.to_string())
}

#[tauri::command]
pub fn browser_hide(app: tauri::AppHandle, label: String) -> Result<(), String> {
    webview(&app, &label)?.hide().map_err(|cause| cause.to_string())
}

/// Gives the keyboard back to a page that lost it to the window's own webview.
#[tauri::command]
pub fn browser_focus(app: tauri::AppHandle, label: String) -> Result<(), String> {
    webview(&app, &label)?
        .set_focus()
        .map_err(|cause| cause.to_string())
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
