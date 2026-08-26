/** The protocol name, in every preamble. A different name is a different protocol. */
export const WARP_SPEC = 'weft.warp/1'
/** The version this build speaks. */
export const WARP_VERSION = '1.8.0'

/** Binary stream preamble: magic, then the major and minor the sender is speaking. */
export const WARP_MAGIC = 'WRP1'
/** The major. A different one is refused rather than negotiated: majors are wire breaks. */
export const WARP_MAJOR = 1
/** The minor. Additive, so a peer on a lower one skips what it does not know. */
export const WARP_MINOR = 8
/** How many bytes open a stream, so a decoder knows when it can start reading. */
export const PREAMBLE_BYTES = 8
/** The fixed part of a binary frame: code, flags, and the two lengths. */
export const FRAME_HEADER_BYTES = 8
