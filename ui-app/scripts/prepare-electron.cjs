// Electron paketi için SPA kabuğunu hazırlar:
// TanStack Start'ın ürettiği _shell.html mutlak (/assets/...) yollar içerir;
// file:// üzerinden yükleme için bunları göreli yollara çevirip index.html yazar.
const fs = require("node:fs");
const path = require("node:path");

const dir = path.join(__dirname, "..", "dist", "client");
const shell = path.join(dir, "_shell.html");
let html = fs.readFileSync(shell, "utf8");
html = html.replace(/(src|href)="\/(?!\/)/g, '$1="./');
fs.writeFileSync(path.join(dir, "index.html"), html);
console.log("dist/client/index.html hazır (göreli varlık yolları)");
