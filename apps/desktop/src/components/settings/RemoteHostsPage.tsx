/**
 * Settings destination for paired remote `pi-host` machines (R2b pairing UX,
 * ADR 0286 §Registry).
 *
 * Inventory of `<dataDir>/remote-hosts.json` plus one Add form: SSH install
 * first, URL + pairing token second. Instructional copy stays out of the
 * renderer. The destination is marked Experimental on the settings rail and
 * page title; pairing and SSH bootstrap still call the same IPC. A password
 * typed into the SSH form lives in this component's state only; it is never
 * persisted or logged here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteHostBootstrapRequest, RemoteHostSshAuth, RemoteHostSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { hostKeyPromptOf, remoteHostErrorKey, type RemoteHostKeyPrompt } from "../../lib/remote-host-errors";
import { useAppStore } from "../../stores/app-store";
import { Badge, Button, Field, Input, PasswordInput, SegmentedControl, cx } from "../ui";
import { RemoteHostSessions } from "./RemoteHostSessions";
import { RemoteHostKeyConfirm } from "./RemoteHostKeyConfirm";

type AddMode = "ssh" | "pair";

type PairForm = {
  url: string;
  pairingToken: string;
  label: string;
};

const EMPTY_FORM: PairForm = { url: "", pairingToken: "", label: "" };

function remoteHostStatusKey(host: RemoteHostSummary) {
  if (host.status === "connecting") return "settings.remoteHosts.statusConnecting";
  if (host.status === "reconnecting") return "settings.remoteHosts.statusReconnecting";
  if (host.status === "action-required") return "settings.remoteHosts.statusActionRequired";
  return host.connected ? "settings.remoteHosts.statusOnline" : "settings.remoteHosts.statusOffline";
}

type SshForm = {
  label: string;
  host: string;
  user: string;
  port: string;
  identityFile: string;
  auth: RemoteHostSshAuth;
  password: string;
};

const EMPTY_SSH_FORM: SshForm = {
  label: "",
  host: "",
  user: "",
  port: "",
  identityFile: "",
  auth: "key",
  password: "",
};

export function RemoteHostsPage() {
  const { t } = useTranslation();
  const { t: remoteT } = useTranslation("remote");
  const [selectedHost, setSelectedHost] = useState<RemoteHostSummary | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const alive = useRef(true);
  const refreshGeneration = useRef(0);
  const showToast = useAppStore((state) => state.showToast);
  const [hosts, setHosts] = useState<RemoteHostSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<PairForm>(EMPTY_FORM);
  const [pairing, setPairing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [sshForm, setSshForm] = useState<SshForm>(EMPTY_SSH_FORM);
  const [installing, setInstalling] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>("ssh");
  // A pending host-key confirmation and the exact request it was raised for;
  // trusting resends that request, so edits cannot slip in between.
  const [hostKeyPrompt, setHostKeyPrompt] = useState<
    { prompt: RemoteHostKeyPrompt; request: RemoteHostBootstrapRequest } | null
  >(null);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const result = await api.listRemoteHosts();
      if (!alive.current || generation !== refreshGeneration.current) return;
      setHosts(result.hosts);
      setError(null);
    } catch (caught) {
      if (!alive.current || generation !== refreshGeneration.current) return;
      const message = t(remoteHostErrorKey(caught));
      setError(message);
    }
  }, [t]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const unsubscribe = api.onSessionsChanged(() => void refresh());
    return () => { alive.current = false; refreshGeneration.current++; unsubscribe(); };
  }, [refresh]);

  const reconnect = async (host: RemoteHostSummary) => {
    if (reconnecting) return;
    setReconnecting(host.hostKey);
    setError(null);
    try {
      await api.reconnectRemoteHost(host.hostKey);
      if (alive.current) await refresh();
    } catch (caught) {
      if (alive.current) setError(t(remoteHostErrorKey(caught)));
    } finally {
      if (alive.current) setReconnecting(null);
    }
  };

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const url = form.url.trim();
      const pairingToken = form.pairingToken.trim();
      const label = form.label.trim();
      if (!url || !pairingToken || !label) return;
      setPairing(true);
      try {
        const result = await api.pairRemoteHost({ url, pairingToken, label });
        showToast(t("settings.remoteHosts.pairSucceeded", { label: result.host.label }), {
          variant: "info",
        });
        setForm(EMPTY_FORM);
        await refresh();
      } catch (caught) {
        const message = t(remoteHostErrorKey(caught));
        showToast(t("settings.remoteHosts.pairFailed", { message }), { variant: "error" });
      } finally {
        setPairing(false);
      }
    },
    [form, refresh, showToast, t],
  );

  const remove = useCallback(
    async (host: RemoteHostSummary) => {
      setRemoving(host.hostKey);
      try {
        await api.removeRemoteHost(host.hostKey);
        showToast(t("settings.remoteHosts.removed", { label: host.label }), {
          variant: "info",
        });
        await refresh();
      } catch (caught) {
        const message = t(remoteHostErrorKey(caught));
        showToast(t("settings.remoteHosts.removeFailed", { message }), { variant: "error" });
      } finally {
        setRemoving(null);
      }
    },
    [refresh, showToast, t],
  );

  // Switching back to a key drops the secret from the draft: it is only ever
  // held while password mode is selected.
  const selectSshAuth = useCallback((auth: RemoteHostSshAuth) => {
    setSshForm((prev) => ({
      ...prev,
      auth,
      password: auth === "key" ? "" : prev.password,
    }));
  }, []);

  const runSshBootstrap = useCallback(
    async (request: RemoteHostBootstrapRequest) => {
      setInstalling(true);
      try {
        const result = await api.bootstrapRemoteHost(request);
        setHostKeyPrompt(null);
        showToast(t("settings.remoteHosts.sshSucceeded", { label: result.host.label }), {
          variant: "info",
        });
        // Drops the password with the rest of the draft.
        setSshForm(EMPTY_SSH_FORM);
        await refresh();
      } catch (caught) {
        // An unknown host key is a question for the user, not a failure: show
        // its fingerprint and wait. Nothing is trusted until they confirm.
        const prompt = hostKeyPromptOf(caught);
        if (prompt) {
          setHostKeyPrompt({ prompt, request });
          return;
        }
        setHostKeyPrompt(null);
        const message = t(remoteHostErrorKey(caught));
        showToast(t("settings.remoteHosts.sshFailed", { message }), { variant: "error" });
      } finally {
        setInstalling(false);
      }
    },
    [refresh, showToast, t],
  );

  const trustHostKey = useCallback(() => {
    if (!hostKeyPrompt) return;
    void runSshBootstrap({
      ...hostKeyPrompt.request,
      trustedHostKeys: hostKeyPrompt.prompt.keys.map((key) => key.fingerprint),
    });
  }, [hostKeyPrompt, runSshBootstrap]);

  const submitSsh = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const label = sshForm.label.trim();
      const host = sshForm.host.trim();
      if (!host || !label) return;
      const passwordMode = sshForm.auth === "password";
      // Never trimmed: leading and trailing spaces can be part of a password,
      // so emptiness is tested separately from the value that is sent.
      const password = sshForm.password;
      if (passwordMode && !password) return;
      const user = sshForm.user.trim();
      const port = sshForm.port.trim();
      const identityFile = sshForm.identityFile.trim();
      // Empty optional fields are dropped rather than sent blank, so main
      // falls back to the SSH config and the local user name. A password
      // replaces the key, so no `-i` is sent alongside it.
      await runSshBootstrap({
        label,
        host,
        ...(user ? { user } : {}),
        ...(port ? { port: Number(port) } : {}),
        ...(!passwordMode && identityFile ? { identityFile } : {}),
        ...(passwordMode && password ? { password } : {}),
      });
    },
    [sshForm, runSshBootstrap],
  );
  const sshLocked = installing || hostKeyPrompt !== null;
  const busy = sshLocked || pairing;
  const sshSubmitDisabled =
    sshLocked ||
    !sshForm.host.trim() ||
    !sshForm.label.trim() ||
    (sshForm.auth === "password" && sshForm.password === "");
  const pairSubmitDisabled =
    pairing || !form.url.trim() || !form.pairingToken.trim() || !form.label.trim();

  return (
    <div className="settings-stack">
      {error && hosts !== null && <p role="alert">{error}</p>}
      <div
        className="settings-remote-host-list"
        role="list"
        aria-busy={hosts === null || removing !== null}
      >
        {error && hosts === null ? (
          <div className="settings-remote-host-empty" role="alert">
            {t("settings.remoteHosts.listError")}
            <span className="settings-remote-host-empty-detail">{error}</span>
          </div>
        ) : hosts === null ? (
          <div className="settings-remote-host-empty" role="status">
            {t("settings.remoteHosts.loading")}
          </div>
        ) : hosts.length === 0 ? (
          <div className="settings-remote-host-empty" role="status">
            {t("settings.remoteHosts.empty")}
          </div>
        ) : (
          hosts.map((host) => (
            <article key={host.hostKey} className="settings-remote-host-card" role="listitem">
              <span
                className={cx(
                  "settings-remote-host-pulse",
                  host.connected && "is-online",
                )}
                aria-hidden="true"
              />
              <div className="settings-remote-host-copy">
                <div className="settings-remote-host-name">{host.label}</div>
                <div className="settings-remote-host-meta">
                  {host.transport === "ssh"
                    ? t("settings.remoteHosts.transportSsh")
                    : host.url}
                </div>
              </div>
              <span className="settings-remote-host-card-actions">
                <Badge tone={host.connected ? "success" : host.status === "action-required" ? "warning" : "neutral"}>
                  {t(remoteHostStatusKey(host))}
                </Badge>
                <Button variant="secondary" onClick={() => setSelectedHost(host)}>
                  {remoteT("sessions")}
                </Button>
                <Button variant="ghost" disabled={reconnecting !== null} onClick={() => void reconnect(host)}>
                  {reconnecting === host.hostKey ? remoteT("loading") : remoteT("reconnect")}
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={removing === host.hostKey}
                  onClick={() => void remove(host)}
                >
                  {removing === host.hostKey
                    ? t("settings.remoteHosts.removing")
                    : t("settings.remoteHosts.remove")}
                </Button>
              </span>
            </article>
          ))
        )}
      </div>
      {selectedHost && <RemoteHostSessions key={selectedHost.hostKey} host={selectedHost} onClose={() => setSelectedHost(null)} />}

      <section className="settings-card-block">
        <div className="settings-card-heading-row settings-remote-host-add-heading">
          <h3 className="settings-card-heading">{t("settings.remoteHosts.addTitle")}</h3>
          <SegmentedControl
            value={addMode}
            onChange={(mode) => setAddMode(mode)}
            options={[
              { value: "ssh", label: t("settings.remoteHosts.addSsh"), id: "remote-host-add-ssh", controls: "remote-host-add-panel-ssh" },
              { value: "pair", label: t("settings.remoteHosts.addPair"), id: "remote-host-add-pair", controls: "remote-host-add-panel-pair" },
            ]}
            label={t("settings.remoteHosts.addTitle")}
            role="tablist"
            disabled={busy}
          />
        </div>
        <div className="settings-panel">
          <form
            id="remote-host-add-panel-ssh"
            role="tabpanel"
            aria-labelledby="remote-host-add-ssh"
            hidden={addMode !== "ssh"}
            className="settings-remote-host-form settings-remote-host-add-panel"
            onSubmit={submitSsh}
          >
            <div className="settings-remote-host-form-row">
              <Field label={t("settings.remoteHosts.fieldLabel")}>
                <Input
                  value={sshForm.label}
                  onChange={(event) =>
                    setSshForm((prev) => ({ ...prev, label: event.target.value }))
                  }
                  placeholder={t("settings.remoteHosts.fieldLabelPlaceholder")}
                  aria-label={t("settings.remoteHosts.fieldLabel")}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={sshLocked}
                />
              </Field>
              <Field label={t("settings.remoteHosts.sshHost")}>
                <Input
                  value={sshForm.host}
                  onChange={(event) =>
                    setSshForm((prev) => ({ ...prev, host: event.target.value }))
                  }
                  placeholder={t("settings.remoteHosts.sshHostPlaceholder")}
                  aria-label={t("settings.remoteHosts.sshHost")}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  disabled={sshLocked}
                />
              </Field>
            </div>

            <div className="settings-remote-host-form-row is-narrow-port">
              <Field label={t("settings.remoteHosts.sshUser")}>
                <Input
                  value={sshForm.user}
                  onChange={(event) =>
                    setSshForm((prev) => ({ ...prev, user: event.target.value }))
                  }
                  aria-label={t("settings.remoteHosts.sshUser")}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  disabled={sshLocked}
                />
              </Field>
              <Field label={t("settings.remoteHosts.sshPort")}>
                <Input
                  value={sshForm.port}
                  onChange={(event) =>
                    setSshForm((prev) => ({ ...prev, port: event.target.value }))
                  }
                  aria-label={t("settings.remoteHosts.sshPort")}
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={sshLocked}
                />
              </Field>
            </div>

            <div className="settings-remote-host-form-auth">
              <div
                className="text-sm text-text-secondary"
                id="settings-remote-host-auth-label"
              >
                {t("settings.remoteHosts.sshAuthMode")}
              </div>
              <SegmentedControl
                value={sshForm.auth}
                onChange={(auth) => selectSshAuth(auth)}
                options={[
                  { value: "key", label: t("settings.remoteHosts.sshAuthKey") },
                  { value: "password", label: t("settings.remoteHosts.sshAuthPassword") },
                ]}
                label={t("settings.remoteHosts.sshAuthMode")}
                disabled={sshLocked}
              />
            </div>

            {sshForm.auth === "key" ? (
              <Field label={t("settings.remoteHosts.sshIdentityFile")}>
                <Input
                  value={sshForm.identityFile}
                  onChange={(event) =>
                    setSshForm((prev) => ({ ...prev, identityFile: event.target.value }))
                  }
                  aria-label={t("settings.remoteHosts.sshIdentityFile")}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  disabled={sshLocked}
                />
              </Field>
            ) : (
              <Field label={t("settings.remoteHosts.sshPassword")}>
                <PasswordInput
                  value={sshForm.password}
                  onChange={(event) =>
                    setSshForm((prev) => ({ ...prev, password: event.target.value }))
                  }
                  placeholder={t("settings.remoteHosts.sshPasswordPlaceholder")}
                  aria-label={t("settings.remoteHosts.sshPassword")}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={sshLocked}
                  showLabel={t("settings.remoteHosts.sshShowPassword")}
                  hideLabel={t("settings.remoteHosts.sshHidePassword")}
                />
              </Field>
            )}

            {hostKeyPrompt ? (
              <RemoteHostKeyConfirm
                prompt={hostKeyPrompt.prompt}
                busy={installing}
                onTrust={trustHostKey}
                onCancel={() => setHostKeyPrompt(null)}
              />
            ) : (
              <div className="settings-remote-host-form-actions">
                <Button type="submit" variant="primary" disabled={sshSubmitDisabled}>
                  {installing
                    ? t("settings.remoteHosts.sshRunning")
                    : t("settings.remoteHosts.sshAction")}
                </Button>
              </div>
            )}
          </form>

          <form
            id="remote-host-add-panel-pair"
            role="tabpanel"
            aria-labelledby="remote-host-add-pair"
            hidden={addMode !== "pair"}
            className="settings-remote-host-form settings-remote-host-add-panel"
            onSubmit={submit}
          >
            <div className="settings-remote-host-form-row">
              <Field label={t("settings.remoteHosts.fieldLabel")}>
                <Input
                  value={form.label}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, label: event.target.value }))
                  }
                  placeholder={t("settings.remoteHosts.fieldLabelPlaceholder")}
                  aria-label={t("settings.remoteHosts.fieldLabel")}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pairing}
                />
              </Field>
              <Field label={t("settings.remoteHosts.fieldUrl")}>
                <Input
                  value={form.url}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, url: event.target.value }))
                  }
                  placeholder={t("settings.remoteHosts.fieldUrlPlaceholder")}
                  aria-label={t("settings.remoteHosts.fieldUrl")}
                  inputMode="url"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  disabled={pairing}
                />
              </Field>
            </div>
            <Field label={t("settings.remoteHosts.fieldPairingToken")}>
              <Input
                value={form.pairingToken}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, pairingToken: event.target.value }))
                }
                placeholder={t("settings.remoteHosts.fieldPairingTokenPlaceholder")}
                aria-label={t("settings.remoteHosts.fieldPairingToken")}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                type="password"
                disabled={pairing}
              />
            </Field>
            <div className="settings-remote-host-form-actions">
              <Button type="submit" variant="primary" disabled={pairSubmitDisabled}>
                {pairing
                  ? t("settings.remoteHosts.pairing")
                  : t("settings.remoteHosts.pair")}
              </Button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
