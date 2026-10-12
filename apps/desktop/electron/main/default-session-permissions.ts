import type { Session } from "electron";

/**
 * Permission policy for the default session, which carries the main renderer.
 *
 * Nothing in the main renderer captures audio or video, so `media` is always
 * refused. Plugin panels that hold `ui.microphone` use their own partition
 * (`plugin-panel-host.ts`). Installing a handler replaces the platform default
 * for every permission, so other permissions keep the platform behavior: the
 * app's own copy buttons need `clipboard-sanitized-write`.
 */
export function allowsDefaultSessionPermission(permission: string): boolean {
  return permission !== "media";
}

export function installDefaultSessionPermissionHandlers(targetSession: Session): void {
  targetSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowsDefaultSessionPermission(permission));
  });
  targetSession.setPermissionCheckHandler((_contents, permission) => allowsDefaultSessionPermission(permission));
}
