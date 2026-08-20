import { fragment } from 'weft'
import { Alpha } from './cycle-a.tsx'

export const Beta = fragment(({ n }: { n: number }) => (
  <li>
    <Alpha n={n} />
  </li>
))
