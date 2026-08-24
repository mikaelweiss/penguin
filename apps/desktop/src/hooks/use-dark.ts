import { useEffect, useState } from "react";

import { useTheme } from "@/components/theme-provider";

const DARK = "(prefers-color-scheme: dark)";

/** Whether the app is drawing dark right now, following the system while the theme is system. */
export function useDark(): boolean {
  const { theme } = useTheme();
  const [system, setSystem] = useState(() => window.matchMedia(DARK).matches);

  useEffect(() => {
    const query = window.matchMedia(DARK);
    const follow = () => setSystem(query.matches);
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);

  return theme === "system" ? system : theme === "dark";
}
