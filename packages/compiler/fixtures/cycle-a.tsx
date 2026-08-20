import { fragment } from 'weft'
import { Beta } from './cycle-b.tsx'

export const Alpha = fragment(({ n }: { n: number }) => (
  <li>
    <Beta n={n} />
  </li>
))
