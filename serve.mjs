import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const page = fileURLToPath(new URL("./dist/index.html", import.meta.url));
http.createServer(async (request, response) => {
  if (request.url === "/favicon.ico") {
    response.writeHead(204).end();
    return;
  }
  try {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store" });
    response.end(await readFile(page));
  } catch {
    response.writeHead(500).end("Build the HTML first.");
  }
}).listen(8785, "127.0.0.1", () => console.log("Local: http://127.0.0.1:8785"));
