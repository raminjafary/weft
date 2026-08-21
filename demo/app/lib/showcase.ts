/**
 * The channel readout every live showcase carries.
 *
 * Three attributes and no code. `data-weft-stat` and `data-weft-log` are the framework's, painted
 * by its own client — because the connection, the write count and the frames are the runtime's
 * state, and a page that polled `window.weft` to show them was keeping glue in step by hand.
 */
export const LOG = `<p class="hint">channel: <span data-weft-stat="state" class="mono">idle</span> · <span data-weft-stat="writes" class="mono">0 DOM writes</span></p>
     <div class="card log" data-weft-log></div>`
