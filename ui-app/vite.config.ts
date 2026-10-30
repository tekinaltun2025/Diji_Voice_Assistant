// Standart Vite yapılandırması (Lovable sarmalayıcısı olmadan).
// TanStack Start v1 + nitro + Tailwind v4 eklentileri burada tek tek tanımlanır.
import { defineConfig, type PluginOption } from "vite";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";

export default defineConfig(({ command }) => ({
  plugins: [
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({
      // SSR hata sarmalayıcısı: src/server.ts
      server: { entry: "server" },
    }),
    viteReact(),
    tailwindcss(),
    // Sunucu derlemesi yalnızca build sırasında gerekir.
    ...(command === "build"
      ? [nitro({ preset: "node-server" }) as unknown as PluginOption]
      : []),
  ],
}));
