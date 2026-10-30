// Electron masaüstü paketi için ayrı build yapılandırması (Lovable sarmalayıcısı olmadan):
// base './' -> dosya yolu üzerinden yüklenen varlıklar mutlak yola ihtiyaç duymaz.
// spa.enabled -> tamamen istemci tarafında çalışan tek sayfa kabuğu (Electron'da sunucu gerekmez).
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({
      server: { entry: "server" },
      spa: { enabled: true },
    }),
    viteReact(),
    tailwindcss(),
  ],
});
