import { useTranslation } from "react-i18next";
import type { McpServerRecord } from "@pi-desktop/shared";
import { CapabilityButton } from "./AgentCapabilityLayout";

/** True when a project server must be reviewed before it can run. */
export function mcpAwaitingApproval(server: McpServerRecord): boolean {
  return server.level === "project" && server.approval !== "approved";
}

function entries(values: Record<string, string> | undefined): string[] {
  return Object.entries(values ?? {}).map(([key, value]) => `${key}=${value}`);
}

/**
 * Review block for a project server that came with the repository.
 *
 * It shows every field that decides what runs or where it connects — the full
 * command line, environment, URL and headers — because approving is consent to
 * exactly that content. The approve action sends back the hash of the record
 * shown here, so a file changed while this was on screen is refused.
 */
export function McpApprovalReview({
  server,
  busy,
  onApprove,
}: {
  server: McpServerRecord;
  busy: boolean;
  onApprove: () => void;
}) {
  const { t } = useTranslation();
  const isHttp = server.transport === "http";
  const commandLine = [server.command ?? "", ...(server.args ?? [])]
    .filter((part) => part.length > 0)
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
  const rows: Array<{ label: string; values: string[] }> = isHttp
    ? [
        { label: t("settings.mcpApproval.url"), values: server.url ? [server.url] : [] },
        { label: t("settings.mcpApproval.headers"), values: entries(server.headers) },
      ]
    : [
        { label: t("settings.mcpApproval.command"), values: commandLine ? [commandLine] : [] },
        { label: t("settings.mcpApproval.env"), values: entries(server.env) },
      ];
  return (
    <div className="agent-capability-approval" role="group" aria-label={server.label || server.id}>
      <p className="agent-capability-approval-notice">
        {server.approval === "changed"
          ? t("settings.mcpApproval.changedNotice")
          : t("settings.mcpApproval.pendingNotice")}
      </p>
      <dl className="agent-capability-approval-fields">
        {rows
          .filter((row) => row.values.length > 0)
          .map((row) => (
            <div key={row.label} className="agent-capability-approval-field">
              <dt>{row.label}</dt>
              {row.values.map((value) => (
                <dd key={value}>
                  <code>{value}</code>
                </dd>
              ))}
            </div>
          ))}
      </dl>
      <div>
        <CapabilityButton variant="primary" disabled={busy || !server.configHash} onClick={onApprove}>
          {t("settings.mcpApproval.approve")}
        </CapabilityButton>
      </div>
    </div>
  );
}
