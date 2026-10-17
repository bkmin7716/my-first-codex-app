import {relativeText,relativeTotals} from './engine.js';
// A derived overview: select a hole to edit through the shared PAR button UI.
export function scorecard(r,{selected=0,shared=false}={}) {
 const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const heading=h=>`<th scope="col"><button ${shared?'data-shared-hole':'data-hole'}="${h}" class="${h===selected?'active':''}">${h+1}<small>PAR ${r.holes[h].par}</small></button></th>`;
 const cell=(p,h)=>`<td>${relativeText(r.holes[h].scores[p]===null?null:r.holes[h].scores[p]-r.holes[h].par)}</td>`;
 return `<div class="scorecard-scroll" role="region" aria-label="18홀 PAR 대비 스코어카드" tabindex="0"><table class="scorecard"><thead><tr><th scope="col" class="player-fixed">선수</th>${r.holes.slice(0,9).map((_,h)=>heading(h)).join('')}<th>OUT</th>${r.holes.slice(9).map((_,h)=>heading(h+9)).join('')}<th>IN</th><th>TOTAL</th></tr></thead><tbody>${r.players.map((name,p)=>{const t=relativeTotals(r,p);return `<tr><th scope="row" class="player-fixed">${esc(name)}</th>${r.holes.slice(0,9).map((_,h)=>cell(p,h)).join('')}<td data-total="out-${p}">${relativeText(t.out)}</td>${r.holes.slice(9).map((_,h)=>cell(p,h+9)).join('')}<td data-total="in-${p}">${relativeText(t.in)}</td><td data-total="total-${p}">${relativeText(t.total)}</td></tr>`;}).join('')}</tbody></table></div>`;
}
