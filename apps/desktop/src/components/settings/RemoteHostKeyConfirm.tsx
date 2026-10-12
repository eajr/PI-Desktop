/**
 * Host-key confirmation for the SSH install form (ADR 0328).
 *
 * Shown when main refuses a first connection with `SSH_HOST_KEY_UNKNOWN`. The
 * user compares the SHA-256 fingerprint with the one the server's
 * administrator sees; only "Trust and install" sends those exact fingerprints
 * back, and main records the key only if the server still presents them.
 * Cancelling sends nothing and records nothing.
 */
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteHostKeyPrompt } from "../../lib/remote-host-errors";
import { Button } from "../ui";

export function RemoteHostKeyConfirm({
  prompt,
  busy,
  onTrust,
  onCancel,
}: {
  prompt: RemoteHostKeyPrompt;
  busy: boolean;
  onTrust: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  // Focus lands on the safe choice, so Enter never trusts a key by accident.
  useEffect(() => { cancelRef.current?.focus(); }, []);
  const host = prompt.port !== undefined ? `${prompt.host}:${prompt.port}` : prompt.host;

  return (
    <div
      className="settings-remote-host-hostkey"
      role="alertdialog"
      aria-labelledby="settings-remote-host-hostkey-title"
      aria-describedby="settings-remote-host-hostkey-body"
    >
      <h4 id="settings-remote-host-hostkey-title" className="settings-card-heading">
        {t("settings.remoteHosts.hostKeyTitle")}
      </h4>
      <p id="settings-remote-host-hostkey-body" className="text-sm text-text-secondary">
        {t("settings.remoteHosts.hostKeyBody", { host })}
      </p>
      <dl className="settings-remote-host-hostkey-list">
        {prompt.keys.map((key) => (
          <div key={key.fingerprint}>
            <dt className="text-sm text-text-secondary">{key.type}</dt>
            <dd>
              <code className="select-all break-all">{key.fingerprint}</code>
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-text-secondary">{t("settings.remoteHosts.hostKeyVerify")}</p>
      <div className="settings-remote-host-form-actions">
        <Button ref={cancelRef} type="button" variant="secondary" disabled={busy} onClick={onCancel}>
          {t("settings.remoteHosts.hostKeyCancel")}
        </Button>
        <Button type="button" variant="primary" disabled={busy} onClick={onTrust}>
          {busy ? t("settings.remoteHosts.sshRunning") : t("settings.remoteHosts.hostKeyTrust")}
        </Button>
      </div>
    </div>
  );
}
