/**
 * 从 assets/icon.png（1024×1024 母版）生成干净的 assets/icon.icns。
 *
 * 为什么需要这个脚本（2026-10-05 实测，issue #89）：
 *   母版 PNG 带一个 eXIf 块；sips 缩放时原样保留，electron-builder 从 png 自动转 icns
 *   同样保留。LaunchServices/iconservices 解码 icns 里的 16/32px PNG 时遇到 eXIf
 *   会解出彩虹乱码（release 成品实测：换唯一路径+唯一 bundle id 仍复现，
 *   非缓存问题），而 AppKit 直接加载同一 icns 却正常——问题只在系统图标渲染路径。
 *   故先把 eXIf 块从 PNG 容器中剔除（其余块不动）；注意 sips 自身在每次 PNG 输出时
 *   都会重新合成一个 eXIf 块（与源文件无关，已实测），所以 sips 出图后还要再剥一遍，
 *   最后 iconutil 合成 icns；electron-builder.yml 直接指这份 .icns，原样使用不重编码。
 *
 * 用法：node scripts/make-icon.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/ → packages/desktop
const SRC = join(pkgDir, "assets", "icon.png");
const DST = join(pkgDir, "assets", "icon.icns");

/**
 * 遍历 PNG 容器块，剔除指定类型（eXIf）。
 * PNG = 8 字节签名 + 若干块（4 字节长度 BE + 4 字节类型 + 数据 + 4 字节 CRC）。
 * 保留块的字节（含 CRC）原样拼接，无需重算 CRC。
 */
function stripPngChunks(buffer, dropTypes) {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("不是合法 PNG（签名不符）");
  const chunks = [];
  let offset = 8;
  let dropped = [];
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error("PNG 块头截断");
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length; // 长度+类型+数据+CRC
    if (end > buffer.length) throw new Error(`PNG 块 ${type} 数据截断`);
    if (dropTypes.includes(type)) {
      dropped.push(type);
    } else {
      chunks.push(buffer.subarray(offset, end));
    }
    offset = end;
  }
  if (!chunks.length || chunks[chunks.length - 1].subarray(4, 8).toString() !== "IEND") {
    throw new Error("PNG 缺 IEND，结构异常");
  }
  return { png: Buffer.concat([SIGNATURE, ...chunks]), dropped };
}

const { png: cleanMaster, dropped } = stripPngChunks(readFileSync(SRC), ["eXIf"]);
if (!dropped.length) {
  console.log("母版无 eXIf 块，直接使用。");
} else {
  console.log(`已从母版剔除块：${dropped.join(", ")}`);
}

const work = mkdtempSync(join(tmpdir(), "lw-icon-"));
const iconset = join(work, "icon.iconset");
// mkdtemp 只建叶子目录，iconset 子目录靠 sips 写文件前由 shell mkdir
spawnSync("mkdir", ["-p", iconset], { stdio: "inherit" });
const cleanPath = join(work, "icon-clean.png");
writeFileSync(cleanPath, cleanMaster);

/** iconset 严格命名：(尺寸, 文件名) */
const SIZES = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];
for (const [px, name] of SIZES) {
  const r = spawnSync("sips", ["-z", String(px), String(px), cleanPath, "--out", join(iconset, name)], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`sips 生成 ${name} 失败：${r.stderr}`);
  // sips 无视源文件、每次都给 PNG 输出合成 eXIf（实测），逐张再剥一遍
  const stripped = stripPngChunks(readFileSync(join(iconset, name)), ["eXIf"]);
  if (stripped.dropped.length) writeFileSync(join(iconset, name), stripped.png);
}

// 安全断言：任一 PNG 再带 eXIf 就中止，不生成看似成功的脏 icns
for (const [, name] of SIZES) {
  if (readFileSync(join(iconset, name)).includes(Buffer.from("eXIf", "ascii"))) {
    throw new Error(`${name} 仍含 eXIf，中止`);
  }
}

const icns = spawnSync("iconutil", ["-c", "icns", iconset, "-o", DST], { encoding: "utf8" });
if (icns.status !== 0) throw new Error(`iconutil 合成失败：${icns.stderr}`);
rmSync(work, { recursive: true, force: true });
console.log(`已生成 ${DST}`);
