import { create } from "zustand";

/** Retain only browsing choices across route unmounts, never dialogs or work. */
export const usePluginBrowseState = create<{
  installedQuery: string;
  setInstalledQuery: (installedQuery: string) => void;
}>((set) => ({
  installedQuery: "",
  setInstalledQuery: (installedQuery) => set({ installedQuery }),
}));
