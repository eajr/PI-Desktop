//! Content-bound approval for project skills.
//!
//! A project's `.agents/skills` arrives with whatever repository the user
//! opened, and a skill's name, description and body all reach the model. A
//! project skill is therefore listed as inactive until the user approves the
//! exact `SKILL.md` bytes; the scan in the parent module compares the stored
//! hash on every read, so an edit after approval deactivates it again.
use super::*;

impl UserSkillRegistry {
    /// Approve one project skill's current document and switch it on.
    ///
    /// `content_hash` is the hash of the document the user was shown. If the
    /// file changed since, the approval is refused rather than applied to
    /// content nobody reviewed.
    pub fn approve(
        &mut self,
        id: &str,
        project_path: &str,
        content_hash: &str,
    ) -> Result<Option<UserSkillRecord>> {
        let Some(record) = self.find(id, Some(CapabilityLevel::Project), Some(project_path))?
        else {
            return Ok(None);
        };
        if record.content_hash.as_deref() != Some(content_hash) {
            bail!("SKILL_INVALID: project skill \"{id}\" changed since it was reviewed; review it again");
        }
        self.state.approve(
            SKILL_KIND,
            CapabilityLevel::Project,
            &record.id,
            Some(project_path),
            content_hash,
        )?;
        self.find(
            &record.id,
            Some(CapabilityLevel::Project),
            Some(project_path),
        )
    }

    /// A project skill the user writes or imports through the app is content
    /// the user chose, so it is approved as written. One saved as disabled (a
    /// config-sync copy of a skill that was not active on its origin device,
    /// for one) waits for review, so switching it on later always shows the
    /// text first.
    pub(super) fn approve_authored(
        &mut self,
        level: CapabilityLevel,
        id: &str,
        project_path: Option<&str>,
        enabled: Option<bool>,
    ) -> Result<()> {
        if level != CapabilityLevel::Project || enabled == Some(false) {
            return Ok(());
        }
        let Some(hash) = self
            .find(id, Some(level), project_path)?
            .and_then(|record| record.content_hash)
        else {
            return Ok(());
        };
        self.state
            .approve(SKILL_KIND, level, id, project_path, &hash)
    }

    /// An edit to an approved project skill is the user's own text, so it
    /// stays approved, and a skill the user had switched off stays off.
    /// Editing one still awaiting review does not approve it: whatever the
    /// edit left alone came from a document the user may never have read.
    pub(super) fn keep_edit_approved(
        &mut self,
        record: &UserSkillRecord,
        document: &[u8],
    ) -> Result<()> {
        if record.approval != Some(ContentApproval::Approved) {
            return Ok(());
        }
        let project_path = record.project_path.as_deref();
        self.state.approve(
            SKILL_KIND,
            CapabilityLevel::Project,
            &record.id,
            project_path,
            &content_hash(document),
        )?;
        if !record.enabled {
            self.state.set_enabled(
                SKILL_KIND,
                CapabilityLevel::Project,
                &record.id,
                project_path,
                false,
            )?;
        }
        Ok(())
    }

    /// Refuse to switch on a project skill whose current document is not the
    /// one the user approved; approval is the only way to activate it.
    pub(super) fn ensure_approved_to_enable(
        &self,
        record: &UserSkillRecord,
        enabled: bool,
    ) -> Result<()> {
        if enabled
            && record
                .approval
                .is_some_and(|approval| approval != ContentApproval::Approved)
        {
            bail!(
                "SKILL_INVALID: project skill \"{}\" must be approved before it can be used",
                record.id
            );
        }
        Ok(())
    }
}
