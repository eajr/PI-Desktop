import { Button, TooltipButton } from "../components/ui";
import { IconDownload, IconMore, IconPlug } from "../components/icons";
import { AnchoredMenu } from "../components/settings/AnchoredMenu";
import { SearchField } from "../features/plugins/presentation";
import { InstalledPluginsPanel } from "../features/plugins/InstalledPluginsPanel";
import { PluginDialogs } from "../features/plugins/PluginDialogs";
import { usePluginsPage } from "../features/plugins/usePluginsPage";

/**
 * Installed plugins only. This build has no remote marketplace: plugins arrive
 * bundled, from a local package or folder, or from a development folder (ADR
 * fork-removes-plugin-marketplace).
 */
export function PluginsPage() {
  const page = usePluginsPage();
  const {
    t,
    headerMenu,
    setHeaderMenu,
    overflowActions,
    plugins,
    installedQuery,
    filteredInstalled,
    setInstalledQuery,
    installPackage,
  } = page;

  return (
    <div className="route-scroll">
      <div className="page-frame plugins-page">
        <div className="page-header plugins-page-header">
          <div className="plugins-title-block">
            <span className="plugins-title-icon" aria-hidden>
              <IconPlug size={14} />
            </span>
            <div className="plugins-title-copy">
              <h1 className="page-title">{t("plugins.title")}</h1>
            </div>
          </div>
          <div className="plugins-header-actions">
            <Button variant="primary" size="sm" onClick={() => void installPackage()}>
              <IconDownload size={14} />
              {t("plugins.installPackage")}
            </Button>
            <AnchoredMenu
              className="plugins-menu-wrap"
              open={headerMenu}
              onClose={() => setHeaderMenu(false)}
              menuClassName="plugins-menu is-end"
              label={t("plugins.moreActions")}
              role="menu"
              align="end"
              trigger={(ref) => (
                <TooltipButton
                  ref={ref}
                  type="button"
                  className="plugins-icon-btn plugins-header-menu"
                  ariaLabel={t("plugins.moreActions")}
                  tooltip={t("plugins.moreActions")}
                  aria-haspopup="menu"
                  aria-expanded={headerMenu}
                  onClick={() => setHeaderMenu((open) => !open)}
                >
                  <IconMore size={16} />
                </TooltipButton>
              )}
            >
              {overflowActions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  role="menuitem"
                  data-action={action.key}
                  onClick={() => {
                    setHeaderMenu(false);
                    void action.run();
                  }}
                >
                  {t(`plugins.${action.key}`)}
                </button>
              ))}
            </AnchoredMenu>
          </div>
        </div>

        {plugins.length ? (
          <div className="plugins-toolbar">
            <div className="plugins-toolbar-end">
              {installedQuery.trim() ? (
                <span className="plugins-result-count" aria-live="polite">
                  {t("plugins.resultCount", {
                    count: filteredInstalled.length,
                    total: plugins.length,
                  })}
                </span>
              ) : null}
              <SearchField
                value={installedQuery}
                onChange={setInstalledQuery}
                placeholder={t("plugins.searchInstalled")}
              />
            </div>
          </div>
        ) : null}
        <InstalledPluginsPanel {...page} />
      </div>

      <PluginDialogs {...page} />
    </div>
  );
}
