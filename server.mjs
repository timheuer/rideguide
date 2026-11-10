import { createServer } from "node:http";
import { buildHtml } from "./generate-guide.mjs";

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "127.0.0.1";

// The guide is rebuilt per request so edits to rides.yaml or GPX files show up on refresh.
const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  if (pathname !== "/" && pathname !== "/index.html" && pathname !== "/ride-guide.html") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }

  try {
    const html = await buildHtml();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : html);
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(`Could not build guide: ${error.message}`);
  }
});

server.listen(port, host, () => {
  console.log(`Ride guide running at http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
});
