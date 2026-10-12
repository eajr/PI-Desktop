use super::*;
use crate::activation::ActivationMode;
use tempfile::tempdir;

/// Serializes tests that repoint process-wide environment such as
/// `PI_DESKTOP_DATA_DIR`, so two tests cannot read each other's value.
static PROCESS_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn lock_process_env() -> std::sync::MutexGuard<'static, ()> {
    PROCESS_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[test]
fn package_path_traversal_rejected() {
    // PI_DESKTOP_DATA_DIR is process-wide; hold the shared lock so two tests
    // cannot point it at each other's directory.
    let _env = lock_process_env();
    let dir = tempdir().unwrap();
    unsafe {
        std::env::set_var("PI_DESKTOP_DATA_DIR", dir.path());
    }
    let bad = make_zip(&[("../evil.js", b"alert(1)")]);
    let pkg = dir.path().join("bad.piplug");
    fs::write(&pkg, bad).unwrap();
    let mut mgr = PluginManager::new(dir.path());
    let err = mgr
        .install_from_package(
            pkg.to_str().unwrap(),
            InstallOptions {
                source: "installed".into(),
                enable: true,
                expected_shasum: None,
                granted_permissions: None,
            },
        )
        .unwrap_err()
        .to_string();
    assert!(err.contains("path traversal") || err.contains("PLUGIN_INVALID"));
    unsafe {
        std::env::remove_var("PI_DESKTOP_DATA_DIR");
    }
}

fn write_plugin(root: &Path, manifest: Value, extra: &[(&str, &str)]) {
    fs::create_dir_all(root).unwrap();
    fs::write(root.join("main.js"), "export function onLoad() {}").unwrap();
    fs::write(
        root.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();
    for (rel, contents) in extra {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }
}

fn capability_manifest(contributes: Value, permissions: Value) -> Value {
    json!({
        "schemaVersion": 1,
        "id": "demo.caps",
        "name": "Caps",
        "version": "0.1.0",
        "main": "main.js",
        "contributes": contributes,
        "permissions": permissions,
    })
}

fn read_manifest_err(root: &Path) -> String {
    PluginManager::read_manifest(root)
        .expect_err("manifest should be rejected")
        .to_string()
}

#[test]
fn accepts_and_summarizes_new_contributions() {
    // PI_DESKTOP_DATA_DIR is process-wide; hold the shared lock so two tests
    // cannot point it at each other's directory.
    let _env = lock_process_env();
    let dir = tempdir().unwrap();
    let root = dir.path().join("plugin");
    write_plugin(
        &root,
        json!({
            "schemaVersion": 1,
            "id": "demo.caps",
            "name": "Caps",
            "version": "0.1.0",
            "main": "main.js",
            "ui": { "panel": "renderer/index.html" },
            "contributes": {
                "commands": [{ "id": "a", "title": "A" }],
                "views": [{ "id": "changes", "title": "Changes", "entry": "views/changes.html" }],
                "settings": [{
                    "key": "openShortcut",
                    "title": "Open shortcut",
                    "type": "shortcut",
                    "default": "Mod+Shift+A",
                    "command": "a",
                    "scope": "plugin"
                }],
                "agentTools": [{ "name": "t", "description": "d" }],
                "skills": ["./skills/a.md", { "path": "skills/b.md", "id": "b" }],
                "themes": [{ "id": "midnight", "label": "Midnight", "path": "themes/m.css", "base": "dark" }],
                "mcpServers": [
                    { "id": "local", "transport": "stdio", "command": "mcp-files", "args": ["--root", "."] },
                    { "id": "remote", "transport": "http", "url": "https://example.com/mcp" }
                ],
                "services": [{ "id": "watcher" }],
                "bus": { "publish": ["notes.created"], "subscribe": ["notes.**"] }
            },
            "permissions": [
                "ui.panel",
                "ui.view",
                "ui.theme",
                "agent.tool.register",
                "mcp.server.local",
                "mcp.server.remote",
                "background.service",
                "bus.publish",
                "bus.subscribe"
            ],
        }),
        &[
            ("renderer/index.html", "<html></html>"),
            ("views/changes.html", "<html></html>"),
            ("skills/a.md", "---\nname: A\n---\nbody"),
            ("skills/b.md", "body"),
            ("themes/m.css", ":root { --ds-bg: #000; }"),
        ],
    );
    let manifest = PluginManager::read_manifest(&root).unwrap();
    assert_eq!(
        derive_capabilities(&manifest),
        vec!["panel", "commands", "views", "tools", "skills", "themes", "mcp", "services", "bus"]
    );

    let data = tempdir().unwrap();
    unsafe {
        std::env::set_var("PI_DESKTOP_DATA_DIR", data.path());
    }
    let mut mgr = PluginManager::new(data.path());
    let summary = mgr.load_dev(root.to_str().unwrap()).unwrap();
    assert!(summary.capabilities.contains(&"mcp".to_string()));
    assert!(summary.capabilities.contains(&"bus".to_string()));
    assert_eq!(summary.settings.len(), 1);
    assert_eq!(summary.settings[0].scope, "plugin");
    unsafe {
        std::env::remove_var("PI_DESKTOP_DATA_DIR");
    }
}

#[test]
fn missing_contributed_files_are_rejected() {
    let dir = tempdir().unwrap();
    let skill_root = dir.path().join("skill");
    write_plugin(
        &skill_root,
        capability_manifest(json!({ "skills": ["skills/gone.md"] }), json!([])),
        &[],
    );
    assert!(read_manifest_err(&skill_root).contains("skill file missing"));

    let theme_root = dir.path().join("theme");
    write_plugin(
        &theme_root,
        capability_manifest(
            json!({ "themes": [{ "id": "a", "label": "A", "path": "themes/gone.css" }] }),
            json!(["ui.theme"]),
        ),
        &[],
    );
    assert!(read_manifest_err(&theme_root).contains("theme css missing"));
}

#[test]
fn contributed_paths_must_stay_inside_the_plugin() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("plugin");
    write_plugin(
        &root,
        capability_manifest(json!({ "skills": ["../outside.md"] }), json!([])),
        &[],
    );
    assert!(read_manifest_err(&root).contains("traversal"));
}

#[test]
fn theme_contributions_require_permission_and_css() {
    let dir = tempdir().unwrap();
    let no_perm = dir.path().join("no-perm");
    write_plugin(
        &no_perm,
        capability_manifest(
            json!({ "themes": [{ "id": "a", "label": "A", "path": "themes/a.css" }] }),
            json!([]),
        ),
        &[("themes/a.css", ":root {}")],
    );
    assert!(read_manifest_err(&no_perm).contains("ui.theme permission"));

    let wrong_ext = dir.path().join("wrong-ext");
    write_plugin(
        &wrong_ext,
        capability_manifest(
            json!({ "themes": [{ "id": "a", "label": "A", "path": "themes/a.json" }] }),
            json!(["ui.theme"]),
        ),
        &[("themes/a.json", "{}")],
    );
    assert!(read_manifest_err(&wrong_ext).contains(".css file"));
}

#[test]
fn theme_assets_accept_package_relative_and_absolute_whitelisted_paths() {
    let dir = tempdir().unwrap();

    let package = dir.path().join("package");
    write_plugin(
        &package,
        capability_manifest(
            json!({ "themes": [{
                "id": "a", "label": "A", "path": "themes/a.css",
                "assets": ["art/bg.png", "fonts/ui.woff2"]
            }] }),
            json!(["ui.theme"]),
        ),
        &[
            ("themes/a.css", ":root {}"),
            ("art/bg.png", "png"),
            ("fonts/ui.woff2", "woff"),
        ],
    );
    assert!(PluginManager::read_manifest(&package).is_ok());

    // Prefix and separator normalization produce one package-relative key.
    let duplicate = dir.path().join("duplicate");
    write_plugin(
        &duplicate,
        capability_manifest(
            json!({ "themes": [{
                "id": "a", "label": "A", "path": "themes/a.css",
                "assets": ["art/bg.png", ".\\art\\bg.png"]
            }] }),
            json!(["ui.theme"]),
        ),
        &[("themes/a.css", ":root {}"), ("art/bg.png", "png")],
    );
    assert!(read_manifest_err(&duplicate).contains("twice"));

    // Absolute filesystem paths and their legacy file: spellings remain valid.
    let shared = dir.path().join("shared");
    fs::create_dir_all(&shared).unwrap();
    fs::write(shared.join("outside.png"), "png").unwrap();
    fs::write(shared.join("font.woff2"), "woff").unwrap();
    let image = shared
        .join("outside.png")
        .to_string_lossy()
        .replace('\\', "/");
    let font = shared
        .join("font.woff2")
        .to_string_lossy()
        .replace('\\', "/");
    let spaced_font = shared.join("font folder/ui font.woff2");
    fs::create_dir_all(spaced_font.parent().unwrap()).unwrap();
    fs::write(&spaced_font, "woff").unwrap();
    let encoded_font_url = format!(
        "FILE://{}",
        spaced_font
            .to_string_lossy()
            .replace('\\', "/")
            .replace(' ', "%20")
    );
    let absolute = dir.path().join("absolute");
    write_plugin(
        &absolute,
        capability_manifest(
            json!({ "themes": [{
                "id": "a", "label": "A", "path": "themes/a.css",
                "assets": [image, format!("file://{font}"), encoded_font_url]
            }] }),
            json!(["ui.theme"]),
        ),
        &[("themes/a.css", ":root {}")],
    );
    assert!(PluginManager::read_manifest(&absolute).is_ok());

    for (name, asset, expected_error) in [
        ("missing", "art/missing.png".to_string(), "asset missing"),
        (
            "escape",
            "../outside.png".to_string(),
            "package-relative or absolute image or font path on the whitelist",
        ),
        (
            "traversal",
            "art/../outside.png".to_string(),
            "package-relative or absolute image or font path on the whitelist",
        ),
        (
            "absolute-traversal",
            format!("{image}/../outside.png"),
            "package-relative or absolute image or font path on the whitelist",
        ),
        (
            "node-modules",
            "node_modules/pkg/image.png".to_string(),
            "package-relative or absolute image or font path on the whitelist",
        ),
        (
            "empty-segment",
            "art//bg.png".to_string(),
            "package-relative or absolute image or font path on the whitelist",
        ),
        (
            "dot-segment",
            "art/./bg.png".to_string(),
            "package-relative or absolute image or font path on the whitelist",
        ),
        (
            "scheme",
            "https://example.test/image.png".to_string(),
            "package-relative or absolute image or font path on the whitelist",
        ),
        (
            "colon",
            "art:image.png".to_string(),
            "package-relative or absolute image or font path on the whitelist",
        ),
        (
            "wrong-ext",
            "art/bg.gif".to_string(),
            "package-relative or absolute image or font path on the whitelist",
        ),
    ] {
        let root = dir.path().join(name);
        write_plugin(
            &root,
            capability_manifest(
                json!({ "themes": [{
                    "id": "a", "label": "A", "path": "themes/a.css", "assets": [asset]
                }] }),
                json!(["ui.theme"]),
            ),
            &[("themes/a.css", ":root {}")],
        );
        let error = read_manifest_err(&root);
        assert!(error.contains(expected_error), "{name}: {error}");
    }
}

#[test]
fn package_relative_theme_asset_budget_is_enforced_across_files() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("budget");
    write_plugin(
        &root,
        capability_manifest(
            json!({ "themes": [{
                "id": "a", "label": "A", "path": "themes/a.css",
                "assets": ["art/first.webp", "art/second.webp"]
            }] }),
            json!(["ui.theme"]),
        ),
        &[("themes/a.css", ":root {}")],
    );
    fs::create_dir_all(root.join("art")).unwrap();
    let first = root.join("art/first.webp");
    let second = root.join("art/second.webp");
    fs::write(&first, vec![b'x'; 2 * 1024 * 1024]).unwrap();
    fs::write(&second, vec![b'x'; 2 * 1024 * 1024]).unwrap();
    assert!(PluginManager::read_manifest(&root).is_ok());

    fs::write(&second, vec![b'x'; 2 * 1024 * 1024 + 1]).unwrap();
    assert!(read_manifest_err(&root).contains("assets exceed 4194304 bytes"));
}

#[cfg(unix)]
#[test]
fn package_relative_theme_assets_cannot_escape_through_symlinks() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("plugin");
    write_plugin(
        &root,
        capability_manifest(
            json!({ "themes": [{
                "id": "a", "label": "A", "path": "themes/a.css", "assets": ["art/escape.webp"]
            }] }),
            json!(["ui.theme"]),
        ),
        &[("themes/a.css", ":root {}")],
    );
    let art = root.join("art");
    fs::create_dir_all(&art).unwrap();
    let outside = dir.path().join("outside.webp");
    fs::write(&outside, "image").unwrap();
    std::os::unix::fs::symlink(&outside, art.join("escape.webp")).unwrap();

    assert!(read_manifest_err(&root).contains("resolves outside the plugin package"));
}

#[test]
fn install_from_package_accepts_a_package_relative_theme_asset() {
    let dir = tempdir().unwrap();
    let manifest = json!({
        "schemaVersion": 1,
        "id": "demo.theme-pack",
        "name": "Theme Pack",
        "version": "0.1.0",
        "main": "main.js",
        "contributes": {
            "themes": [{
                "id": "sunset",
                "label": "Sunset",
                "path": "themes/sunset.css",
                "assets": ["art/preview.png"]
            }]
        },
        "permissions": ["ui.theme"]
    });
    let package = make_zip(&[
        (
            "theme-pack/manifest.json",
            &serde_json::to_vec(&manifest).unwrap(),
        ),
        ("theme-pack/main.js", b"export function onLoad() {}"),
        ("theme-pack/themes/sunset.css", b":root {}"),
        ("theme-pack/art/preview.png", b"png"),
    ]);
    let package_path = dir.path().join("theme-pack.piplug");
    fs::write(&package_path, package).unwrap();

    let mut manager = PluginManager::new(dir.path());
    let installed = manager
        .install_from_package(
            package_path.to_str().unwrap(),
            InstallOptions {
                source: "installed".into(),
                enable: true,
                expected_shasum: None,
                granted_permissions: None,
            },
        )
        .unwrap();

    assert_eq!(installed.plugin.id, "demo.theme-pack");
    let install_root = Path::new(installed.plugin.path.as_deref().unwrap());
    assert!(install_root.join("art/preview.png").is_file());
}

#[test]
fn window_appearance_requires_permission_and_a_hex_colour() {
    let dir = tempdir().unwrap();

    let no_perm = dir.path().join("no-perm");
    write_plugin(
        &no_perm,
        capability_manifest(
            json!({ "windowAppearance": { "backgroundColor": { "dark": "#0d1424" } } }),
            json!([]),
        ),
        &[],
    );
    assert!(read_manifest_err(&no_perm).contains("ui.window.appearance permission"));

    let no_perm_radius = dir.path().join("no-perm-radius");
    write_plugin(
        &no_perm_radius,
        capability_manifest(
            json!({ "windowAppearance": { "cornerRadius": 4 } }),
            json!([]),
        ),
        &[],
    );
    assert!(read_manifest_err(&no_perm_radius).contains("ui.window.appearance permission"));

    let bad_colour = dir.path().join("bad-colour");
    write_plugin(
        &bad_colour,
        capability_manifest(
            json!({ "windowAppearance": { "backgroundColor": { "dark": "#0d1424ccc" } } }),
            json!(["ui.window.appearance"]),
        ),
        &[],
    );
    assert!(read_manifest_err(&bad_colour).contains("#rrggbb or #rrggbbaa"));

    let bad_radius = dir.path().join("bad-radius");
    write_plugin(
        &bad_radius,
        capability_manifest(
            json!({ "windowAppearance": { "cornerRadius": 25 } }),
            json!(["ui.window.appearance"]),
        ),
        &[],
    );
    assert!(read_manifest_err(&bad_radius).contains("cornerRadius"));

    let ok = dir.path().join("ok");
    write_plugin(
        &ok,
        capability_manifest(
            json!({ "windowAppearance": { "backgroundColor": { "light": "#f5f5f5", "dark": "#0d1424cc" }, "cornerRadius": 4 } }),
            json!(["ui.window.appearance"]),
        ),
        &[],
    );
    assert!(PluginManager::read_manifest(&ok).is_ok());
}

#[test]
fn view_contributions_require_permission_and_an_existing_entry() {
    let dir = tempdir().unwrap();
    let view = |extra: Value| json!({ "views": [extra] });

    let no_perm = dir.path().join("no-perm");
    write_plugin(
        &no_perm,
        capability_manifest(
            view(json!({ "id": "a", "title": "A", "entry": "views/a.html" })),
            json!([]),
        ),
        &[("views/a.html", "<html></html>")],
    );
    assert!(read_manifest_err(&no_perm).contains("ui.view permission"));

    let missing_entry = dir.path().join("missing-entry");
    write_plugin(
        &missing_entry,
        capability_manifest(
            view(json!({ "id": "a", "title": "A", "entry": "views/a.html" })),
            json!(["ui.view"]),
        ),
        &[],
    );
    assert!(read_manifest_err(&missing_entry).contains("view entry missing"));

    let no_title = dir.path().join("no-title");
    write_plugin(
        &no_title,
        capability_manifest(
            view(json!({ "id": "a", "title": "  ", "entry": "views/a.html" })),
            json!(["ui.view"]),
        ),
        &[("views/a.html", "<html></html>")],
    );
    assert!(read_manifest_err(&no_title).contains("requires a title"));

    // A localized title is accepted, and the entry may not escape the root.
    let escaping = dir.path().join("escaping");
    write_plugin(
        &escaping,
        capability_manifest(
            view(json!({
                "id": "a",
                "title": { "en": "A", "zh-CN": "甲" },
                "entry": "../outside.html"
            })),
            json!(["ui.view"]),
        ),
        &[],
    );
    assert!(read_manifest_err(&escaping).contains("traversal"));
}

#[test]
fn bundled_plugins_refresh_from_disk_but_keep_user_state() {
    let ship = tempdir().unwrap();
    let plugin_manifest = |version: &str| {
        json!({
            "schemaVersion": 1,
            "id": "pi.files",
            "name": "Files",
            "version": version,
            "main": "main.js",
            "contributes": {
                "views": [{ "id": "tree", "title": "Files", "entry": "views/tree.html" }]
            },
            "permissions": ["ui.view"],
        })
    };
    let root = ship.path().join("pi.files");
    write_plugin(
        &root,
        plugin_manifest("1.0.0"),
        &[("views/tree.html", "<html></html>")],
    );

    let data = tempdir().unwrap();
    let mut mgr = PluginManager::new(data.path());
    mgr.sync_builtin(Some(ship.path())).unwrap();

    let listed = mgr.get("pi.files").expect("bundled plugin is registered");
    assert_eq!(listed.source, "builtin");
    assert_eq!(listed.version, "1.0.0");
    assert!(listed.enabled, "a bundled plugin is on by default");
    assert!(listed.capabilities.contains(&"views".to_string()));

    // A bundled plugin is part of the app, so it cannot be uninstalled.
    assert!(mgr
        .uninstall("pi.files")
        .unwrap_err()
        .to_string()
        .contains("cannot be uninstalled"),);

    // The user turning it off must survive the next launch, even though the
    // rest of the row is rebuilt from the shipped manifest.
    mgr.set_enabled("pi.files", false).unwrap();
    write_plugin(
        &root,
        plugin_manifest("2.0.0"),
        &[("views/tree.html", "<html></html>")],
    );
    mgr.sync_builtin(Some(ship.path())).unwrap();
    let after = mgr.get("pi.files").unwrap();
    assert_eq!(after.version, "2.0.0", "an app update refreshes the row");
    assert!(!after.enabled, "the user's choice is not overwritten");

    // A build that stops shipping it leaves no orphan row behind.
    fs::remove_dir_all(&root).unwrap();
    mgr.sync_builtin(Some(ship.path())).unwrap();
    assert!(mgr.get("pi.files").is_none());
}

#[test]
fn bundled_plugin_can_default_to_disabled_without_overwriting_user_state() {
    let ship = tempdir().unwrap();
    let root = ship.path().join("pi.opt-in");
    write_plugin(
        &root,
        json!({
            "schemaVersion": 1,
            "id": "pi.opt-in",
            "name": "Opt In",
            "version": "1.0.0",
            "main": "main.js",
            "enabledByDefault": false,
            "permissions": ["ui.panel"],
        }),
        &[],
    );

    let data = tempdir().unwrap();
    let mut mgr = PluginManager::new(data.path());
    mgr.sync_builtin(Some(ship.path())).unwrap();
    let listed = mgr.get("pi.opt-in").expect("bundled plugin is registered");
    assert!(!listed.enabled, "opt-in bundled plugins start disabled");
    assert_eq!(listed.status, "disabled");
    assert!(mgr
        .uninstall("pi.opt-in")
        .unwrap_err()
        .to_string()
        .contains("cannot be uninstalled"),);

    mgr.set_enabled("pi.opt-in", true).unwrap();
    mgr.sync_builtin(Some(ship.path())).unwrap();
    let after = mgr.get("pi.opt-in").unwrap();
    assert!(after.enabled, "an explicit enable survives the next launch");
}

/// The user updates a bundled plugin; the update must outlive the next launch
/// while the plugin stays uninstallable (ADR 0241).
#[test]
fn a_bundled_plugin_keeps_the_update_the_user_installed() {
    let ship = tempdir().unwrap();
    let shipped = ship.path().join("pi.view");
    let shipped_manifest = |version: &str| {
        json!({
            "schemaVersion": 1,
            "id": "pi.view",
            "name": "View",
            "version": version,
            "main": "main.js",
            "permissions": ["ui.panel"],
        })
    };
    write_plugin(&shipped, shipped_manifest("1.0.0"), &[]);

    let data = tempdir().unwrap();
    let mut mgr = PluginManager::new(data.path());
    mgr.sync_builtin(Some(ship.path())).unwrap();
    assert!(mgr.get("pi.view").unwrap().bundled);

    let update = data.path().join("package");
    write_plugin(&update, shipped_manifest("1.1.0"), &[]);
    let installed = mgr
        .install_from_path(
            update.to_str().unwrap(),
            InstallOptions {
                source: "marketplace".into(),
                enable: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(installed.plugin.source, "marketplace");
    assert!(
        installed.plugin.bundled,
        "updating does not stop a plugin from being bundled"
    );

    // The next launch reconciles against the shipped 1.0.0 again.
    let mut mgr = PluginManager::new(data.path());
    mgr.sync_builtin(Some(ship.path())).unwrap();
    let after = mgr.get("pi.view").unwrap();
    assert_eq!(
        after.version, "1.1.0",
        "the user's update is not rolled back"
    );
    assert_eq!(after.source, "marketplace");
    assert!(after.bundled);
    assert_eq!(after.path, installed.plugin.path);

    // Updating is allowed; removing is still not.
    assert!(mgr
        .uninstall("pi.view")
        .unwrap_err()
        .to_string()
        .contains("cannot be uninstalled"));
}

/// The other direction: an app update that ships a newer version than the one
/// the user installed must win, otherwise a stale install would pin the plugin
/// for good.
#[test]
fn a_newer_shipped_version_replaces_an_older_user_install() {
    let ship = tempdir().unwrap();
    let shipped = ship.path().join("pi.view");
    let manifest = |version: &str| {
        json!({
            "schemaVersion": 1,
            "id": "pi.view",
            "name": "View",
            "version": version,
            "main": "main.js",
            "permissions": ["ui.panel"],
        })
    };
    write_plugin(&shipped, manifest("1.0.0"), &[]);

    let data = tempdir().unwrap();
    let mut mgr = PluginManager::new(data.path());
    mgr.sync_builtin(Some(ship.path())).unwrap();

    let update = data.path().join("package");
    write_plugin(&update, manifest("1.1.0"), &[]);
    mgr.install_from_path(
        update.to_str().unwrap(),
        InstallOptions {
            source: "marketplace".into(),
            enable: true,
            ..Default::default()
        },
    )
    .unwrap();

    // The app update ships 2.0.0.
    fs::remove_dir_all(&shipped).unwrap();
    write_plugin(&shipped, manifest("2.0.0"), &[]);
    mgr.sync_builtin(Some(ship.path())).unwrap();
    let after = mgr.get("pi.view").unwrap();
    assert_eq!(after.version, "2.0.0");
    assert_eq!(after.source, "builtin");
    assert!(after.bundled);
}

/// A build that stops shipping the plugin stops protecting it: the user's
/// install is left alone, and it becomes theirs to remove.
#[test]
fn a_plugin_a_build_stops_shipping_is_no_longer_bundled() {
    let ship = tempdir().unwrap();
    let shipped = ship.path().join("pi.view");
    let manifest = |version: &str| {
        json!({
            "schemaVersion": 1,
            "id": "pi.view",
            "name": "View",
            "version": version,
            "main": "main.js",
            "permissions": ["ui.panel"],
        })
    };
    write_plugin(&shipped, manifest("1.0.0"), &[]);

    let data = tempdir().unwrap();
    let mut mgr = PluginManager::new(data.path());
    mgr.sync_builtin(Some(ship.path())).unwrap();

    let update = data.path().join("package");
    write_plugin(&update, manifest("1.1.0"), &[]);
    mgr.install_from_path(
        update.to_str().unwrap(),
        InstallOptions {
            source: "marketplace".into(),
            enable: true,
            ..Default::default()
        },
    )
    .unwrap();

    fs::remove_dir_all(&shipped).unwrap();
    mgr.sync_builtin(Some(ship.path())).unwrap();
    let after = mgr.get("pi.view").expect("the user's install survives");
    assert_eq!(after.version, "1.1.0");
    assert!(
        !after.bundled,
        "a plugin this build does not ship is not advertised as bundled"
    );
    assert!(mgr.uninstall("pi.view").unwrap());
}

#[test]
fn stdio_mcp_commands_may_not_escape_the_plugin() {
    let dir = tempdir().unwrap();
    for (name, command, expected) in [
        ("absolute", "/usr/bin/evil", "absolute"),
        ("traversal", "../evil.js", "traversal"),
        ("shell", "sh -c evil", "executable name"),
    ] {
        let root = dir.path().join(name);
        write_plugin(
            &root,
            capability_manifest(
                json!({ "mcpServers": [{ "id": "s", "transport": "stdio", "command": command }] }),
                json!(["mcp.server.local"]),
            ),
            &[],
        );
        assert!(
            read_manifest_err(&root).contains(expected),
            "command {command} should be rejected"
        );
    }
}

#[test]
fn remote_mcp_urls_accept_non_loopback_http() {
    let dir = tempdir().unwrap();
    let remote = dir.path().join("remote");
    write_plugin(
        &remote,
        capability_manifest(
            json!({ "mcpServers": [{ "id": "s", "transport": "http", "url": "http://example.com/mcp" }] }),
            json!(["mcp.server.remote"]),
        ),
        &[],
    );
    assert!(PluginManager::read_manifest(&remote).is_ok());

    let credentials = dir.path().join("credentials");
    write_plugin(
        &credentials,
        capability_manifest(
            json!({ "mcpServers": [{ "id": "s", "transport": "http", "url": "https://u:p@example.com/mcp" }] }),
            json!(["mcp.server.remote"]),
        ),
        &[],
    );
    assert!(read_manifest_err(&credentials).contains("credentials"));

    let loopback = dir.path().join("loopback");
    write_plugin(
        &loopback,
        capability_manifest(
            json!({ "mcpServers": [{ "id": "s", "transport": "http", "url": "http://127.0.0.1:8931/mcp" }] }),
            json!(["mcp.server.remote"]),
        ),
        &[],
    );
    assert!(PluginManager::read_manifest(&loopback).is_ok());
}

#[test]
fn services_and_bus_declarations_are_checked() {
    let dir = tempdir().unwrap();
    let service = dir.path().join("service");
    write_plugin(
        &service,
        capability_manifest(json!({ "services": [{ "id": "watcher" }] }), json!([])),
        &[],
    );
    assert!(read_manifest_err(&service).contains("background.service permission"));

    let topic = dir.path().join("topic");
    write_plugin(
        &topic,
        capability_manifest(
            json!({ "bus": { "publish": ["notes.*"] } }),
            json!(["bus.publish"]),
        ),
        &[],
    );
    assert!(read_manifest_err(&topic).contains("not a valid topic"));

    let pattern = dir.path().join("pattern");
    write_plugin(
        &pattern,
        capability_manifest(
            json!({ "bus": { "subscribe": ["notes.**.x"] } }),
            json!(["bus.subscribe"]),
        ),
        &[],
    );
    assert!(read_manifest_err(&pattern).contains("not valid"));
}

/// A scope is a user decision about reach, so it has to survive the two
/// things that rewrite a plugin record: a restart and a reinstall.
#[test]
fn a_project_scope_survives_a_reload_and_a_reinstall() {
    // PI_DESKTOP_DATA_DIR is process-wide; hold the shared lock so two tests
    // cannot point it at each other's directory.
    let _env = lock_process_env();
    let dir = tempdir().unwrap();
    unsafe {
        std::env::set_var("PI_DESKTOP_DATA_DIR", dir.path());
    }

    let source = dir.path().join("src");
    write_plugin(
        &source,
        json!({
            "schemaVersion": 1,
            "id": "demo.scoped",
            "name": "Scoped",
            "version": "0.1.0",
            "main": "main.js",
        }),
        &[],
    );

    let mut mgr = PluginManager::new(dir.path());
    let installed = mgr
        .install_from_path(
            source.to_str().unwrap(),
            InstallOptions {
                source: "installed".into(),
                enable: true,
                ..Default::default()
            },
        )
        .unwrap();
    // Anything installed before scopes existed reads as global, so that is
    // also what a fresh install has to be.
    assert_eq!(installed.plugin.scope.mode, ActivationMode::Global);

    let scoped = mgr
        .set_scope(
            "demo.scoped",
            ActivationScope {
                mode: ActivationMode::Projects,
                projects: vec!["/work/api".into()],
            },
        )
        .unwrap()
        .expect("plugin missing");
    assert_eq!(scoped.scope.projects, vec!["/work/api".to_string()]);

    // Off is a separate switch: it must not consume the project list.
    let disabled = mgr.set_enabled("demo.scoped", false).unwrap().unwrap();
    assert!(!disabled.enabled);
    assert_eq!(disabled.scope.projects, vec!["/work/api".to_string()]);

    let reloaded = PluginManager::new(dir.path());
    let after = reloaded.get("demo.scoped").expect("plugin missing");
    assert_eq!(after.scope.mode, ActivationMode::Projects);
    assert_eq!(after.scope.projects, vec!["/work/api".to_string()]);

    // Reinstalling over the top is an update, not a reset: widening a
    // project-scoped plugin back to everywhere would hand it reach the user
    // never granted.
    let mut mgr = PluginManager::new(dir.path());
    let again = mgr
        .install_from_path(
            source.to_str().unwrap(),
            InstallOptions {
                source: "installed".into(),
                enable: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(again.plugin.scope.mode, ActivationMode::Projects);
    assert_eq!(again.plugin.scope.projects, vec!["/work/api".to_string()]);

    unsafe {
        std::env::remove_var("PI_DESKTOP_DATA_DIR");
    }
}

#[test]
fn global_shortcuts_require_permission_and_a_declared_command() {
    let dir = tempdir().unwrap();
    let commands = || json!([{ "id": "voice.pushToTalk", "title": "Push to talk" }]);

    // Accepted, and the contribution survives parsing.
    let ok = dir.path().join("ok");
    write_plugin(
        &ok,
        capability_manifest(
            json!({
                "commands": commands(),
                "globalShortcuts": [{
                    "id": "voice.pushToTalk",
                    "command": "voice.pushToTalk",
                    "default": "Alt+Space"
                }]
            }),
            json!(["keyboard.globalShortcut"]),
        ),
        &[],
    );
    let manifest = PluginManager::read_manifest(&ok).unwrap();
    let contributes = manifest.contributes.as_ref().expect("contributes parsed");
    assert_eq!(
        contributes["globalShortcuts"],
        json!([{
            "id": "voice.pushToTalk",
            "command": "voice.pushToTalk",
            "default": "Alt+Space"
        }])
    );

    // A shortcut declared without the permission would register silently.
    let no_perm = dir.path().join("no-perm");
    write_plugin(
        &no_perm,
        capability_manifest(
            json!({
                "commands": commands(),
                "globalShortcuts": [{ "id": "voice.pushToTalk", "command": "voice.pushToTalk" }]
            }),
            json!([]),
        ),
        &[],
    );
    assert!(read_manifest_err(&no_perm)
        .contains("global shortcuts require the keyboard.globalShortcut permission"));

    // A shortcut may only reach a command this plugin declares.
    let undeclared = dir.path().join("undeclared");
    write_plugin(
        &undeclared,
        capability_manifest(
            json!({
                "commands": commands(),
                "globalShortcuts": [{ "id": "voice.pushToTalk", "command": "voice.other" }]
            }),
            json!(["keyboard.globalShortcut"]),
        ),
        &[],
    );
    assert!(read_manifest_err(&undeclared).contains("references an undeclared command"));
}

#[test]
fn global_shortcut_entries_are_validated() {
    let dir = tempdir().unwrap();
    let commands = || json!([{ "id": "voice.pushToTalk", "title": "Push to talk" }]);
    let grant = || json!(["keyboard.globalShortcut"]);

    let duplicate = dir.path().join("duplicate");
    write_plugin(
        &duplicate,
        capability_manifest(
            json!({
                "commands": commands(),
                "globalShortcuts": [
                    { "id": "voice.pushToTalk", "command": "voice.pushToTalk" },
                    { "id": "voice.pushToTalk", "command": "voice.pushToTalk" }
                ]
            }),
            grant(),
        ),
        &[],
    );
    assert!(read_manifest_err(&duplicate).contains("duplicate global shortcut id voice.pushToTalk"));

    let bad_id = dir.path().join("bad-id");
    write_plugin(
        &bad_id,
        capability_manifest(
            json!({
                "commands": commands(),
                "globalShortcuts": [{ "id": "voice push", "command": "voice.pushToTalk" }]
            }),
            grant(),
        ),
        &[],
    );
    assert!(read_manifest_err(&bad_id).contains("global shortcut id is missing or invalid"));

    let bad_default = dir.path().join("bad-default");
    for (name, default) in [("text", json!("Ctrl+")), ("number", json!(42))] {
        let root = bad_default.join(name);
        write_plugin(
            &root,
            capability_manifest(
                json!({
                    "commands": commands(),
                    "globalShortcuts": [{
                        "id": "voice.pushToTalk",
                        "command": "voice.pushToTalk",
                        "default": default
                    }]
                }),
                grant(),
            ),
            &[],
        );
        assert!(read_manifest_err(&root)
            .contains("global shortcut voice.pushToTalk has an invalid default"));
    }

    let too_many = dir.path().join("too-many");
    write_plugin(
        &too_many,
        capability_manifest(
            json!({
                "commands": commands(),
                "globalShortcuts": (0..9)
                    .map(|index| json!({ "id": format!("voice.slot{index}"), "command": "voice.pushToTalk" }))
                    .collect::<Vec<_>>()
            }),
            grant(),
        ),
        &[],
    );
    assert!(read_manifest_err(&too_many)
        .contains("contributes.globalShortcuts allows at most 8 entries"));

    let not_an_object = dir.path().join("not-an-object");
    write_plugin(
        &not_an_object,
        capability_manifest(json!({ "globalShortcuts": ["voice.pushToTalk"] }), grant()),
        &[],
    );
    assert!(read_manifest_err(&not_an_object)
        .contains("contributes.globalShortcuts entry must be an object"));
}

#[test]
fn composer_transforms_require_permission_and_localized_titles() {
    let dir = tempdir().unwrap();
    let transform = json!({
        "id": "enhance",
        "title": { "en": "Enhance prompt", "zh-CN": "增强提示词" },
        "undoTitle": { "en": "Undo enhancement", "zh-CN": "撤销增强" }
    });

    let valid = dir.path().join("valid");
    write_plugin(
        &valid,
        capability_manifest(
            json!({ "composerTransforms": [transform.clone()] }),
            json!(["composer.transform"]),
        ),
        &[],
    );
    let manifest = PluginManager::read_manifest(&valid).unwrap();
    assert!(derive_capabilities(&manifest).contains(&"composerTransform".to_string()));

    let no_permission = dir.path().join("no-permission");
    write_plugin(
        &no_permission,
        capability_manifest(
            json!({ "composerTransforms": [transform.clone()] }),
            json!([]),
        ),
        &[],
    );
    assert!(read_manifest_err(&no_permission)
        .contains("composer transforms require the composer.transform permission"));

    let malformed = dir.path().join("malformed");
    write_plugin(
        &malformed,
        capability_manifest(
            json!({ "composerTransforms": [{ "id": "enhance", "title": { "en": "Only English" } }] }),
            json!(["composer.transform"]),
        ),
        &[],
    );
    assert!(read_manifest_err(&malformed).contains("has an invalid title"));
}

#[test]
fn plugin_rows_read_the_i18n_block_for_the_active_locale() {
    let _env = lock_process_env();
    let dir = tempdir().unwrap();
    let root = dir.path().join("plugin");
    write_plugin(
        &root,
        json!({
            "schemaVersion": 1,
            "id": "acme.todo",
            "name": "小清新待办",
            "version": "0.1.0",
            "description": "作者原话",
            "main": "main.js",
            "i18n": {
                "en": { "name": "Todo List", "description": "A calm todo list" },
                "zh-CN": { "name": "小清新待办", "description": "轻盈的待办清单" }
            }
        }),
        &[],
    );
    let mut mgr = PluginManager::new(dir.path());
    mgr.set_locale("en");
    let row = mgr.load_dev(root.to_str().unwrap()).unwrap();
    assert_eq!(row.name, "Todo List");
    assert_eq!(row.description.as_deref(), Some("A calm todo list"));

    // Every reader resolves the same way: `list()` and `get()` are what the
    // Extensions page and the plugin launcher actually draw.
    mgr.set_locale("zh-CN");
    assert_eq!(mgr.get("acme.todo").unwrap().name, "小清新待办");
    let listed = mgr
        .list()
        .into_iter()
        .find(|candidate| candidate.id == "acme.todo")
        .expect("row missing from the list");
    assert_eq!(listed.description.as_deref(), Some("轻盈的待办清单"));

    // `zh-Hans` is Simplified Chinese. `zh-TW` is not part of the plugin
    // contract, so it reads English rather than half a translation (ADR 0182).
    mgr.set_locale("zh-Hans");
    assert_eq!(mgr.get("acme.todo").unwrap().name, "小清新待办");
    mgr.set_locale("zh-TW");
    assert_eq!(mgr.get("acme.todo").unwrap().name, "Todo List");
    mgr.set_locale("de");
    assert_eq!(mgr.get("acme.todo").unwrap().name, "Todo List");
}

#[test]
fn a_partial_translation_falls_back_per_field() {
    let _env = lock_process_env();
    let dir = tempdir().unwrap();
    let root = dir.path().join("plugin");
    write_plugin(
        &root,
        json!({
            "schemaVersion": 1,
            "id": "acme.partial",
            "name": "Author name",
            "version": "0.1.0",
            "description": "Author description",
            "main": "main.js",
            "i18n": { "en": { "name": "English name", "description": "   " } }
        }),
        &[],
    );
    let mut mgr = PluginManager::new(dir.path());
    mgr.set_locale("en");
    let row = mgr.load_dev(root.to_str().unwrap()).unwrap();
    assert_eq!(row.name, "English name");
    // A blank translation must not blank out a usable author description.
    assert_eq!(row.description.as_deref(), Some("Author description"));

    // A locale with no entry at all falls back to English, not to nothing.
    mgr.set_locale("fr");
    assert_eq!(mgr.get("acme.partial").unwrap().name, "English name");
}

#[test]
fn a_plugin_without_an_i18n_block_keeps_the_authors_strings() {
    let _env = lock_process_env();
    let dir = tempdir().unwrap();
    let root = dir.path().join("plugin");
    write_plugin(
        &root,
        json!({
            "schemaVersion": 1,
            "id": "acme.plain",
            "name": "Plain",
            "version": "0.1.0",
            "description": "Plain description",
            "main": "main.js"
        }),
        &[],
    );
    let mut mgr = PluginManager::new(dir.path());
    mgr.set_locale("zh-CN");
    let row = mgr.load_dev(root.to_str().unwrap()).unwrap();
    assert_eq!(row.name, "Plain");
    assert_eq!(row.description.as_deref(), Some("Plain description"));
}

#[test]
fn the_registry_never_persists_the_i18n_block() {
    let _env = lock_process_env();
    let dir = tempdir().unwrap();
    let root = dir.path().join("plugin");
    write_plugin(
        &root,
        json!({
            "schemaVersion": 1,
            "id": "acme.stored",
            "name": "Stored",
            "version": "0.1.0",
            "main": "main.js",
            "i18n": { "en": { "name": "Stored" }, "zh-CN": { "name": "已存" } }
        }),
        &[],
    );
    let mut mgr = PluginManager::new(dir.path());
    mgr.set_locale("zh-CN");
    mgr.load_dev(root.to_str().unwrap()).unwrap();

    // The registry keeps the author's own language; only reads are localized,
    // so switching language never rewrites persisted rows.
    let raw = fs::read_to_string(mgr.registry_path()).unwrap();
    assert!(!raw.contains("\"i18n\""), "registry persisted i18n: {raw}");
    assert!(raw.contains("Stored"));

    // A restart re-reads each manifest, so rows are localized again without
    // the registry having carried anything.
    let mut reloaded = PluginManager::new(dir.path());
    reloaded.set_locale("zh-CN");
    assert_eq!(reloaded.get("acme.stored").unwrap().name, "已存");
}

#[test]
fn plugin_ui_meta_parses_the_floating_widget_placement() {
    let widget: PluginUiMeta = serde_json::from_value(json!({
        "panel": "renderer/index.html",
        "width": 200,
        "height": 200,
        "shape": "widget",
        "alwaysOnTop": true,
        "resizable": false
    }))
    .unwrap();
    assert_eq!(widget.shape.as_deref(), Some("widget"));
    assert_eq!(widget.always_on_top, Some(true));
    assert_eq!(widget.resizable, Some(false));

    // A manifest that never heard of widgets keeps deserializing untouched, and
    // the camelCase keys stay the wire contract.
    let panel: PluginUiMeta =
        serde_json::from_value(json!({ "panel": "renderer/index.html" })).unwrap();
    assert!(panel.shape.is_none());
    assert!(panel.always_on_top.is_none());
    assert!(panel.resizable.is_none());
}

/// Build a store-only zip, the only compression `extract_zip_bytes` accepts.
fn make_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut offset: u32 = 0;
    let mut central = Vec::new();
    let mut entries = 0u16;
    for (name, data) in files {
        let name_bytes = name.as_bytes();
        let crc = crc32(data);
        let mut local = Vec::new();
        local.extend_from_slice(&0x04034b50u32.to_le_bytes());
        local.extend_from_slice(&20u16.to_le_bytes()); // version needed
        local.extend_from_slice(&0u16.to_le_bytes()); // flags
        local.extend_from_slice(&0u16.to_le_bytes()); // method store
        local.extend_from_slice(&0u16.to_le_bytes()); // time
        local.extend_from_slice(&0u16.to_le_bytes()); // date
        local.extend_from_slice(&crc.to_le_bytes());
        local.extend_from_slice(&(data.len() as u32).to_le_bytes());
        local.extend_from_slice(&(data.len() as u32).to_le_bytes());
        local.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes()); // extra
        local.extend_from_slice(name_bytes);
        local.extend_from_slice(data);
        out.extend_from_slice(&local);

        let mut cen = Vec::new();
        cen.extend_from_slice(&0x02014b50u32.to_le_bytes());
        cen.extend_from_slice(&20u16.to_le_bytes());
        cen.extend_from_slice(&20u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&crc.to_le_bytes());
        cen.extend_from_slice(&(data.len() as u32).to_le_bytes());
        cen.extend_from_slice(&(data.len() as u32).to_le_bytes());
        cen.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u32.to_le_bytes());
        cen.extend_from_slice(&offset.to_le_bytes());
        cen.extend_from_slice(name_bytes);
        central.extend_from_slice(&cen);
        offset += local.len() as u32;
        entries += 1;
    }
    let central_offset = out.len() as u32;
    out.extend_from_slice(&central);
    let central_size = central.len() as u32;
    out.extend_from_slice(&0x06054b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&entries.to_le_bytes());
    out.extend_from_slice(&entries.to_le_bytes());
    out.extend_from_slice(&central_size.to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for b in data {
        crc ^= u32::from(*b);
        for _ in 0..8 {
            let mask = (!(crc & 1)).wrapping_add(1);
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// Strings that only a remote plugin marketplace client would need: the
/// catalog and resolve host, the mirror host, the catalog override, and the
/// resolve endpoint. Built with `concat!` so this file does not match itself.
const MARKETPLACE_NEEDLES: &[&str] = &[
    concat!("plugins", ".aiuo.net"),
    concat!("cnb", ".cool"),
    concat!("PI_DESKTOP_PLUGIN", "_MARKET_URL"),
    concat!("download", "/resolve"),
];

/// What the removed resolve call derived and sent about this machine.
const DEVICE_ID_NEEDLES: &[&str] = &[
    concat!("device", "Id"),
    concat!("device", "_id"),
    concat!("machine", "_id"),
    concat!("IOPlatform", "UUID"),
    concat!("Machine", "Guid"),
];

fn rust_sources(path: &Path, out: &mut Vec<PathBuf>) {
    if path.is_dir() {
        for entry in fs::read_dir(path).unwrap() {
            rust_sources(&entry.unwrap().path(), out);
        }
    } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
        out.push(path.to_path_buf());
    }
}

fn source_hits(roots: &[PathBuf], needles: &[&str]) -> Vec<String> {
    let mut files = Vec::new();
    for root in roots {
        rust_sources(root, &mut files);
    }
    assert!(!files.is_empty());
    let mut hits = Vec::new();
    for file in files {
        let text = fs::read_to_string(&file).unwrap();
        for needle in needles {
            if text.contains(needle) {
                hits.push(format!("{} contains {needle}", file.display()));
            }
        }
    }
    hits
}

/// Regression guard for ADR fork-removes-plugin-marketplace: host-core has
/// no code that can reach a plugin marketplace, and the plugin module derives
/// no device identifier.
#[test]
fn host_core_has_no_plugin_marketplace_client() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let hits = source_hits(std::slice::from_ref(&src), MARKETPLACE_NEEDLES);
    assert!(
        hits.is_empty(),
        "marketplace client code is back: {hits:#?}"
    );
    let hits = source_hits(
        &[src.join("plugins"), src.join("plugins.rs")],
        DEVICE_ID_NEEDLES,
    );
    assert!(
        hits.is_empty(),
        "plugin device identifier is back: {hits:#?}"
    );
}

/// Building a manager on a fresh data directory is local-only: it registers
/// nothing, writes no catalog, and creates no marketplace or device state.
#[test]
fn a_new_manager_on_an_empty_data_dir_stays_local() {
    let dir = tempdir().unwrap();
    let mgr = PluginManager::new(dir.path());
    assert!(mgr.list().is_empty());
    assert!(dir.path().join("plugins/installed").is_dir());
    assert!(
        !dir.path().join("plugins/market").exists(),
        "no marketplace cache directory is created"
    );
}

/// A profile from a build that had the marketplace keeps working: the cached
/// catalog and device file are left untouched, a marketplace-installed plugin
/// stays registered, and the stale update/withdrawal state is not carried.
#[test]
fn legacy_marketplace_state_is_ignored_and_preserved() {
    let dir = tempdir().unwrap();
    let market = dir.path().join("plugins/market");
    fs::create_dir_all(&market).unwrap();
    let catalog = r#"{"schemaVersion":2,"plugins":[{"id":"acme.todo"}]}"#;
    fs::write(market.join("catalog.json"), catalog).unwrap();
    fs::write(market.join("cache-meta.json"), r#"{"sourceUrl":"x"}"#).unwrap();
    fs::write(market.join("device.json"), r#"{"id":"legacy"}"#).unwrap();

    let installed = dir.path().join("plugins/installed/acme.todo");
    write_plugin(
        &installed,
        json!({
            "schemaVersion": 1,
            "id": "acme.todo",
            "name": "Todo",
            "version": "1.0.0",
            "main": "main.js",
            "permissions": ["ui.panel"],
        }),
        &[],
    );
    let registry = json!([{
        "id": "acme.todo",
        "name": "Todo",
        "version": "1.0.0",
        "enabled": true,
        "source": "marketplace",
        "status": "ready",
        "permissions": ["ui.panel"],
        "path": installed.to_string_lossy(),
        "marketplace": { "providerId": "official", "shasum": "abc" },
        "autoUpdate": true,
        "updateAvailable": {
            "version": "1.1.0",
            "shasum": "def",
            "url": "https://example.invalid/todo.piplug",
            "permissionDiff": []
        },
        "yanked": { "version": "1.0.0", "reason": "old" }
    }]);
    fs::write(
        dir.path().join("plugins/registry.json"),
        serde_json::to_string(&registry).unwrap(),
    )
    .unwrap();

    let mut mgr = PluginManager::new(dir.path());
    let plugin = mgr.get("acme.todo").expect("marketplace install survives");
    assert!(plugin.enabled);
    assert_eq!(plugin.source, "marketplace");
    assert_eq!(
        plugin.marketplace.as_ref().map(|m| m.provider_id.as_str()),
        Some("official")
    );

    mgr.set_enabled("acme.todo", false).unwrap();
    let saved = fs::read_to_string(dir.path().join("plugins/registry.json")).unwrap();
    for stale in ["autoUpdate", "updateAvailable", "yanked"] {
        assert!(!saved.contains(stale), "{stale} is not written back");
    }

    assert_eq!(
        fs::read_to_string(market.join("catalog.json")).unwrap(),
        catalog
    );
    assert!(market.join("cache-meta.json").is_file());
    assert!(market.join("device.json").is_file());
}

/// An upgrade from a build that bundled `pi.file-manager` drops its builtin
/// row without disturbing the plugins this build still ships.
#[test]
fn a_previously_bundled_file_manager_is_dropped_on_upgrade() {
    let old_ship = tempdir().unwrap();
    for id in ["pi.file-manager", "pi.browser"] {
        write_plugin(
            &old_ship.path().join(id),
            json!({
                "schemaVersion": 1,
                "id": id,
                "name": id,
                "version": "1.0.0",
                "main": "main.js",
                "permissions": ["ui.view"],
            }),
            &[],
        );
    }
    let data = tempdir().unwrap();
    let mut mgr = PluginManager::new(data.path());
    mgr.sync_builtin(Some(old_ship.path())).unwrap();
    assert!(mgr.get("pi.file-manager").unwrap().bundled);

    fs::remove_dir_all(old_ship.path().join("pi.file-manager")).unwrap();
    let mut mgr = PluginManager::new(data.path());
    mgr.sync_builtin(Some(old_ship.path())).unwrap();
    assert!(mgr.get("pi.file-manager").is_none());
    let browser = mgr.get("pi.browser").expect("other bundled plugins stay");
    assert!(browser.bundled);
    assert!(browser.enabled);
}

#[test]
fn plugin_versions_order_by_semver() {
    assert_eq!(compare_plugin_versions("0.5.1", "0.5.0"), Ordering::Greater);
    assert_eq!(
        compare_plugin_versions("0.5.1", "0.5.1-beta.1"),
        Ordering::Greater
    );
    assert_eq!(compare_plugin_versions("v1.0", "1.0.0"), Ordering::Equal);
}
