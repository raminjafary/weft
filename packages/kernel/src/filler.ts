/**
 * The fill mechanism, inline and tiny, because it has to run while the response is still
 * streaming — before any module could have loaded.
 *
 * It deliberately does not live in the client runtime. Filling a hole is part of how a
 * response is delivered, not part of what the page does afterwards, and keeping it here
 * keeps it out of the runtime's byte budget. A page with no out-of-order slots never sees
 * these bytes at all.
 */
export const FILLER = `<script>window.__w=function(n){var t=document.querySelector('template[data-w="'+n+'"]');if(!t)return;var w=document.createTreeWalker(document.body,128),c;while(c=w.nextNode())if(c.data==='w:'+n)break;if(!c)return;c.parentNode.insertBefore(t.content,c.nextSibling);t.remove();var s=document.currentScript;if(s)s.remove()}</script>`

export function fillerBytes(): Uint8Array {
  return new TextEncoder().encode(FILLER)
}

export function fillerSize(): number {
  return fillerBytes().length
}
