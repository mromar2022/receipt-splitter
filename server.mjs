import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { handleReceiptAiRequest } from "./api/openaiReceipt.js";

const root = join(process.cwd(), "dist");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function sendFile(res, path) {
  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypes[extname(path)] || "application/octet-stream");
  createReadStream(path).pipe(res);
}

function safeStaticPath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split("?")[0]);
  const normalized = normalize(cleanPath).replace(/^(\.\.[/\\])+/, "");
  const target = join(root, normalized === "/" ? "index.html" : normalized);
  if (!target.startsWith(root)) return join(root, "index.html");
  return existsSync(target) ? target : join(root, "index.html");
}

const server = createServer(async (req, res) => {
  if (req.url?.startsWith("/api/read-receipt-ai")) {
    await handleReceiptAiRequest(req, res);
    return;
  }

  if (!existsSync(root)) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Build the app first with: pnpm run build");
    return;
  }

  sendFile(res, safeStaticPath(req.url || "/"));
});

server.listen(port, host, () => {
  console.log(`Receipt Splitter running at http://${host}:${port}/`);
});
