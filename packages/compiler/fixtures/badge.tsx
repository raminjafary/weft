import { fragment } from '@weftjs/core'

export const Badge = fragment(({ tone, label }: { tone: string; label: string }) => (
  <span class={tone}>{label}</span>
))
