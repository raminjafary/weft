#!/usr/bin/env node
import { serveDemo } from './server.ts'

const port = Number(process.env.PORT ?? process.argv[2] ?? 4173)
const serving = await serveDemo(port)

process.stdout.write(`\n  weft demo · ${serving.url}\n\n`)
process.stdout.write('  index      /            every station and showcase\n')
process.stdout.write('  coverage   /spec        every spec document, and the station that covers it\n')
process.stdout.write('  ordinary   /app/ordinary/pantry\n')
process.stdout.write('  feed       /app/feed\n')
process.stdout.write('  cart       /app/cart\n')
process.stdout.write('  article    /app/article\n')
process.stdout.write('  dashboard  /app/dashboard\n')
process.stdout.write('  channel    /channel?c=<id>   stream · /channel/sse?c=<id> · ws /channel?c=<id>\n\n')

const stop = (): void => {
  void serving.close().then(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
