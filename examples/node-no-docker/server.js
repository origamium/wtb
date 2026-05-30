// Minimal zero-dependency server so the example is genuinely runnable.
const http = require("node:http")
const port = process.env.PORT || 4000

http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(`node-no-docker example on port ${port}\n`)
  })
  .listen(port, () => console.log(`listening on http://localhost:${port}`))
