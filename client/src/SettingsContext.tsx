import { createContext, useContext } from "react";
import type { Settings } from "./api";

export const SettingsContext = createContext<Settings | null>(null);

export function useSettings(): Settings {
  const settings = useContext(SettingsContext);
  if (!settings) throw new Error("useSettings() called outside SettingsContext.Provider");
  return settings;
}
