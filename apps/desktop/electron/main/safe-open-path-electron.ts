import { shell } from "electron";
import type { OpenPathDeps } from "./safe-open-path";

/**
 * The Electron shell primitives behind `openPathOrReveal`. Kept apart from the
 * policy module so the policy can be tested without an Electron runtime.
 */
export const electronOpenPathDeps: OpenPathDeps = {
  openPath: async (path) => {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  },
  revealPath: (path) => {
    shell.showItemInFolder(path);
  },
};
