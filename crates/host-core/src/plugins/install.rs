use super::*;

impl PluginManager {
    pub fn install_from_path(
        &mut self,
        source_path: &str,
        opts: InstallOptions,
    ) -> Result<InstallResult> {
        let source = PathBuf::from(source_path);
        if !source.exists() {
            bail!("PLUGIN_INVALID: package path missing");
        }

        let stage = self
            .data_dir
            .join("plugins/cache/download")
            .join(format!("stage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&stage)?;
        let cleanup_stage = stage.clone();
        let result = (|| -> Result<InstallResult> {
            let extracted_root = if source.is_dir() {
                copy_dir_filtered(&source, &stage.join("content"))?;
                stage.join("content")
            } else {
                let bytes = fs::read(&source)
                    .with_context(|| format!("read package {}", source.display()))?;
                if bytes.len() as u64 > MAX_PACKAGE_BYTES {
                    bail!("PLUGIN_INVALID: package exceeds 50MB limit");
                }
                if let Some(expected) = &opts.expected_shasum {
                    let actual = sha256_hex(&bytes);
                    if !actual.eq_ignore_ascii_case(expected) {
                        bail!("PLUGIN_INTEGRITY: checksum mismatch");
                    }
                }
                let extract_dir = stage.join("extract");
                fs::create_dir_all(&extract_dir)?;
                extract_zip_bytes(&bytes, &extract_dir)?;
                find_plugin_root(&extract_dir)?
            };

            let manifest = Self::read_manifest(&extracted_root)?;
            let existing = self.get(&manifest.id);
            let upgraded = existing
                .as_ref()
                .map(|p| p.version != manifest.version)
                .unwrap_or(false);
            let permission_diff = permission_diff(
                existing
                    .as_ref()
                    .map(|p| p.permissions.as_slice())
                    .unwrap_or(&[]),
                &manifest.permissions,
            );

            if upgraded {
                if let Some(prev) = &existing {
                    if let Some(prev_path) = prev.path.as_ref() {
                        let backup = self
                            .data_dir
                            .join("plugins/cache/backup")
                            .join(sanitize_id(&prev.id))
                            .join(&prev.version);
                        let _ = fs::remove_dir_all(&backup);
                        if PathBuf::from(prev_path).exists() {
                            copy_dir_filtered(Path::new(prev_path), &backup)?;
                        }
                    }
                }
            }

            let target = self.installed_dir(&manifest.id);
            if target.exists() {
                fs::remove_dir_all(&target)?;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            copy_dir_filtered(&extracted_root, &target)?;
            fs::create_dir_all(self.data_dir_for(&manifest.id))?;

            let now = Utc::now().to_rfc3339();
            let granted = opts
                .granted_permissions
                .clone()
                .unwrap_or_else(|| manifest.permissions.clone());
            for required in &manifest.permissions {
                if !granted.iter().any(|g| g == required) {
                    bail!("PLUGIN_PERMISSION_DENIED: missing grant for {required}");
                }
            }

            let summary = PluginSummary {
                id: manifest.id.clone(),
                name: manifest.name.clone(),
                version: manifest.version.clone(),
                enabled: opts.enable,
                // An update must not silently widen a project-scoped plugin
                // back to every project.
                scope: existing
                    .as_ref()
                    .map(|p| p.scope.clone())
                    .unwrap_or_default(),
                source: opts.source.clone(),
                bundled: self.bundled_ids.contains(&manifest.id),
                status: if opts.enable {
                    "ready".into()
                } else {
                    "disabled".into()
                },
                error_message: None,
                permissions: granted,
                path: Some(target.to_string_lossy().to_string()),
                capabilities: derive_capabilities(&manifest),
                description: manifest.description.clone(),
                author: manifest.author.clone(),
                installed_at: existing
                    .as_ref()
                    .and_then(|p| p.installed_at.clone())
                    .or_else(|| Some(now.clone())),
                updated_at: Some(now),
                // A local package carries no distribution metadata; whatever a
                // previous install recorded no longer describes these bytes.
                marketplace: None,
                ui: manifest.ui.clone(),
                fs: manifest.fs.clone(),
                settings: derive_settings(&manifest),
                i18n: manifest.i18n.clone(),
            };
            let plugin = self.upsert_summary(summary)?;
            Ok(InstallResult {
                plugin,
                upgraded,
                permission_diff,
            })
        })();

        let _ = fs::remove_dir_all(cleanup_stage);
        result
    }

    pub fn install_from_package(
        &mut self,
        package_path: &str,
        opts: InstallOptions,
    ) -> Result<InstallResult> {
        self.install_from_path(package_path, opts)
    }
}

pub(crate) fn extract_zip_bytes(bytes: &[u8], dest: &Path) -> Result<()> {
    if bytes.len() < 22 {
        bail!("PLUGIN_INVALID: zip too small");
    }
    let mut file_count = 0usize;
    let mut total_bytes = 0u64;
    let mut offset = 0usize;
    while offset + 30 <= bytes.len() {
        let sig = read_u32(bytes, offset)?;
        if sig == 0x02014b50 || sig == 0x06054b50 {
            break;
        }
        if sig != 0x04034b50 {
            bail!("PLUGIN_INVALID: bad zip local header");
        }
        let method = read_u16(bytes, offset + 8)?;
        let comp_size = read_u32(bytes, offset + 18)? as usize;
        let uncomp_size = read_u32(bytes, offset + 22)? as u64;
        let name_len = read_u16(bytes, offset + 26)? as usize;
        let extra_len = read_u16(bytes, offset + 28)? as usize;
        let name_start = offset + 30;
        let name_end = name_start + name_len;
        if name_end + extra_len + comp_size > bytes.len() {
            bail!("PLUGIN_INVALID: zip entry truncated");
        }
        let name = std::str::from_utf8(&bytes[name_start..name_end])
            .map_err(|_| anyhow!("PLUGIN_INVALID: zip name not utf8"))?;
        if method != 0 {
            bail!("PLUGIN_INVALID: only store-compressed piplug supported");
        }
        let data_start = name_end + extra_len;
        let data_end = data_start + comp_size;
        let data = &bytes[data_start..data_end];
        total_bytes += uncomp_size;
        if total_bytes > MAX_PACKAGE_BYTES {
            bail!("PLUGIN_INVALID: package exceeds 50MB limit");
        }
        file_count += 1;
        if file_count > MAX_PACKAGE_FILES {
            bail!("PLUGIN_INVALID: too many files in package");
        }
        if name.ends_with('/') {
            let dir = safe_join(dest, name)?;
            fs::create_dir_all(dir)?;
        } else {
            let path = safe_join(dest, name)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(path, data)?;
        }
        offset = data_end;
    }
    Ok(())
}

pub(crate) fn find_plugin_root(extract_dir: &Path) -> Result<PathBuf> {
    let direct = extract_dir.join("manifest.json");
    if direct.exists() {
        return Ok(extract_dir.to_path_buf());
    }
    for entry in fs::read_dir(extract_dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            let candidate = entry.path();
            if candidate.join("manifest.json").exists() {
                return Ok(candidate);
            }
        }
    }
    bail!("PLUGIN_INVALID: manifest.json missing in package")
}

pub(crate) fn copy_dir_filtered(src: &Path, dest: &Path) -> Result<()> {
    fs::create_dir_all(dest)?;
    let mut file_count = 0usize;
    let mut total_bytes = 0u64;
    fn walk(from: &Path, to: &Path, file_count: &mut usize, total_bytes: &mut u64) -> Result<()> {
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str == ".git" || name_str == "node_modules" {
                continue;
            }
            let target = to.join(&name);
            if file_type.is_symlink() {
                bail!("PLUGIN_INVALID: symlinks are not allowed");
            } else if file_type.is_dir() {
                fs::create_dir_all(&target)?;
                walk(&entry.path(), &target, file_count, total_bytes)?;
            } else if file_type.is_file() {
                *file_count += 1;
                if *file_count > MAX_PACKAGE_FILES {
                    bail!("PLUGIN_INVALID: too many files in package");
                }
                let meta = entry.metadata()?;
                *total_bytes += meta.len();
                if *total_bytes > MAX_PACKAGE_BYTES {
                    bail!("PLUGIN_INVALID: package exceeds 50MB limit");
                }
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(entry.path(), &target)?;
            }
        }
        Ok(())
    }
    walk(src, dest, &mut file_count, &mut total_bytes)
}

pub(crate) fn safe_join(base: &Path, rel: &str) -> Result<PathBuf> {
    let rel = rel.replace('\\', "/");
    if rel.starts_with('/') || rel.contains(':') {
        bail!("PLUGIN_INVALID: absolute paths are not allowed");
    }
    let mut out = base.to_path_buf();
    for comp in Path::new(&rel).components() {
        match comp {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            Component::ParentDir => bail!("PLUGIN_INVALID: path traversal is not allowed"),
            _ => bail!("PLUGIN_INVALID: unsupported path component"),
        }
    }
    if !out.starts_with(base) {
        bail!("PLUGIN_INVALID: path escaped package root");
    }
    Ok(out)
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub(crate) fn read_u16(bytes: &[u8], offset: usize) -> Result<u16> {
    let slice = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| anyhow!("PLUGIN_INVALID: zip truncated"))?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

pub(crate) fn read_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| anyhow!("PLUGIN_INVALID: zip truncated"))?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}
