use tauri::AppHandle;

#[cfg(target_os = "macos")]
pub fn regular(app: &AppHandle) {
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
}

#[cfg(not(target_os = "macos"))]
pub fn regular(_app: &AppHandle) {}
