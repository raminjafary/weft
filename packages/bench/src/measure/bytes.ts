import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

export interface FormSizes {
  form: string
  raw: number
  gzip: number
  /** Brotli at quality 5, which is what a CDN can afford on a dynamic response. */
  brotli: number
}

export function measureBytes(payloads: Record<string, Uint8Array>): FormSizes[] {
  return Object.entries(payloads).map(([form, bytes]) => ({
    form,
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 6 }).length,
    brotli: brotliCompressSync(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 5,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }).length,
  }))
}
