import { useTranslation } from "react-i18next";
import type { UserSkillRecord } from "@pi-desktop/shared";
import { CapabilityButton } from "./AgentCapabilityLayout";

/** True when a project skill must be reviewed before the agent can see it. */
export function skillAwaitingApproval(skill: UserSkillRecord): boolean {
  return skill.level === "project" && skill.approval !== "approved";
}

/** The document a review shows, with the hash of exactly those bytes. */
export type SkillReview = {
  name: string;
  description?: string;
  body: string;
  contentHash: string;
};

/**
 * Review block for a project skill that came with the repository.
 *
 * The skill's name, description and body all reach the model, so approving is
 * consent to exactly that text. The block first loads the document; the
 * approve action then sends back the hash read together with the text shown
 * here, so a file changed while this was on screen is refused.
 */
export function SkillApprovalReview({
  skill,
  review,
  busy,
  onLoad,
  onApprove,
}: {
  skill: UserSkillRecord;
  review: SkillReview | null;
  busy: boolean;
  onLoad: () => void;
  onApprove: (contentHash: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="agent-capability-approval" role="group" aria-label={skill.name || skill.id}>
      <p className="agent-capability-approval-notice">
        {skill.approval === "changed"
          ? t("settings.skillApproval.changedNotice")
          : t("settings.skillApproval.pendingNotice")}
      </p>
      {review ? (
        <>
          <dl className="agent-capability-approval-fields">
            <div className="agent-capability-approval-field">
              <dt>name</dt>
              <dd>
                <code>{review.name}</code>
              </dd>
            </div>
            {review.description ? (
              <div className="agent-capability-approval-field">
                <dt>description</dt>
                <dd>
                  <code>{review.description}</code>
                </dd>
              </div>
            ) : null}
            <div className="agent-capability-approval-field">
              <dt>SKILL.md</dt>
              <dd>
                <code className="agent-capability-approval-document">{review.body}</code>
              </dd>
            </div>
          </dl>
          <div>
            <CapabilityButton
              variant="primary"
              disabled={busy}
              onClick={() => onApprove(review.contentHash)}
            >
              {t("settings.skillApproval.approve")}
            </CapabilityButton>
          </div>
        </>
      ) : (
        <div>
          <CapabilityButton disabled={busy} onClick={onLoad}>
            {t("settings.skillApproval.show")}
          </CapabilityButton>
        </div>
      )}
    </div>
  );
}
