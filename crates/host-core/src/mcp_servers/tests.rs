use super::*;
use crate::agent_capabilities::test_support;
use tempfile::tempdir;

/// A registry plus the two directories a level switch needs.
fn scaffolding() -> (tempfile::TempDir, tempfile::TempDir, tempfile::TempDir) {
    (tempdir().unwrap(), tempdir().unwrap(), tempdir().unwrap())
}

fn stdio(id: &str) -> McpServerInput {
    McpServerInput {
        id: id.into(),
        transport: Some("stdio".into()),
        command: Some("npx".into()),
        args: Some(vec!["-y".into(), "server".into()]),
        ..Default::default()
    }
}

#[test]
fn validation_accepts_http_endpoints_and_rejects_bad_ids() {
    assert!(!valid_id("1files"));
    assert!(check_url("http://localhost:3000/mcp").is_ok());
    assert!(check_url("http://192.168.1.20:8080/mcp").is_ok());
    assert!(check_url("https://example.com/mcp").is_ok());
    assert!(check_url("ftp://example.com/mcp").is_err());
    let mut config = McpConfig {
        id: "files".into(),
        label: "Files".into(),
        transport: "stdio".into(),
        command: Some("node..bin".into()),
        ..Default::default()
    };
    assert!(McpServerRegistry::validate_config(&config).is_err());
    config.command = Some("node".into());
    assert!(McpServerRegistry::validate_config(&config).is_ok());
    config.timeout_seconds = Some(0);
    assert!(McpServerRegistry::validate_config(&config).is_err());
    config.timeout_seconds = Some(601);
    assert!(McpServerRegistry::validate_config(&config).is_err());
    config.timeout_seconds = Some(60);
    assert!(McpServerRegistry::validate_config(&config).is_ok());
}

#[test]
fn config_round_trips_without_activation_fields() {
    let config = McpConfig {
        id: "files".into(),
        label: "Files".into(),
        transport: "stdio".into(),
        command: Some("npx".into()),
        ..Default::default()
    };
    let raw = serde_json::to_string(&config).unwrap();
    assert!(!raw.contains("enabled"));
    assert_eq!(serde_json::from_str::<McpConfig>(&raw).unwrap().id, "files");
}

#[test]
fn clearing_a_custom_timeout_restores_the_default() {
    // A global server is written to the global capability root, which is the
    // real home directory unless a test repoints it. Parallel tests do repoint
    // it, so this case has to take the same lock or it reads their directory.
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let mut initial = stdio("slow-server");
        initial.timeout_seconds = Some(Some(45));
        let saved = registry.upsert(initial).unwrap();
        assert_eq!(saved.timeout_seconds, Some(45));

        let preserve = serde_json::from_value(serde_json::json!({ "id": "slow-server" })).unwrap();
        let preserved = registry.upsert(preserve).unwrap();
        assert_eq!(preserved.timeout_seconds, Some(45));

        let clear = serde_json::from_value(serde_json::json!({
            "id": "slow-server",
            "timeoutSeconds": null
        }))
        .unwrap();
        let updated = registry.upsert(clear).unwrap();

        assert_eq!(updated.timeout_seconds, None);
    });
}

#[test]
fn disabled_project_server_shadows_global_server() {
    let global = McpServerRecord {
        id: "files".into(),
        label: "Files".into(),
        level: Some("global".into()),
        project_path: None,
        path: None,
        description: None,
        transport: "stdio".into(),
        command: Some("npx".into()),
        args: Vec::new(),
        env: BTreeMap::new(),
        url: None,
        headers: BTreeMap::new(),
        timeout_seconds: None,
        enabled: true,
        scope: ActivationScope::default(),
        config_hash: None,
        approval: None,
        created_at: String::new(),
        updated_at: String::new(),
    };
    let mut project = global.clone();
    project.level = Some("project".into());
    project.project_path = Some("/repo".into());
    project.enabled = false;

    let active = merge_active_records(vec![global], vec![project]);
    assert!(active.is_empty());
}

#[test]
fn project_server_is_copied_and_state_is_pruned_after_removal() {
    let dir = tempdir().unwrap();
    let project_path = dir.path().to_str().unwrap().to_string();
    let mut registry = McpServerRegistry::new(dir.path());
    let mut first = stdio("files");
    first.label = Some("Files".into());
    first.level = Some("project".into());
    first.project_path = Some(project_path.clone());
    let record = registry.upsert(first).unwrap();
    let normalized_project = crate::agent_capabilities::normalize_project_path(&project_path);
    let target = crate::agent_capabilities::capability_dir(
        CapabilityLevel::Project,
        Some(&normalized_project),
        "servers",
    )
    .unwrap()
    .join("files.json");
    assert_eq!(record.path.as_deref(), target.to_str());
    assert!(!fs::read_to_string(&target).unwrap().contains("enabled"));

    let mut duplicate = stdio("other");
    duplicate.label = Some("files".into());
    duplicate.level = Some("project".into());
    duplicate.project_path = Some(project_path.clone());
    assert!(registry.upsert(duplicate).is_err());

    let disabled = registry
        .set_enabled(
            "files",
            false,
            Some(CapabilityLevel::Project),
            Some(&project_path),
        )
        .unwrap()
        .unwrap();
    assert!(!disabled.enabled);
    assert!(!registry.state.enabled(
        MCP_KIND,
        CapabilityLevel::Project,
        "files",
        Some(&project_path)
    ));

    assert!(registry
        .remove("files", Some(CapabilityLevel::Project), Some(&project_path))
        .unwrap());
    assert!(!target.exists());
    assert!(registry.state.enabled(
        MCP_KIND,
        CapabilityLevel::Project,
        "files",
        Some(&project_path)
    ));
}

#[test]
fn a_global_server_moves_into_a_project_with_its_state() {
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let mut input = stdio("files");
        input.label = Some("Files".into());
        registry.upsert(input).unwrap();
        // Turned off for this one project only, which is the value a move
        // has to carry because it is what the user was looking at.
        registry
            .set_enabled(
                "files",
                false,
                Some(CapabilityLevel::Global),
                Some(&project_path),
            )
            .unwrap();

        let moved = registry
            .transfer(
                "files",
                &CapabilityTarget::new(CapabilityLevel::Global, Some(&project_path)).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap();

        assert_eq!(moved.level.as_deref(), Some("project"));
        assert_eq!(
            moved.project_path.as_deref(),
            Some(crate::agent_capabilities::normalize_project_path(&project_path).as_str())
        );
        assert!(!moved.enabled);
        assert!(!home.path().join("servers/files.json").exists());
        assert!(project.path().join(".agents/servers/files.json").is_file());
        assert!(registry
            .list(CapabilityLevel::Global, None)
            .unwrap()
            .is_empty());
        // The global override is gone with the document, not left pointing
        // at an id the global directory no longer holds.
        assert!(registry.state.enabled(
            MCP_KIND,
            CapabilityLevel::Global,
            "files",
            Some(&project_path)
        ));
    });
}

#[test]
fn a_destination_collision_renames_the_arriving_server() {
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let mut global = stdio("files");
        global.label = Some("Files".into());
        registry.upsert(global).unwrap();
        let mut local = stdio("files");
        local.label = Some("Files".into());
        local.level = Some("project".into());
        local.project_path = Some(project_path.clone());
        registry.upsert(local).unwrap();

        let moved = registry
            .transfer(
                "files",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap();

        assert_eq!(moved.id, "files-2");
        assert_eq!(moved.label, "Files (2)");
        assert!(!home.path().join("servers/files.json").exists());
        let listed = registry
            .list(CapabilityLevel::Project, Some(&project_path))
            .unwrap();
        assert_eq!(listed.len(), 2);
        // The server that was already there is untouched.
        assert!(listed
            .iter()
            .any(|record| record.id == "files" && record.label == "Files"));
        let document =
            fs::read_to_string(project.path().join(".agents/servers/files-2.json")).unwrap();
        assert!(document.contains("\"id\": \"files-2\""));
        assert!(document.contains("\"label\": \"Files (2)\""));
    });
}

#[test]
fn a_project_server_moves_to_global_without_leaving_a_project_override() {
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let mut input = stdio("files");
        input.label = Some("Files".into());
        input.level = Some("project".into());
        input.project_path = Some(project_path.clone());
        input.enabled = Some(false);
        registry.upsert(input).unwrap();

        let moved = registry
            .transfer(
                "files",
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
            )
            .unwrap();

        assert_eq!(moved.level.as_deref(), Some("global"));
        assert_eq!(moved.project_path, None);
        assert!(!moved.enabled);
        assert!(home.path().join("servers/files.json").is_file());
        assert!(!project.path().join(".agents/servers/files.json").exists());
        // The disabled state is now the global default: it follows the
        // document, and no project-only entry is left behind.
        assert!(!registry.state.enabled(
            MCP_KIND,
            CapabilityLevel::Global,
            "files",
            Some("/elsewhere")
        ));
        assert!(registry.state.enabled(
            MCP_KIND,
            CapabilityLevel::Project,
            "files",
            Some(&project_path)
        ));
    });
}

#[test]
fn transferring_within_one_directory_changes_nothing() {
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let mut input = stdio("files");
        input.label = Some("Files".into());
        input.level = Some("project".into());
        input.project_path = Some(project_path.clone());
        registry.upsert(input).unwrap();

        let target = CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap();
        let same = registry.transfer("files", &target, &target).unwrap();
        assert_eq!(same.id, "files");
        assert!(project.path().join(".agents/servers/files.json").is_file());
    });
}

#[test]
fn transferring_an_unknown_server_is_an_error() {
    let (home, app, _project) = scaffolding();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let error = registry
            .transfer(
                "missing",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
            )
            .unwrap_err();
        assert!(error.to_string().contains("MCP_INVALID"));
    });
}

#[test]
fn a_case_differing_id_at_the_destination_is_not_overwritten() {
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let mut global = stdio("files");
        global.label = Some("Files".into());
        registry.upsert(global).unwrap();
        let mut local = stdio("FILES");
        local.label = Some("Uppercase files".into());
        local.level = Some("project".into());
        local.project_path = Some(project_path.clone());
        registry.upsert(local).unwrap();
        let existing =
            fs::read_to_string(project.path().join(".agents/servers/FILES.json")).unwrap();

        let moved = registry
            .transfer(
                "files",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap();

        // `FILES` and `files` are the same file on macOS and Windows, so the
        // arriving server must take a genuinely free id instead.
        assert_eq!(moved.id, "files-2");
        assert!(!home.path().join("servers/files.json").exists());
        assert_eq!(
            fs::read_to_string(project.path().join(".agents/servers/FILES.json")).unwrap(),
            existing
        );
        assert!(project
            .path()
            .join(".agents/servers/files-2.json")
            .is_file());
        let listed = registry
            .list(CapabilityLevel::Project, Some(&project_path))
            .unwrap();
        assert_eq!(listed.len(), 2);
    });
}

#[test]
fn a_rename_never_writes_over_a_file_the_scan_does_not_list() {
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let mut global = stdio("files");
        global.label = Some("Files".into());
        registry.upsert(global).unwrap();
        // Two project entries: one listed server whose label forces the
        // arriving server to rename, plus an unparseable file that occupies
        // the destination path without appearing in any scan.
        let mut local = stdio("other");
        local.label = Some("Files".into());
        local.level = Some("project".into());
        local.project_path = Some(project_path.clone());
        registry.upsert(local).unwrap();
        let bogus = project.path().join(".agents/servers/files.json");
        fs::write(&bogus, "not a server config").unwrap();

        let error = registry
            .transfer(
                "files",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap_err();

        assert!(error.to_string().contains("MCP_INVALID"));
        assert_eq!(fs::read_to_string(&bogus).unwrap(), "not a server config");
        // The move refused before deleting anything.
        assert!(home.path().join("servers/files.json").is_file());
    });
}

#[test]
fn moving_one_projects_server_to_global_keeps_another_projects_state() {
    let (home, app, project) = scaffolding();
    let other = tempdir().unwrap();
    let project_a = project.path().to_str().unwrap().to_string();
    let project_b = other.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let mut a = stdio("files");
        a.label = Some("Files".into());
        a.level = Some("project".into());
        a.project_path = Some(project_a.clone());
        a.enabled = Some(false);
        registry.upsert(a).unwrap();
        let mut b = stdio("files");
        b.label = Some("Files".into());
        b.level = Some("project".into());
        b.project_path = Some(project_b.clone());
        b.enabled = Some(false);
        registry.upsert(b).unwrap();

        registry
            .transfer(
                "files",
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_a)).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
            )
            .unwrap();

        // Project B's document and its disabled state survive: moving A's
        // same-id server says nothing about B.
        assert!(other.path().join(".agents/servers/files.json").is_file());
        assert!(!registry.state.enabled(
            MCP_KIND,
            CapabilityLevel::Project,
            "files",
            Some(&project_b)
        ));
        assert!(registry.state.enabled(
            MCP_KIND,
            CapabilityLevel::Project,
            "files",
            Some(&project_a)
        ));
        assert!(!registry
            .state
            .enabled(MCP_KIND, CapabilityLevel::Global, "files", None));
    });
}

/// Drop a server document into a project the way a cloned repository would,
/// without going through the app.
fn plant_project_server(project: &Path, id: &str, command: &str) -> std::path::PathBuf {
    let dir = project.join(".agents/servers");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{id}.json"));
    fs::write(
        &path,
        serde_json::json!({
            "id": id,
            "label": id,
            "transport": "stdio",
            "command": command,
            "args": ["-c", "echo hi"],
        })
        .to_string(),
    )
    .unwrap();
    path
}

fn project_record(
    registry: &mut McpServerRegistry,
    project_path: &str,
    id: &str,
) -> McpServerRecord {
    registry
        .list(CapabilityLevel::Project, Some(project_path))
        .unwrap()
        .into_iter()
        .find(|record| record.id == id)
        .unwrap()
}

#[test]
fn a_repository_provided_project_server_is_not_enabled_until_approved() {
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        plant_project_server(project.path(), "evil", "sh");

        let record = project_record(&mut registry, &project_path, "evil");
        assert!(!record.enabled);
        assert_eq!(record.approval, Some(McpApproval::Pending));
        assert!(record
            .config_hash
            .as_deref()
            .is_some_and(|hash| hash.starts_with("sha256:")));
        assert!(registry.active_for(Some(&project_path)).unwrap().is_empty());

        // The plain switch cannot bypass review.
        let error = registry
            .set_enabled(
                "evil",
                true,
                Some(CapabilityLevel::Project),
                Some(&project_path),
            )
            .unwrap_err();
        assert!(error.to_string().contains("MCP_INVALID"));
        assert!(registry.active_for(Some(&project_path)).unwrap().is_empty());
    });
}

#[test]
fn an_approved_project_server_runs_while_its_hash_matches() {
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        plant_project_server(project.path(), "tools", "node");
        let pending = project_record(&mut registry, &project_path, "tools");

        let approved = registry
            .approve(
                "tools",
                &project_path,
                pending.config_hash.as_deref().unwrap(),
            )
            .unwrap()
            .unwrap();
        assert!(approved.enabled);
        assert_eq!(approved.approval, Some(McpApproval::Approved));
        let active = registry.active_for(Some(&project_path)).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "tools");

        // The approval survives a restart: it lives in the app-local state.
        let mut reopened = McpServerRegistry::new(app.path());
        assert_eq!(reopened.active_for(Some(&project_path)).unwrap().len(), 1);

        // Switching it off and on again needs no second review.
        reopened
            .set_enabled(
                "tools",
                false,
                Some(CapabilityLevel::Project),
                Some(&project_path),
            )
            .unwrap();
        assert!(reopened.active_for(Some(&project_path)).unwrap().is_empty());
        reopened
            .set_enabled(
                "tools",
                true,
                Some(CapabilityLevel::Project),
                Some(&project_path),
            )
            .unwrap();
        assert_eq!(reopened.active_for(Some(&project_path)).unwrap().len(), 1);
    });
}

#[test]
fn changing_an_approved_project_server_requires_approval_again() {
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        plant_project_server(project.path(), "tools", "node");
        let pending = project_record(&mut registry, &project_path, "tools");
        let reviewed_hash = pending.config_hash.clone().unwrap();
        registry
            .approve("tools", &project_path, &reviewed_hash)
            .unwrap();

        // A later pull swaps the command.
        plant_project_server(project.path(), "tools", "sh");
        let changed = project_record(&mut registry, &project_path, "tools");
        assert!(!changed.enabled);
        assert_eq!(changed.approval, Some(McpApproval::Changed));
        assert_ne!(changed.config_hash.as_deref(), Some(reviewed_hash.as_str()));
        assert!(registry.active_for(Some(&project_path)).unwrap().is_empty());

        // The old review cannot be replayed against the new content.
        assert!(registry
            .approve("tools", &project_path, &reviewed_hash)
            .is_err());
        let current = changed.config_hash.unwrap();
        assert!(
            registry
                .approve("tools", &project_path, &current)
                .unwrap()
                .unwrap()
                .enabled
        );
    });
}

#[test]
fn a_state_file_from_before_approvals_reads_every_project_server_as_pending() {
    // A state file written by an earlier release: one explicit off for a
    // project server, and nothing for another. Neither is approved.
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    let normalized = crate::agent_capabilities::normalize_project_path(&project_path);
    let off_key = serde_json::json!({
        "kind": "mcp", "level": "project", "id": "off", "project_path": normalized,
    })
    .to_string();
    fs::create_dir_all(app.path().join("agent-capabilities")).unwrap();
    fs::write(
        app.path().join("agent-capabilities/mcp.json"),
        serde_json::json!({ "values": { off_key: false } }).to_string(),
    )
    .unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        plant_project_server(project.path(), "off", "node");
        plant_project_server(project.path(), "fresh", "node");
        let off = project_record(&mut registry, &project_path, "off");
        let fresh = project_record(&mut registry, &project_path, "fresh");
        assert!(!off.enabled);
        assert!(!fresh.enabled);
        assert_eq!(off.approval, Some(McpApproval::Pending));
        assert_eq!(fresh.approval, Some(McpApproval::Pending));
    });
}

#[test]
fn a_project_server_written_through_the_app_is_approved_as_written() {
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let mut input = stdio("mine");
        input.level = Some("project".into());
        input.project_path = Some(project_path.clone());
        let saved = registry.upsert(input).unwrap();
        assert!(saved.enabled);
        assert_eq!(saved.approval, Some(McpApproval::Approved));

        // Editing a repository-provided server that is still pending does not
        // approve the fields the edit carried over.
        plant_project_server(project.path(), "planted", "sh");
        let edit = serde_json::from_value(serde_json::json!({
            "id": "planted",
            "label": "Renamed",
            "level": "project",
            "projectPath": project_path,
        }))
        .unwrap();
        let edited = registry.upsert(edit).unwrap();
        assert!(!edited.enabled);
        assert_eq!(edited.approval, Some(McpApproval::Pending));
    });
}

#[test]
fn global_servers_are_unaffected_by_project_approval() {
    let (home, app, _project) = scaffolding();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        let saved = registry.upsert(stdio("global-one")).unwrap();
        assert!(saved.enabled);
        assert_eq!(saved.approval, None);
        assert_eq!(saved.config_hash, None);
    });
}

#[test]
fn approval_hash_ignores_presentation_but_covers_execution_fields() {
    let base = McpConfig {
        id: "a".into(),
        label: "A".into(),
        transport: "stdio".into(),
        command: Some("node".into()),
        args: vec!["server.js".into()],
        ..Default::default()
    };
    let mut renamed = base.clone();
    renamed.id = "b".into();
    renamed.label = "B".into();
    renamed.description = Some("other".into());
    assert_eq!(config_hash(&base), config_hash(&renamed));
    for change in [
        |c: &mut McpConfig| c.command = Some("sh".into()),
        |c: &mut McpConfig| c.args.push("--evil".into()),
        |c: &mut McpConfig| {
            c.env.insert("NODE_OPTIONS".into(), "--require x".into());
        },
        |c: &mut McpConfig| c.url = Some("https://example.com".into()),
        |c: &mut McpConfig| {
            c.headers.insert("X-Key".into(), "v".into());
        },
        |c: &mut McpConfig| c.transport = "http".into(),
    ] {
        let mut changed = base.clone();
        change(&mut changed);
        assert_ne!(config_hash(&base), config_hash(&changed));
    }
}

#[test]
fn a_running_global_server_moved_into_a_project_stays_approved() {
    let (home, app, project) = scaffolding();
    let project_path = project.path().to_str().unwrap().to_string();
    test_support::with_global_agents(home.path(), || {
        let mut registry = McpServerRegistry::new(app.path());
        registry.upsert(stdio("files")).unwrap();
        let moved = registry
            .transfer(
                "files",
                &CapabilityTarget::new(CapabilityLevel::Global, Some(&project_path)).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap();
        assert!(moved.enabled);
        assert_eq!(moved.approval, Some(McpApproval::Approved));
    });
}
