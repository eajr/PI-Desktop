import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteMediaKind } from "@pi-desktop/shared";
import { api } from "../lib/api";
import {
  cachedRemoteMedia,
  loadRemoteMedia,
  remoteMediaHost,
} from "../lib/remote-media";
import type { SourcePositionProps } from "../lib/markdown-source";
import { IconAudio, IconImage, IconVideo } from "./icons";

const KIND_ICON = { image: IconImage, audio: IconAudio, video: IconVideo } as const;
const KIND_ACTION = {
  image: "chat.remoteMedia.loadImage",
  audio: "chat.remoteMedia.loadAudio",
  video: "chat.remoteMedia.loadVideo",
} as const;

/**
 * Click-to-load gate for one remote media reference (ADR 0327). Until the
 * reader clicks, nothing about `url` reaches the DOM except the visible host
 * and the title text, so rendering a message never contacts the host. After a
 * successful load, `children` renders with the bounded data URL from Main.
 */
export function RemoteMediaPlaceholder({
  url,
  kind,
  label,
  positionProps,
  children,
}: {
  url: string;
  kind: RemoteMediaKind;
  /** Alt text or caption, shown beside the host when present. */
  label?: string;
  /** Parser offsets, so selection and copy map the chip to its source. */
  positionProps?: SourcePositionProps;
  children: (dataUrl: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<
    { url: string; status: "idle" | "loading" | "failed" } | { url: string; status: "loaded"; dataUrl: string }
  >(() => {
    const cached = cachedRemoteMedia(url, kind);
    return cached ? { url, status: "loaded", dataUrl: cached } : { url, status: "idle" };
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A streaming message can change the URL under the same element.
  const current = state.url === url ? state : (() => {
    const cached = cachedRemoteMedia(url, kind);
    return cached
      ? { url, status: "loaded" as const, dataUrl: cached }
      : { url, status: "idle" as const };
  })();

  if (current.status === "loaded") return <>{children(current.dataUrl)}</>;

  const host = remoteMediaHost(url);
  const Icon = KIND_ICON[kind];
  const load = () => {
    setState({ url, status: "loading" });
    void loadRemoteMedia(url, kind, api.mediaFetchRemote).then((dataUrl) => {
      if (!mounted.current) return;
      setState((prev) => {
        if (prev.url !== url) return prev;
        return dataUrl ? { url, status: "loaded", dataUrl } : { url, status: "failed" };
      });
    });
  };
  const action =
    current.status === "loading"
      ? t("chat.remoteMedia.loading")
      : current.status === "failed"
        ? t("chat.remoteMedia.retry")
        : t(KIND_ACTION[kind]);

  return (
    <span
      {...positionProps}
      className="chat-remote-media"
      data-remote-media={kind}
      data-state={current.status}
      title={`${t("chat.remoteMedia.hint", { host })}\n${url}`}
    >
      <Icon size={14} aria-hidden />
      <span className="chat-remote-media-host">{host}</span>
      {label ? <span className="chat-remote-media-label">{label}</span> : null}
      {current.status === "failed" ? (
        <span className="chat-remote-media-error" role="status">
          {t("chat.remoteMedia.failed")}
        </span>
      ) : null}
      <button
        type="button"
        className="chat-remote-media-load"
        disabled={current.status === "loading"}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          load();
        }}
      >
        {action}
      </button>
    </span>
  );
}
