// The web server the chrome-api-probe extensions test against. Used by the
// shell's parity spec and by script/chrome-parity.mjs, which runs the same
// extensions in Chrome to record what Chrome does.
const http = require('node:http')

const pageHtml = (query) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Probe page</title></head>
<body>
<p>This page is where the probe extension runs its tests.</p>
<div id="closed-host"></div>
<iframe src="/frame"></iframe>
<script>
  window.mainWorldMarker = 1
  document.getElementById('closed-host').attachShadow({ mode: 'closed' }).innerHTML = '<b>closed</b>'
</script>
</body>
</html>`

function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, type, body, headers) => {
    res.writeHead(status, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, headers || {}))
    res.end(body)
  }
  switch (url.pathname) {
    case '/':
    case '/page':
      return send(200, 'text/html; charset=utf-8', pageHtml(url.search))
    case '/frame':
      return send(200, 'text/html; charset=utf-8', '<!DOCTYPE html><title>Probe frame</title><p>frame</p>')
    case '/file.txt':
      return send(200, 'text/plain', 'probe download\n')
    case '/wr':
      if (url.search === '?redirect') {
        return send(302, 'text/plain', '', { Location: '/wr?redirected' })
      }
      return send(200, 'text/plain', 'web request')
    case '/auth': {
      const expected = 'Basic ' + Buffer.from('probe:secret').toString('base64')
      if (req.headers.authorization === expected) return send(200, 'text/plain', 'authorized')
      return send(401, 'text/plain', 'who are you', { 'WWW-Authenticate': 'Basic realm="probe"' })
    }
    case '/oauth': {
      const id = (url.searchParams.get('id') || '').replace(/[^a-p]/g, '')
      return send(302, 'text/plain', '', { Location: `https://${id}.chromiumapp.org/cb?code=probe` })
    }
    case '/echo-headers':
      return send(200, 'application/json', JSON.stringify(req.headers), { 'Access-Control-Allow-Origin': '*' })
    case '/dnr-blocked':
    case '/dnr-redirect':
    case '/dnr-session':
    case '/blocked-by-ruleset':
      return send(200, 'text/plain', 'not blocked')
    default:
      return send(404, 'text/plain', 'not found')
  }
}

/** Starts the server; resolves { base, other, close }. */
function startProbeServer(port) {
  const server = http.createServer(handle)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // Both stacks, so http://localhost/ works when it resolves to ::1.
    server.listen(port || 0, () => {
      const actual = server.address().port
      resolve({
        base: `http://127.0.0.1:${actual}/`,
        other: `http://localhost:${actual}/`,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

module.exports = { startProbeServer }
