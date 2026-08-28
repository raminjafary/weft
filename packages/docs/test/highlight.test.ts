import assert from 'node:assert/strict'
import { test } from 'node:test'
import { highlight } from '../app/lib/highlight.ts'

/**
 * The property that matters most, and the reason a hand-written highlighter is safe to have.
 *
 * Everything else on this page is a colour choice. This is the one that can produce a broken
 * document: the scanners run over raw source, so if any branch emitted a token without escaping it,
 * a `<` in an example would become a tag in the page.
 */
const strip = (html: string): string => html.replace(/<\/?span[^>]*>/g, '')

const unescape = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

test('every language escapes the markup characters it emits', () => {
  const hostile = `const a = "<script>alert('x')</script>" // <b>&</b>`
  for (const language of ['ts', 'tsx', 'sh', 'json', 'unknown']) {
    const out = highlight(language, hostile)
    const bare = strip(out)
    assert.equal(bare.includes('<script'), false, `${language} leaked a tag`)
    assert.equal(bare.includes('<b>'), false, `${language} leaked a tag`)
    assert.match(bare, /&lt;script&gt;/, `${language} did not escape`)
    assert.match(bare, /&amp;/, `${language} did not escape an ampersand`)
  }
})

test('the text survives the round trip byte for byte', () => {
  const sources: [string, string][] = [
    ['tsx', "import { fragment } from '@weftjs/core'\nexport default fragment(() => <p>hi {x}</p>)"],
    ['ts', '/* block */ export const n: number = 1e9 // trailing'],
    ['sh', 'weft build demo --devtools  # a comment'],
    ['json', '{"kind":"text","n":-12.5,"ok":true,"nil":null}'],
  ]
  for (const [language, source] of sources) {
    assert.equal(unescape(strip(highlight(language, source))), source, language)
  }
})

test('a keyword, a string, a comment and a type each get their own class', () => {
  const out = highlight('tsx', "const x: string = 'y' // note")
  assert.match(out, /<span class="t-keyword">const<\/span>/)
  assert.match(out, /<span class="t-type">string<\/span>/)
  assert.match(out, /<span class="t-string">&#39;y&#39;<\/span>/)
  assert.match(out, /<span class="t-comment">\/\/ note<\/span>/)
})

test('shell marks the first word of each line as the command, and flags separately', () => {
  const out = highlight('sh', 'weft build\nweft start --port 3000')
  assert.equal(out.match(/t-command/g)?.length, 2)
  assert.match(out, /<span class="t-flag">--port<\/span>/)
})

test('json separates a key from a string value', () => {
  const out = highlight('json', '{"a":"b"}')
  assert.match(out, /<span class="t-key">&quot;a&quot;<\/span>/)
  assert.match(out, /<span class="t-string">&quot;b&quot;<\/span>/)
})

test('an unknown language is escaped text and nothing else', () => {
  const out = highlight('brainfuck', 'a < b & c')
  assert.equal(out, 'a &lt; b &amp; c')
})

test('plain runs carry no element, so highlighting does not inflate a block', () => {
  // `fragment` is neither keyword nor type, so it must arrive as bare text.
  assert.match(highlight('ts', 'fragment'), /^fragment$/)
})

/**
 * A string is a string wherever it starts, including immediately after a bracket.
 *
 * The punctuation branch was a greedy run of everything that is not a letter, a digit or a space —
 * which includes a quote. So it reached `['cart']` first and produced a punct token `['`, a plain
 * `cart` and a punct `']`: every array of strings, every call with a string argument and every
 * object with a quoted key on this site, highlighted as though the quotes were brackets. It read as
 * *nearly* right, which is why it survived: the colours were wrong on characters nobody looks at.
 */
test('punctuation before a quote does not swallow the string', () => {
  for (const source of ["writes: ['cart']", "f('a')", "{'k': 1}", 'a["b"]']) {
    const out = highlight('ts', source)
    assert.equal(
      /<span class="t-punct">[^<]*(&#39;|&quot;)/.test(out),
      false,
      `a punct token carries a quote in ${source}: ${out}`,
    )
    assert.match(out, /<span class="t-string">/, `no string token at all in ${source}`)
  }
})

/** An unterminated quote is still a token rather than a byte the scanner spins on. */
test('an unterminated quote is emitted and stepped past', () => {
  assert.match(highlight('ts', "x = 'open"), /<span class="t-punct">&#39;<\/span>open/)
})
