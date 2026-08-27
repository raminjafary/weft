import { defineRoute } from '@weftjs/core'

const TOPICS: Record<string, { intro: string; cards: [string, string][]; notes: [string, string][] }> = {
  routing: {
    intro: 'The route table is the file tree. There is nothing else to keep in step with it.',
    cards: [
      ['index.tsx', 'The directory itself. app/routes/index.tsx is /.'],
      ['[param].tsx', 'A parameter. app/routes/guide/[topic].tsx is /guide/:topic.'],
    ],
    notes: [
      [
        'Specificity, not order',
        'Where two patterns could match one path, the more specific wins. A table whose behaviour depends on the order somebody wrote it in is a table nobody can refactor.',
      ],
      [
        '[...] is last',
        'A wildcard segment has to be the last one, and a file that puts it anywhere else fails the build rather than the router.',
      ],
      ['Two files, one route', 'x.tsx renders and x.data.ts declares. Both are optional except the first.'],
    ],
  },
  data: {
    intro: 'A loader returns values. The plan says where they go, and the compiler says what they cost.',
    cards: [
      ['load()', 'Runs in the render phase, so it can read cookies, headers, params and flags.'],
      ['cache', 'A class and a ttl. What it may not state is a key: keys come from the reads.'],
    ],
    notes: [
      [
        'The compiler wins',
        'Declare public on a fragment that reads identity and the build fails, naming the read. That is not a caching bug being caught, it is one user’s bytes in another user’s cache being prevented.',
      ],
      [
        'time forces a ttl',
        'A fragment that reads the clock cannot have a policy with no expiry, because there is nothing to expire it.',
      ],
      [
        'stream or buffer',
        'A page whose slots all buffer is delivered in order and pays for no fill mechanism. Nothing had to choose that; it was derived.',
      ],
    ],
  },
  intents: {
    intro: 'A mutation declares what it writes. Everything else follows from that one sentence.',
    cards: [
      ['defineIntent', 'A name, the tags it writes, an input validator and a body.'],
      ['No JavaScript', 'The same dispatch answers a form post with a 303. One code path, two clients.'],
    ],
    notes: [
      [
        'Opaque ids',
        'The client carries six hex characters derived from the module and export, so renaming a server export is not a wire change. Moving it to another file is, deliberately.',
      ],
      [
        'Optimistic by construction',
        'A guess is staged into an epoch, which paints nothing. On success the server stages the truth into the same epoch and one commit replaces it. On failure the epoch is discarded, so rollback needs no code.',
      ],
      [
        'Push invalidation',
        'The declared writes are what tells other connections their region went stale. Nothing subscribed to anything.',
      ],
    ],
  },
}

const KNOWN = Object.keys(TOPICS)

export default defineRoute({
  head: (params) => ({ title: `${params.topic ?? 'Guide'} — guide` }),
  cache: { class: 'public', ttl: '1h' },
  load: (_ctx, params) => {
    const key = params.topic && TOPICS[params.topic] ? params.topic : 'routing'
    const topic = TOPICS[key] as (typeof TOPICS)[string]
    const [first, second] = topic.cards
    return {
      topic: key,
      intro: topic.intro,
      firstTitle: first?.[0] ?? '',
      firstBody: first?.[1] ?? '',
      secondTitle: second?.[0] ?? '',
      secondBody: second?.[1] ?? '',
      notes: topic.notes.map(([title, body]) => ({ title, body })),
    }
  },
  slots: {
    footer: {
      html: `<footer class="weft-foot"><nav class="weft-row">${KNOWN.map(
        (name) => `<a class="weft-pill" href="/guide/${name}">${name}</a>`,
      ).join('')}</nav></footer>`,
    },
  },
})
