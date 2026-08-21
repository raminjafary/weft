/**
 * The channel readout every live showcase carries.
 *
 * `data-channel` used to be what told the demo's client to open a connection. It no longer is: the
 * framework opens one when a region declares itself live, which it knows from the same `live: true`
 * that registered the slot with the hub. This is now only the log the frames are printed into.
 */
export const LOG = `<p class="hint">channel: <span id="channel-state" class="mono">idle</span> · <span id="channel-writes" class="mono">0 DOM writes</span></p>
     <div class="card log" id="frame-log" data-weft-log></div>`
