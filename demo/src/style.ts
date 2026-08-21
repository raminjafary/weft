/**
 * One stylesheet, served as a string. There is no build step in this demo on purpose: everything
 * you load is either a compiled fragment or a TypeScript module with its types stripped, so what
 * runs in the browser is what is in the repository.
 */
export const STYLE = `
:root{--bg:#0f1115;--panel:#161a21;--line:#232a35;--ink:#e6e9ef;--dim:#9aa4b2;--acc:#7fd1ae;--warn:#e6b76f;--bad:#e07a7a;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:light){:root{--bg:#fbfbfc;--panel:#fff;--line:#e4e7ec;--ink:#151922;--dim:#5b6472;--acc:#1c7a55;--warn:#8a5d10;--bad:#a33}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
a{color:inherit}
.top{display:flex;gap:1.25rem;align-items:center;padding:.7rem 1.1rem;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5;flex-wrap:wrap}
.brand{font-weight:650;letter-spacing:.02em;text-decoration:none}
.top nav{display:flex;gap:.9rem;flex-wrap:wrap}
.top nav a{color:var(--dim);text-decoration:none;font-size:.9rem}
.top nav a[data-current=yes]{color:var(--ink);text-decoration:underline;text-underline-offset:4px}
main{max-width:62rem;margin:0 auto;padding:1.4rem 1.1rem 5rem}
h1{font-size:1.5rem;margin:.4rem 0 .3rem;display:flex;gap:.6rem;align-items:baseline;flex-wrap:wrap}
h2{font-size:1.1rem;margin:1.4rem 0 .5rem}
h3{font-size:.95rem;margin:.2rem 0 .5rem;color:var(--dim);font-weight:600}
.status{font:600 .62rem/1 var(--mono);letter-spacing:.09em;text-transform:uppercase;padding:.28rem .45rem;border-radius:.3rem;border:1px solid var(--line);color:var(--dim)}
.status[data-status=live]{color:var(--acc);border-color:currentColor}
.status[data-status=planned]{color:var(--warn);border-color:currentColor}
.status[data-status=refused]{color:var(--bad);border-color:currentColor}
.shows{margin:.2rem 0;color:var(--ink)}
.control-note{margin:.1rem 0 1rem;color:var(--dim);font-size:.9rem}
section.panel,section.body,section.readout{margin:.9rem 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:.6rem;padding:.9rem 1rem}
.controls{display:flex;gap:1rem;flex-wrap:wrap;align-items:end}
.controls label{display:flex;flex-direction:column;gap:.25rem;font-size:.78rem;color:var(--dim)}
input,select,button{font:inherit;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:.35rem;padding:.35rem .5rem}
button{cursor:pointer}
button:hover{border-color:var(--acc)}
code,pre,.mono,.value,time{font-family:var(--mono)}
pre{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:.5rem;padding:.75rem;font-size:.8rem;margin:.5rem 0}
.readout-table dl{margin:0;display:grid;grid-template-columns:minmax(9rem,auto) auto 1fr;gap:.25rem .9rem;font-size:.85rem}
.readout-table .row{display:contents}
.readout-table dt{color:var(--dim)}
.readout-table dd{margin:0}
.readout-table .value{font-variant-numeric:tabular-nums}
.readout-table .row[data-state=over] .value{color:var(--bad)}
.readout-table .row[data-state=within] .value{color:var(--acc)}
.readout-table .note{color:var(--dim);font-size:.78rem}
.grid{display:grid;gap:.7rem;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))}
.grid a{display:block;text-decoration:none;background:var(--panel);border:1px solid var(--line);border-radius:.6rem;padding:.7rem .8rem}
.grid a:hover{border-color:var(--acc)}
.grid .t{font-weight:600;display:flex;justify-content:space-between;gap:.5rem;align-items:baseline}
.grid .d{color:var(--dim);font-size:.82rem;margin-top:.3rem}
.items,.lines{list-style:none;padding:0;margin:0}
.items li{display:grid;grid-template-columns:1fr 7rem 5rem 4rem 5rem;gap:.6rem;padding:.35rem .5rem;border-bottom:1px solid var(--line);font-size:.86rem}
.items li[data-move^="+"] .move{color:var(--acc)}
.items li[data-move^="-"] .move{color:var(--bad)}
.items .source,.items time{color:var(--dim);font-size:.78rem}
.feed .meta{color:var(--dim);font-size:.82rem}
.cart table{width:100%;border-collapse:collapse;font-size:.88rem}
.cart td{padding:.35rem .4rem;border-bottom:1px solid var(--line)}
.cart .qty input{width:4.5rem}
.totals{display:grid;grid-template-columns:auto auto;gap:.15rem .9rem;justify-content:start;font-size:.88rem;margin:.8rem 0 0}
.totals dt{color:var(--dim)}
.totals dd{margin:0;font-variant-numeric:tabular-nums}
.dash-panel{background:var(--panel);border:1px solid var(--line);border-radius:.6rem;padding:.7rem .8rem}
.dash-panel .cost{color:var(--dim);font-size:.78rem;margin:.1rem 0 .5rem;font-family:var(--mono)}
.dash-panel ul{list-style:none;padding:0;margin:0;font-size:.85rem}
.dash-panel li{display:flex;justify-content:space-between;gap:.6rem;padding:.15rem 0}
.dash-panel li[data-trend=up] .value{color:var(--acc)}
.dash-panel li[data-trend=down] .value{color:var(--bad)}
article{max-width:38rem}
.standfirst{font-size:1.05rem;color:var(--ink)}
.byline{color:var(--dim);font-size:.85rem}
.body-copy p{margin:.8rem 0}
.skeleton{height:1.1rem;background:var(--line);border-radius:.3rem;animation:pulse 1.1s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.45}50%{opacity:.85}}
.log{max-height:16rem;overflow:auto;font-size:.76rem;font-family:var(--mono)}
.log div{padding:.1rem 0;border-bottom:1px solid var(--line);white-space:pre-wrap}
.log .up{color:var(--warn)}
.log .down{color:var(--acc)}
.wrote{outline:2px solid var(--acc);outline-offset:2px;transition:outline-color .8s}
.hint{color:var(--dim);font-size:.8rem;margin:.4rem 0 0}
.explain{margin-top:.7rem}
.explain p{margin:.2rem 0 .6rem}
.prov{margin:0;display:grid;grid-template-columns:minmax(7.5rem,auto) 1fr;gap:.2rem .9rem;font-size:.82rem}
.prov dt{color:var(--dim)}
.prov dd{margin:0;color:var(--ink)}
.prov code{font-size:.78rem;color:var(--acc);word-break:break-word}
.raw{display:contents}
table.forms{border-collapse:collapse;font-size:.82rem;width:100%}
table.forms th,table.forms td{text-align:left;padding:.3rem .5rem;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
table.forms th{color:var(--dim);font-weight:600;font-size:.76rem}
table.forms td.ok{color:var(--acc)}
table.forms td.no{color:var(--bad)}
.coverage{font-size:.85rem}
.coverage .miss{color:var(--bad)}
.products{display:grid;gap:.7rem;grid-template-columns:repeat(auto-fill,minmax(13rem,1fr));margin:.8rem 0}
.product{background:var(--panel);border:1px solid var(--line);border-radius:.6rem;padding:.8rem}
.product h3{color:var(--ink);margin:0 0 .3rem}
.product .price{margin:.1rem 0;font-family:var(--mono);font-size:1.05rem}
.product .unit{color:var(--dim);font-size:.8rem}
.product .badge{color:var(--dim);font-size:.78rem;margin:.1rem 0 .6rem}
.product button[disabled]{opacity:.45;cursor:not-allowed}
.pill{display:inline-block;padding:.3rem .6rem;border:1px solid var(--line);border-radius:999px;text-decoration:none;font-size:.82rem}
.pill:hover{border-color:var(--acc)}
.ordinary .standfirst{font-size:.95rem;color:var(--dim)}
body.race{padding:.7rem .9rem;font-size:.85rem}
.race-order{margin:0;font:600 .72rem/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--acc)}
body.race[data-order=in-order] .race-order{color:var(--warn)}
.race-note{margin:.15rem 0 .7rem;color:var(--dim);font-size:.76rem}
.race-lanes{display:grid;gap:.45rem}
.lane{border:1px solid var(--line);border-radius:.45rem;padding:.4rem .55rem;min-height:3.1rem}
.lane-name{display:block;color:var(--dim);font-size:.7rem;margin-bottom:.2rem}
.arrived{display:block;font-family:var(--mono);font-size:.98rem}
.arrived[data-first=yes]{color:var(--acc)}
.landed{display:block;font-family:var(--mono);font-size:.76rem;color:var(--dim)}
.waiting{display:block;color:var(--dim);font-family:var(--mono);font-size:.8rem}
.race-frames{display:grid;gap:.7rem;grid-template-columns:1fr 1fr;margin:.7rem 0}
.race-frames iframe{width:100%;height:15rem;border:1px solid var(--line);border-radius:.5rem;background:var(--bg)}
@media (max-width:52rem){.race-frames{grid-template-columns:1fr}}
`
