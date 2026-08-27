import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, serveApp, type Serving } from '../src/server.ts'

/**
 * What a browser is shown when there is no page — and who gets to decide it.
 *
 * The framework's own error page used to print the whole route table, which was written for the
 * person building the application and shown to everyone who mistyped a URL. On a deployment that is
 * a map of the site handed to whoever asks for a path that does not exist, so the list is gone and
 * `weft routes` prints it for the one audience it was ever for.
 *
 * The half that matters more is that it is replaceable: `app/layouts/error.tsx` is discovered like
 * any other named document, and writing the file *is* the registration.
 */
const servers: Serving[] = []
const dirs: string[] = []

after(async () => {
  for (const serving of servers) await serving.close()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function siteWith(files: Record<string, string>): Promise<Serving> {
  const root = await mkdtemp(join(tmpdir(), 'weft-error-'))
  dirs.push(root)
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, body)
  }
  const serving = await serveApp(await createApp(root, { mode: 'dev', port: 0 }))
  servers.push(serving)
  return serving
}

const HOME = `import { fragment } from 'weft'

export default fragment(() => <p>home</p>)
`

test('a path that matches nothing is a 404 that says so and does not list the route table', async () => {
  const serving = await siteWith({ 'app/routes/index.tsx': HOME, 'app/routes/about.tsx': HOME })
  const response = await fetch(new URL('/nope', serving.url))
  const body = await response.text()

  assert.equal(response.status, 404)
  assert.match(response.headers.get('content-type') ?? '', /text\/html/)
  assert.match(body, /E_NO_ROUTE/, 'the framework names what happened, as it does everywhere else')
  assert.match(body, /\/nope/, 'and names the path that was asked for')
  assert.ok(!body.includes('/about'), 'a 404 is not a directory of every page that does exist')
  assert.match(body, /noindex/, 'and is not a page a crawler should keep')
})

test('an application replaces the error page by writing app/layouts/error.tsx, and nothing else', async () => {
  const serving = await siteWith({
    'app/routes/index.tsx': HOME,
    'app/layouts/error.tsx': `import { fragment, raw } from 'weft'

export default fragment(({ status, code, detail }: { status: string; code: string; detail: string }) => (
  <>
    {raw('<!doctype html>')}
    <html lang="en">
      <head>
        <title>lost</title>
      </head>
      <body>
        <h1 class="mine">{status}</h1>
        <p>{code}</p>
        <p>{detail}</p>
      </body>
    </html>
  </>
))
`,
  })
  const response = await fetch(new URL('/nope', serving.url))
  const body = await response.text()

  assert.equal(response.status, 404, 'replacing the page does not change the status')
  assert.match(body, /<h1 class="mine">404<\/h1>/, body.slice(0, 300))
  assert.match(body, /E_NO_ROUTE/, "and it is handed the same context the framework's own reads")
  assert.ok(!body.includes('weft-error'), "the framework's own page is not rendered as well")
})
