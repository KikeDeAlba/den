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
    use super::{route_of, GO_PREFIX, LIVE, LIVE_WIDE, SECTIONS};

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

    #[test]
    fn the_first_seven_sections_take_cmd_1_through_7_in_order() {
        for (index, (_, _, accelerator)) in SECTIONS.iter().take(7).enumerate() {
            assert_eq!(*accelerator, format!("CmdOrCtrl+{}", index + 1));
        }
    }

    #[test]
    fn section_routes_are_unique_and_lowercase() {
        let routes: std::collections::HashSet<_> = SECTIONS.iter().map(|(route, _, _)| *route).collect();
        assert_eq!(routes.len(), SECTIONS.len());
        assert!(SECTIONS.iter().all(|(route, _, _)| route.chars().all(|c| c.is_ascii_lowercase())));
    }

    #[test]
    fn every_section_has_a_label() {
        assert!(SECTIONS.iter().all(|(_, label, _)| !label.trim().is_empty()));
    }

    #[test]
    fn every_go_id_round_trips_to_its_route() {
        for (route, _, _) in SECTIONS {
            assert_eq!(route_of(&format!("{GO_PREFIX}{route}")), Some(route));
        }
    }

    #[test]
    fn the_window_items_never_read_as_a_go_route() {
        assert_eq!(route_of(LIVE), None);
        assert_eq!(route_of(LIVE_WIDE), None);
        assert_eq!(route_of(""), None);
        assert_eq!(route_of("quit"), None);
    }

    #[test]
    fn a_go_id_is_matched_only_by_its_prefix() {
        assert_eq!(route_of("x-go:tiempo"), None);
        assert_eq!(route_of("GO:tiempo"), None);
        assert_eq!(route_of("go:docs/den/readme"), Some("docs/den/readme"));
    }
}
