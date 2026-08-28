import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertValidTemplate, draftTemplate, seal, type TemplateIR } from '@weftjs/ir'
import { staticVerdict } from '../src/server.ts'
import type { CompiledFragment } from '../src/compile.ts'

/**
 * The tier's last derivation, and the one that needed both halves of an agreement that already
 * existed.
 *
 * A slot declares the tags that invalidate it. An intent declares the tags it writes. That pair is
 * what makes push invalidation work with nothing subscribing to anything — and a file is the one
 * place it cannot reach, because nothing can drop a document off a disk.
 *
 * Everything else about L0 was already checked, structurally and then empirically, and this page
 * passed all of it: `/app/ordinary/:category` in the demo declares both its parameter values, reads
 * nothing but the parameter, and renders identically under two probes that differ in cookies,
 * identity, locale, device, flags, query and the clock. So it was written out as two files — with
 * the shared cart count baked in, tagged `cart`, while `cart.add` declares it writes `cart`. The
 * page served the count from build time and the button its own readout advertises did nothing.
 *
 * Both halves are build-time declarations, so this is derivable rather than something to remember
 * `static: false` for.
 */
async function fragment(reads: string[] = []): Promise<CompiledFragment> {
  const entry: TemplateIR = assertValidTemplate(
    await seal(
      draftTemplate({
        id: 'fragment/page',
        segments: ['<p>', '</p>'],
        holes: [{ index: 0, kind: 'text', escape: 'escape', binding: 'count', path: [0] }],
        effects: { reads, writes: [], envelope: [], residency: 'server' },
      }),
    ),
  )
  return {
    entry,
    templates: [entry],
    resolve: () => undefined,
    file: 'app/routes/catalogue.tsx',
    source: '',
  }
}

/** The page as the generator hands it over: one buffered body, whatever it declares. */
async function page(cache: { class: 'public' | 'private'; ttl?: string; tags?: string[] }) {
  const compiled = await fragment()
  return {
    pattern: '/catalogue',
    module: { cache },
    shell: compiled,
    slots: [{ name: 'body', fragment: compiled, declaration: { cache, stream: false }, streams: false }],
  }
}

test('a page an intent invalidates is not a file, and the refusal names the tag', async () => {
  const verdict = staticVerdict({
    ...(await page({ class: 'public', ttl: '10m', tags: ['cart'] })),
    written: new Set(['cart']),
  })

  assert.equal(verdict.static, false)
  assert.equal(verdict.static === false && verdict.code, 'L0_WRITTEN')
  assert.match(
    verdict.static === false ? verdict.reason : '',
    /cart/,
    'the refusal names the tag, because the reader is asking why their page is not a file',
  )
})

/**
 * And the other direction, which is what stops this from being a check that refuses everything.
 *
 * A tag nobody writes invalidates nothing, so it is not a reason to refuse: an application may tag
 * a page for an invalidation it performs by hand, from a deploy hook or a cron, and freezing that
 * page is the correct answer until some intent claims the tag.
 */
test('a tag no intent writes is not a reason to refuse', async () => {
  const verdict = staticVerdict({
    ...(await page({ class: 'public', ttl: '10m', tags: ['catalogue'] })),
    written: new Set(['cart', 'feed']),
  })
  assert.equal(verdict.static, true, 'nothing writes `catalogue`, so nothing can make this page wrong')
})

/** And with no intents at all — the application that has none should not lose its static tier. */
test('an application with no intents keeps every file it had', async () => {
  const tagged = await page({ class: 'public', ttl: '10m', tags: ['cart'] })
  assert.equal(staticVerdict(tagged).static, true, 'no written set is no intents')
  assert.equal(staticVerdict({ ...tagged, written: new Set() }).static, true)
})

/**
 * A page with no policy at all is untouched, because there is no tag to intersect.
 *
 * Worth stating: the check reads `cache.tags`, and a slot that declares no cache declares no tags.
 * An intent writing `cart` says nothing about a page that never claimed to hold anything.
 */
test('a page that declares no tags is unaffected by what intents write', async () => {
  const compiled = await fragment()
  const verdict = staticVerdict({
    pattern: '/plain',
    module: {},
    shell: compiled,
    slots: [{ name: 'body', fragment: compiled, declaration: { stream: false }, streams: false }],
    written: new Set(['cart']),
  })
  assert.equal(verdict.static, true)
})
