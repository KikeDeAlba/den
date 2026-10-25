#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::AppHandle;

pub const LIVE: &str = "live-assist";
pub const LIVE_WIDE: &str = "live-wide";

const GO_PREFIX: &str = "go:";

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const SECTIONS: [(&str, &str, &str); 8] = [
    ("ahora", "Ahora", "CmdOrCtrl+1"),
    ("agentes", "Agentes", "CmdOrCtrl+2"),
    ("tiempo", "Tiempo", "CmdOrCtrl+3"),
    ("docs", "Documentación", "CmdOrCtrl+4"),
    ("pendientes", "Pendientes y hallazgos", "CmdOrCtrl+5"),
    ("reuniones", "Reuniones", "CmdOrCtrl+6"),
    ("cerebro", "Cerebro", "CmdOrCtrl+7"),
    ("ajustes", "Ajustes", "CmdOrCtrl+,"),
];

pub fn route_of(id: &str) -> Option<&str> {
    id.strip_prefix(GO_PREFIX)
}

#[cfg(not(target_os = "macos"))]
pub fn create(_app: &AppHandle) -> tauri::Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let bita = Submenu::with_items(
        app,
        "Den",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("Acerca de Den"), None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("Ocultar Den"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Salir de Den"))?,
        ],
    )?;

    let edit = Submenu::with_items(
        app,
        "Edición",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("Deshacer"))?,
            &PredefinedMenuItem::redo(app, Some("Rehacer"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("Cortar"))?,
            &PredefinedMenuItem::copy(app, Some("Copiar"))?,
            &PredefinedMenuItem::paste(app, Some("Pegar"))?,
            &PredefinedMenuItem::select_all(app, Some("Seleccionar todo"))?,
        ],
    )?;

    let window = Submenu::with_items(
        app,
        "Ventana",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("Minimizar"))?,
            &PredefinedMenuItem::close_window(app, Some("Cerrar"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, LIVE, "Asistente de reunión", true, None::<&str>)?,
            &MenuItem::with_id(app, LIVE_WIDE, "Ventana amplia", true, None::<&str>)?,
        ],
    )?;

    let go = Submenu::with_id(app, "go", "Ir", true)?;
    for (index, (route, label, accelerator)) in SECTIONS.iter().enumerate() {
        if index == SECTIONS.len() - 1 {
            go.append(&PredefinedMenuItem::separator(app)?)?;
        }
        go.append(&MenuItem::with_id(
            app,
            format!("{GO_PREFIX}{route}"),
            *label,
            true,
            Some(*accelerator),
        )?)?;
    }

    let menu = Menu::with_items(app, &[&bita, &edit, &go, &window])?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{route_of, SECTIONS};

    #[test]
    fn go_items_carry_their_route() {
        assert_eq!(route_of("go:tiempo"), Some("tiempo"));
        assert_eq!(route_of("live-assist"), None);
    }

    #[test]
    fn every_section_has_its_own_shortcut() {
        let keys: std::collections::HashSet<_> = SECTIONS.iter().map(|(_, _, key)| *key).collect();
        assert_eq!(keys.len(), SECTIONS.len());
        assert_eq!(SECTIONS[0].2, "CmdOrCtrl+1");
        assert_eq!(SECTIONS[6].2, "CmdOrCtrl+7");
        assert_eq!(SECTIONS[7], ("ajustes", "Ajustes", "CmdOrCtrl+,"));
    }
}
