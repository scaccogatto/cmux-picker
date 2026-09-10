#!/usr/bin/env node
// Serves demo/ over plain http://127.0.0.1. The picker's content script only
// injects into real page origins, and Chrome does not run extensions on
// file:// pages by default, so the demo needs a real http origin to click
// around in.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PORT = Number(process.env.PORT) || 5599

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
  const relPath = urlPath === '/' ? 'index.html' : urlPath.slice(1)
  const filePath = resolve(join(ROOT, relPath))

  if (filePath !== ROOT.replace(/\/$/, '') && !filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden')
    return
  }

  readFile(filePath)
    .then((body) => {
      const type = TYPES[extname(filePath)] ?? 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': type }).end(body)
    })
    .catch(() => {
      res.writeHead(404).end('Not found')
    })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cmux-picker demo: http://127.0.0.1:${PORT}`)
})

process.on('SIGINT', () => {
  server.close(() => process.exit(0))
})
