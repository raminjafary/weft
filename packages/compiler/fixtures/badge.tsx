import { fragment } from 'weft'

export const Badge = fragment(({ tone, label }: { tone: string; label: string }) => (
  <span class={tone}>{label}</span>
))
