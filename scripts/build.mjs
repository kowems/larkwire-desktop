/**
 * 桌面壳构建（WP2）：main→ESM .mjs（createRequire banner——ws/tweetnacl/qrcode-terminal 是 CJS，
 * relay bundle/安装快照同款配方）；preload→CJS .cjs（sandbox 下 ESM preload 受限）；renderer 静态拷贝。
 * 产物全在 dist/——dev（electron .）与打包（electron-builder files=dist/**）吃同一份。
 */
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/ → packages/desktop
const dist = join(pkgDir, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const banner = {
  js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
};

await build({
  entryPoints: [join(pkgDir, "src", "main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["electron"],
  banner,
  outfile: join(dist, "main.mjs"),
});

await build({
  entryPoints: [join(pkgDir, "src", "preload.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  outfile: join(dist, "preload.cjs"),
});

await cp(join(pkgDir, "src", "renderer"), join(dist, "renderer"), { recursive: true });
await cp(join(pkgDir, "assets"), join(dist, "assets"), {
  recursive: true,
  filter: (src) => !src.endsWith("icon.png"), // app 图标只给 electron-builder 用，运行时用不到，不进包
});

console.log("✅ dist 构建完成：main.mjs + preload.cjs + renderer/ + assets/");
