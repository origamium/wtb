// Tiny zero-dependency API so the stack runs with just `node:20-alpine` (no build).
const http = require("node:http")
const port = process.env.PORT || 3100

http
  .createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true, service: "api", port, db: process.env.DATABASE_URL ? "configured" : "none" }))
  })
  .listen(port, () => console.log(`api listening on ${port}`))
