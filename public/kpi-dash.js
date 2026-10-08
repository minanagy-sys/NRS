const SRC='<!DOCTYPE html>\n'+document.documentElement.outerHTML;
let CFG={};try{CFG=JSON.parse(document.getElementById('cfg').textContent||'{}')}catch(e){}
const $=id=>document.getElementById(id);
const SERVER='odoo-nouvelage18',TOOL='odoo_call_method';
const VISIT=[43475,43473,41355,41358,41351,41357,39508],VISIT_ALL=[...VISIT,43474];
const INJ=['|','|','|',['product_id.name','ilike','botox'],['product_id.name','ilike','filler'],['product_id.name','ilike','profhilo'],['product_id.name','ilike','booster']];
const TIERK=[0,.09,.39,.70,1],TIERL=['80%','85%','90%','95%','100%'];
// baseline = measured 1 Oct 2026; t100 = level that covers the branch target
const KPI=[
 {id:'laser',n:'Laser sessions per patient',ar:'متوسط جلسات الليزر للمريض',u:'x',dir:1,base:2.08,t100:2.75,win:'Rolling 6 months to period end',f:'DEKA invoices ÷ distinct DEKA patients (package journal excluded)',why:'مريض الليزر محتاج 6–8 جلسات. كل جلسة زيادة في المتوسط = حوالي 1.7 مليون في الشهر.'},
 {id:'noshow',n:'No-show rate',ar:'نسبة الـ No-show',u:'%',dir:-1,base:.146,t100:.125,win:'Period',f:'Appointments past their date, still Draft/Confirmed, patient not invoiced in the period ÷ appointments excluding reschedules',why:'حجز وما جاش ومحدش رجّعه. كل 1% أقل ≈ 75 زيارة في الشهر.'},
 {id:'react',n:'Patients back after 90+ days',ar:'مرضى رجعوا بعد غياب 90 يوم أو أكتر',u:'n',dir:1,base:366,t100:535,win:'Period',f:'Invoiced in period · no invoice in the 90 days before · invoiced at least once before that',why:'8,975 مريض جم النص الأول من السنة وما رجعوش. دول أرخص مرضى ممكن ترجّعهم.'},
 {id:'botox',n:'Botox return within ~6 months',ar:'مرضى البوتوكس اللي رجعوا',u:'%',dir:1,base:.194,t100:.32,win:'Cohort: Botox 4–6 months before period start',f:'Of that cohort, % with another Botox invoice up to period end',why:'البوتوكس بيتعاد كل 4–6 شهور. المريض اللي ما رجعش راح عيادة تانية أو نسي.'},
 {id:'cross',n:'Laser patients who bought injectables',ar:'مرضى الليزر اللي اشتروا حقن',u:'%',dir:1,base:.057,t100:.113,win:'Rolling 6 months to period end',f:'Patients with DEKA and with Botox / Filler / Profhilo / Booster ÷ patients with DEKA',why:'مريض الليزر بييجي كذا مرة وبيثق فيكم، و94% منهم ما حدش عرض عليهم حاجة تانية.'},
 {id:'consult',n:'Consultations that turned into treatment',ar:'الكشوفات اللي اتحولت لعلاج',u:'%',dir:1,base:.63,t100:.69,win:'Period',f:'Patients with a paid visit who also bought any treatment in the period ÷ patients with a paid visit',why:'المريض اللي دفع كشف ومشي كان مهتم فعلاً. الفرق بين الدكاترة من 44% لـ 74%.'},
 {id:'src',n:'Leads with a source',ar:'الليدز اللي عليها مصدر',u:'%',dir:1,base:0,t100:1,fixed:[.8,.85,.9,.95,1],win:'Leads created in period',f:'Leads with Source set ÷ all leads',why:'من غيرها مستحيل نعرف أنهي إعلان بيجيب مريض بيدفع.'},
 {id:'touch',n:'New leads someone acted on',ar:'الليدز الجديدة اللي حد اتعامل معاها',u:'%',dir:1,base:.935,t100:1,fixed:[.8,.85,.9,.95,1],win:'Leads created in period',f:'1 − (leads still New with no scheduled activity) ÷ all leads',why:'ليد ما اتلمسش = شخص كان عايز يحجز ومحدش رد عليه.'}
];
(CFG.kpi||[]).forEach(o=>{const k=KPI.find(x=>x.id===o.id);if(k)['base','t100','why'].forEach(f=>{if(o[f]!=null)k[f]=o[f]})});
const tiers=k=>k.fixed||TIERK.map(x=>k.base+(k.t100-k.base)*x);
const fmt=(k,v)=>v==null||isNaN(v)?'—':k.u==='%'?(v*100).toFixed(1)+'%':k.u==='x'?v.toFixed(2):Math.round(v).toLocaleString('en-US');
const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const addD=(s,n)=>{const d=new Date(s+'T12:00:00');d.setDate(d.getDate()+n);return iso(d)};
const TODAY=iso(new Date());
const SEG=[['today','Today'],['yday','Yesterday'],['7d','Last 7D'],['mtd','Month to date'],['last','Last month'],['q','Last 3 months'],['year','This year']];
function preset(p){const t=new Date(),y=t.getFullYear(),m=t.getMonth();
 if(p==='today')return[TODAY,TODAY];if(p==='yday'){const d=addD(TODAY,-1);return[d,d]}
 if(p==='7d')return[addD(TODAY,-6),TODAY];if(p==='mtd')return[iso(new Date(y,m,1)),TODAY];
 if(p==='last')return[iso(new Date(y,m-1,1)),iso(new Date(y,m,0))];if(p==='q')return[iso(new Date(y,m-3,1)),iso(new Date(y,m,0))];
 if(p==='year')return[iso(new Date(y,0,1)),TODAY];return[$('dFrom').value,$('dTo').value]}
let P='last',BRAND='all',BRANCH='',GOAL=4;
const BRL={103:'Madinty (East Hub)',104:'Alex Camp Chizar',105:'Madinty Strip',106:'CFC',107:'Alex Roshdy',108:'Mohandseen',109:'Mall of Arabia',110:'Zayed',111:'City Stars',112:'Loran',114:'El Rehab'};
const ZATJ=[103,114];
function jset(){if(BRANCH)return[+BRANCH];const all=Object.keys(BRL).map(Number);return BRAND==='zat'?ZATJ:BRAND==='nv'?all.filter(j=>!ZATJ.includes(j)):null}
function segs(){$('seg').innerHTML=SEG.map(([k,l])=>`<button class="${k===P?'on':''}" data-k="${k}">${l}</button>`).join('');
 $('seg').querySelectorAll('button').forEach(b=>b.onclick=()=>{P=b.dataset.k;const[a,z]=preset(P);$('dFrom').value=a;$('dTo').value=z;segs();load()})}
function pills(){$('fBrand').innerHTML=[['all','All'],['nv','Nouvelage'],['zat','ZAT']].map(([k,l])=>`<button class="pill${k===BRAND?' on':''}" data-k="${k}">${l}</button>`).join('');
 $('fBrand').querySelectorAll('.pill').forEach(b=>b.onclick=()=>{BRAND=b.dataset.k;BRANCH='';pills();branchSel();load()});
 $('fTier').innerHTML=TIERL.map((l,i)=>`<button class="pill${i===GOAL?' on':''}" data-i="${i}">${l}</button>`).join('');
 $('fTier').querySelectorAll('.pill').forEach(b=>b.onclick=()=>{GOAL=+b.dataset.i;pills();if(LAST)render(LAST);renderF()})}
let SEEN=null;
function branchSel(){const all=(SEEN||Object.keys(BRL).map(Number));const ok=BRAND==='zat'?ZATJ:BRAND==='nv'?all.filter(j=>!ZATJ.includes(j)):all;
 $('fBranch').innerHTML='<option value="">All branches</option>'+ok.map(j=>`<option value="${j}"${String(j)===BRANCH?' selected':''}>${BRL[j]}</option>`).join('');
 $('fBranch').onchange=()=>{BRANCH=$('fBranch').value;load()}}
function gday(a,z){const n=Math.round((new Date(z)-new Date(a))/864e5)+1;const f=d=>new Date(d+'T12:00:00').toLocaleDateString('en-GB',{weekday:a===z?'long':undefined,day:'numeric',month:'long',year:'numeric'});
 $('gday').innerHTML=(a===z?f(a):f(a)+' – '+f(z))+`<small>${n} day${n>1?'s':''}</small>`}
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===t));document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id===t.dataset.p))});

let mcp=null;
function errText(e){const c=e&&e.code;if(c==='no_access')return 'Not in your Odoo access.';if(c==='not_logged_in')return 'Log in to Odoo, then press Show.';return c==='needs_reauth'?`Reconnect ${SERVER} in claude.ai Settings → Connectors, then press Show.`:c==='server_not_connected'?`Add the ${SERVER} connector in claude.ai Settings → Connectors to see live numbers.`:c==='selection_required'?`Choose which ${SERVER} connector to use when claude.ai asks, then press Show.`:c==='not_in_manifest'||c==='not_granted'?'Allow Odoo access for this page to see live numbers.':c==='blocked_by_policy'||c==='approval_required'?'Your organisation blocks this Odoo tool here.':c==='server_unavailable'?'Odoo did not answer in time. Press Show to try again.':c==='no_mcp'?'Live Odoo numbers are not available in this view. Open the page from its claude.ai link.':c==='tool_error'?'Odoo returned an error: '+String(e.message||'').slice(0,160):'Could not load from Odoo: '+String((e&&e.message)||'unknown error').slice(0,160)}
// ---- data layer: two sources, same calls.
// A) claude.ai: the odoo-nouvelage18 connector (whatever user that connector is signed in as).
// B) NRS / any page served next to Odoo: set window.NRS_ODOO = {url:'https://<odoo-or-proxy>'} before this script.
//    Every call then runs as the Odoo user who is logged in, so Odoo's own access rights decide what comes back.
const ODOO=window.NRS_ODOO||null;let ME=null;
async function rpc(path,params){const r=await fetch(ODOO.url.replace(/\/$/,'')+path,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',method:'call',params:params||{}})});
 if(r.status===401||r.status===403)throw{code:'not_logged_in'};if(!r.ok)throw{code:'server_unavailable',message:'HTTP '+r.status};
 const j=await r.json();if(j.error){const n=(j.error.data&&j.error.data.name)||'';const m=(j.error.data&&j.error.data.message)||j.error.message;
  throw{code:/AccessError|AccessDenied/.test(n)?'no_access':/SessionExpired/.test(n)?'not_logged_in':'tool_error',message:m}}return j.result}
const CACHE=new Map();
async function call(model,method,args,kwargs){
 const key=JSON.stringify([model,method,args,kwargs,BRAND,BRANCH]);const hit=CACHE.get(key);if(hit&&Date.now()-hit.t<300000)return hit.v;
 let p;
 if(ODOO){p=await rpc(`/web/dataset/call_kw/${model}/${method}`,{model,method,args,kwargs:kwargs||{}})}
 else{if(!mcp)throw{code:'no_mcp'};const r=await mcp.callTool(SERVER,TOOL,{model,method,args,kwargs:kwargs||{}},{cache:{staleTime:300000}});
  p=r.payload;if(typeof p==='string'){if(/access|not allowed|permission/i.test(p))throw{code:'no_access',message:p};try{p=JSON.parse(p)}catch(e){throw{code:'tool_error',message:p}}}}
 CACHE.set(key,{t:Date.now(),v:p});return p}
async function whoAmI(){if(!ODOO)return null;try{const i=await rpc('/web/session/get_session_info',{});return{uid:i.uid,name:i.name||i.username,admin:!!(i.is_admin||i.is_system)}}catch(e){return null}}
const rg=(model,dom,fields,gb)=>call(model,'read_group',[dom,fields,gb],{lazy:false});
const cnt=(model,dom)=>call(model,'search_count',[dom]);
const JF=()=>{const j=jset();return j?[['journal_id','in',j]]:[]};
const inv=(a,z,extra)=>[['move_type','=','out_invoice'],['state','=','posted'],['invoice_date','>=',a],['invoice_date','<=',z],...JF(),...(extra?[['invoice_line_ids','any',extra]]:[])];
const AML=(a,z)=>[['display_type','=','product'],['parent_state','=','posted'],['move_id.move_type','=','out_invoice'],['date','>=',a],['date','<=',z],...JF()];
const APB={103:28,104:17,105:29,106:19,107:41,108:22,109:30,110:25,111:20,112:27,114:26};
const AF=()=>{const j=jset();return j?[['branch_id','in',j.map(x=>APB[x])]]:[]};

async function leadSrc(a,z){const d=[['create_date','>=',a+' 00:00:00'],['create_date','<=',z+' 23:59:59']];const n=await cnt('crm.lead',d);return n?(await cnt('crm.lead',[...d,['source_id','!=',false]]))/n:null}
async function leadTouch(a,z){const d=[['create_date','>=',a+' 00:00:00'],['create_date','<=',z+' 23:59:59']];const n=await cnt('crm.lead',d);return n?1-(await cnt('crm.lead',[...d,['stage_id.name','=ilike','new'],['activity_ids','=',false]]))/n:null}
async function compute(a,z){
 const z2=z>TODAY?TODAY:z, r6=addD(z,-182);
 const out={};
 const jobs={
  laser:async()=>{const g=await rg('account.move.line',[...AML(r6,z),['product_id.name','ilike','deka'],['journal_id.name','not ilike','package']],['move_id:count_distinct','partner_id:count_distinct'],['company_id']);const s=g.reduce((x,r)=>[x[0]+r.move_id,x[1]+r.partner_id],[0,0]);return s[1]?s[0]/s[1]:null},
  noshow:async()=>{const base=[['date','>=',a],['date','<=',z2],...AF()];
   const g=await rg('appointment',base,['id:count'],['states']);let tot=0,res=0;g.forEach(r=>{const c=r.__count||r.id||0;tot+=c;if(/resch/i.test(String(r.states)))res+=c});
   const lost=await cnt('appointment',[...base,['states','in',['pending','confirm','no_show','draft']],['partner_id.invoice_ids','not any',[['move_type','=','out_invoice'],['state','=','posted'],['invoice_date','>=',a],['invoice_date','<=',addD(z2,7)]]]]);
   return tot-res>0?lost/(tot-res):null},
  react:async()=>cnt('res.partner',[['invoice_ids','any',inv(a,z)],['invoice_ids','not any',[['move_type','=','out_invoice'],['state','=','posted'],['invoice_date','>=',addD(a,-90)],['invoice_date','<=',addD(a,-1)]]],['invoice_ids','any',[['move_type','=','out_invoice'],['state','=','posted'],['invoice_date','<',addD(a,-90)]]]]),
  botox:async()=>{const bt=[['product_id.name','ilike','botox']];const c0=inv(addD(a,-180),addD(a,-121),bt);
   const n=await cnt('res.partner',[['invoice_ids','any',c0]]);if(!n)return null;
   const k=await cnt('res.partner',[['invoice_ids','any',c0],['invoice_ids','any',inv(addD(a,-120),z,bt)]]);return k/n},
  cross:async()=>{const dk=[['invoice_ids','any',inv(r6,z,[['product_id.name','ilike','deka']])]];
   const n=await cnt('res.partner',dk);if(!n)return null;const k=await cnt('res.partner',[...dk,['invoice_ids','any',inv(r6,z,INJ)]]);return k/n},
  consult:async()=>{const v=[['invoice_ids','any',inv(a,z,[['product_id','in',VISIT]])]];
   const n=await cnt('res.partner',v);if(!n)return null;
   const k=await cnt('res.partner',[...v,['invoice_ids','any',inv(a,z,[['display_type','=','product'],['product_id','not in',VISIT_ALL],['price_subtotal','>',0]])]]);return k/n},
  src:async()=>{if(jset())return{company:true,v:await leadSrc(a,z)};const d=[['create_date','>=',a+' 00:00:00'],['create_date','<=',z+' 23:59:59']];const n=await cnt('crm.lead',d);if(!n)return null;return (await cnt('crm.lead',[...d,['source_id','!=',false]]))/n},
  touch:async()=>{if(jset())return{company:true,v:await leadTouch(a,z)};const d=[['create_date','>=',a+' 00:00:00'],['create_date','<=',z+' 23:59:59']];const n=await cnt('crm.lead',d);if(!n)return null;return 1-(await cnt('crm.lead',[...d,['stage_id.name','=ilike','new'],['activity_ids','=',false]]))/n}
 };
 await Promise.all(Object.entries(jobs).map(async([k,f])=>{try{const r=await f();out[k]=r&&typeof r==='object'&&'company' in r?{v:r.v,company:true}:{v:r}}catch(e){out[k]={err:e}}}));
 return out}

function tierOf(k,v){if(v==null)return -2;const t=tiers(k);let hit=-1;t.forEach((x,i)=>{if(k.dir>0?v>=x-1e-9:v<=x+1e-9)hit=i});return hit}
function card(k,res){const t=tiers(k);
 if(!res)return `<div class="card"><h3>${k.n}</h3><div class="skel"></div><div class="ctx ar">${k.ar}</div></div>`;
 if(res.err)return `<div class="card"><h3>${k.n}</h3><div class="big">—</div><div class="ctx">${errText(res.err)}</div></div>`;
 const h=tierOf(k,res.v);const cls=h<0?(h===-2?'tna':'tlow'):'t'+TIERL[h].replace('%','');
 return `<div class="card"><h3>${k.n}<br><span class="ar" style="font-weight:400;font-size:11.5px;display:block">${k.ar}</span></h3><div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><div class="big">${fmt(k,res.v)}</div><span class="tier ${cls}">${h===-2?'no data':h<0?'below 80%':TIERL[h]}</span></div>
 <div class="ladder">${t.map((x,i)=>`<div class="${i<=h?'hit':''}" style="${i===GOAL?'outline:2px solid #9e6e4a':''}">${TIERL[i]}<b>${fmt(k,x)}</b></div>`).join('')}</div>
 <div class="ctx">Goal (${TIERL[GOAL]}): <b>${fmt(k,t[GOAL])}</b> · ${h>=GOAL?'✓ reached':'gap '+fmt(k,Math.abs(t[GOAL]-res.v))}${res.company?' · all branches (leads have no branch)':''}</div>
 <div class="ctx">Start (1 Oct): ${fmt(k,k.base)} · ${k.dir>0?'higher':'lower'} is better · ${k.win}</div>
 ${EDIT?`<div class="ctx" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">Start <input class="ed" data-k="${k.id}" data-f="base" value="${toU(k,k.base)}" style="width:80px"> 100% <input class="ed" data-k="${k.id}" data-f="t100" value="${toU(k,k.t100)}" style="width:80px">${k.u==='%'?' (in %)':''}${k.fixed?' · ladder fixed at 80–100%':''}</div><textarea class="ed ar" data-k="${k.id}" data-f="why" rows="3" style="width:100%">${esc(k.why)}</textarea>`:`<div class="why ar">${k.why}</div>`}</div>`}

let busy=0,LAST=null,EDIT=false;
const toU=(k,v)=>k.u==='%'?+(v*100).toFixed(2):v, frU=(k,v)=>k.u==='%'?(+v)/100:+v;
const esc=t=>String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
function setSync(st,t){$('syncDot').className=st;$('sync').textContent=t}
function render(o){const{a,z,r}=o;
 const vis=KPI.filter(k=>!(r[k.id]&&r[k.id].err&&r[k.id].err.code==='no_access'));
 $('cards').innerHTML=vis.length?vis.map(k=>card(k,r[k.id])).join(''):'<div class="note">None of these KPIs are in your Odoo access yet.</div>';
 const hits=vis.map(k=>r[k.id]&&!r[k.id].err?tierOf(k,r[k.id].v):-2);const NK=vis.length;
 const atG=hits.filter(h=>h>=GOAL).length,below=hits.filter(h=>h===-1).length;
 const scope=BRANCH?BRL[BRANCH]:BRAND==='zat'?'ZAT':BRAND==='nv'?'Nouvelage':'All branches';
 $('hero').innerHTML=`<div><div class="lbl">${ME?'Signed in as '+ME.name:'Scope'}</div><div class="val">${scope}<small>${a} → ${z}</small></div></div><div><div class="lbl">At goal (${TIERL[GOAL]})</div><div class="val">${atG} / ${NK}<small>KPIs reached the goal tier</small></div></div><div><div class="lbl">Below 80%</div><div class="val">${below} / ${NK}<small>need action now</small></div></div><div><div class="lbl">Forecast at ${TIERL[GOAL]}</div><div class="val" id="heroF">—<small>month revenue · tab 03</small></div></div>`;
 renderF()}
async function load(){const a=$('dFrom').value,z=$('dTo').value;if(!a||!z||a>z)return;const my=++busy;gday(a,z);
 $('msg').hidden=true;$('cards').innerHTML=KPI.map(k=>card(k,null)).join('');setSync('busy','Loading from Odoo…');
 if(!mcp&&!ODOO){$('cards').innerHTML=KPI.map(k=>card(k,{err:{code:'no_mcp'}})).join('');setSync('err','Odoo not available here');return}
 const r=await compute(a,z);if(my!==busy)return;
 LAST={a,z,r};render(LAST);
 const errs=Object.values(r).filter(x=>x.err&&x.err.code!=='no_access');if(errs.length){$('msg').hidden=false;$('msg').textContent=errText(errs[0].err);setSync('err','partly loaded')}
 else setSync('','synced '+new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})+' · invoices lag 1–2 days');
 loadBranches(a,z,my);loadLastMonth()}
const BR=BRL;
async function loadBranches(a,z,my){const tb=$('bTbl').querySelector('tbody');tb.innerHTML='<tr><td colspan="6">Loading…</td></tr>';
 try{const z2=z>TODAY?TODAY:z;
  const [rev,las,ap]=await Promise.all([
   rg('account.move.line',[...AML(a,z),['journal_id','in',jset()||Object.keys(BR).map(Number)]],['price_subtotal:sum','move_id:count_distinct'],['journal_id']),
   rg('account.move.line',[...AML(addD(z,-182),z),['product_id.name','ilike','deka'],['journal_id','in',jset()||Object.keys(BR).map(Number)]],['move_id:count_distinct','partner_id:count_distinct'],['journal_id']),
   rg('appointment',[['date','>=',a],['date','<=',z2]],['id:count'],['branch_id','states'])]);
  if(my!==busy)return;
  const L={};las.forEach(r=>L[r.journal_id[0]]=r.partner_id?r.move_id/r.partner_id:null);
  const A={};ap.forEach(r=>{const k=r.branch_id?r.branch_id[0]:0;A[k]=A[k]||{t:0,o:0,r:0};const c=r.__count||0;A[k].t+=c;const s=String(r.states);if(/resch/i.test(s))A[k].r+=c;else if(/^(pending|confirm|draft|no_show)$/.test(s))A[k].o+=c});
  const rows=rev.map(r=>{const id=r.journal_id[0],n=BR[id];const ap=A[APB[id]];const op=ap&&ap.t-ap.r>0?ap.o/(ap.t-ap.r):null;
   return{n,rev:r.price_subtotal,inv:r.move_id,avg:r.move_id?r.price_subtotal/r.move_id:0,las:L[id],op}}).sort((x,y)=>y.rev-x.rev);
  tb.innerHTML=rows.map(r=>`<tr><td>${r.n}</td><td>${Math.round(r.rev).toLocaleString('en-US')}</td><td>${r.inv.toLocaleString('en-US')}</td><td class="${r.avg<3000?'bad':''}">${Math.round(r.avg).toLocaleString('en-US')}</td><td class="${r.las!=null&&r.las<2?'bad':''}">${r.las==null?'—':r.las.toFixed(2)}</td><td class="${r.op!=null&&r.op>.2?'bad':''}">${r.op==null?'—':(r.op*100).toFixed(0)+'%'}</td></tr>`).join('');
  $('bMeta').textContent=`${a} → ${z} · billed ex-VAT · red = avg invoice under 3,000, under 2 laser sessions, or over 20% appointments left open`;
 }catch(e){tb.innerHTML=`<tr><td colspan="6">${errText(e)}</td></tr>`}}

// ---- media snapshot (Meta exports, 1 Jan – 30 Sep 2026)
const MED=[['Nouvelage · Backup',993262,5448,798526,676,20750,96155],['Nouvelage · Doctors',880531,7146,711463,3934,132205,8468],['ZAT',499767,2598,384617,2741,110207,3686],['Nouvelage · Greater Cairo',436958,1399,252538,3490,168519,6912]];
const LEADS=[['Jan',61],['Feb',318],['Mar',473],['Apr',1696],['May',1154],['Jun',1863],['Jul',3792],['Aug',2810],['Sep',2604],['Oct*',427]];
(function media(){const T=MED.reduce((s,r)=>[s[0]+r[1],s[1]+r[2],s[2]+r[3],s[3]+r[4],s[4]+r[5]],[0,0,0,0,0]);
 $('mCards').innerHTML=[['Total spend',Math.round(T[0]).toLocaleString('en-US')+' EGP','≈ '+Math.round(T[0]/9).toLocaleString('en-US')+' / month'],['Form leads',T[1].toLocaleString('en-US'),'≈ '+Math.round(T[2]/T[1])+' EGP each'],['Message chats',T[3].toLocaleString('en-US'),'≈ '+Math.round(T[4]/T[3])+' EGP each'],['Leads found in Odoo','~9%','sample of 120 · Jul–Aug'],['Leads that paid','~3%','sample of 120 · Jul–Aug']].map(([h,v,c])=>`<div class="card"><h3>${h}</h3><div class="big">${v}</div><div class="ctx">${c}</div></div>`).join('');
 $('mTbl').querySelector('tbody').innerHTML=MED.map(r=>`<tr><td>${r[0]}</td><td>${r[1].toLocaleString('en-US')}</td><td>${r[2].toLocaleString('en-US')}</td><td>${Math.round(r[3]/r[2])}</td><td>${r[4].toLocaleString('en-US')}</td><td>${Math.round(r[5]/r[4])}</td><td>${r[6].toLocaleString('en-US')}</td></tr>`).join('')+`<tr><td><b>Total</b></td><td><b>${T[0].toLocaleString('en-US')}</b></td><td><b>${T[1].toLocaleString('en-US')}</b></td><td><b>${Math.round(T[2]/T[1])}</b></td><td><b>${T[3].toLocaleString('en-US')}</b></td><td><b>${Math.round(T[4]/T[3])}</b></td><td></td></tr>`;
 const mx=Math.max(...LEADS.map(x=>x[1]));$('vb').innerHTML=LEADS.map(([m,v])=>`<div class="c"><b>${v.toLocaleString('en-US')}</b><i style="height:${Math.max(2,v/mx*120)}px"></i><span>${m}</span></div>`).join('');
 $('hTbl').innerHTML=KPI.map((k,i)=>`<tr><td>${i+1}. ${k.n}</td><td style="white-space:normal">${k.f}</td><td>${k.win}</td></tr>`).join('');
})();


// ---- forecast & commission (targets + branch pool from the target workbook)
const TG={"m": ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12"], "T": {"Alex Camp Chizar": [4000000, 4000000, 4377482, 4049171, 4000000, 4000000, 4661390, 4644352, 5065569, 6090077, 5606127, 4505919, 5060455, 4925817, 5672302], "Madinty The Strip": [4200000, 4200000, 4200000, 4200000, 4200000, 4200000, 4331139, 4315308, 4706683, 5658606, 5208943, 4200000, 4701931, 4576832, 5270430], "CFC": [4000000, 4000000, 4000000, 4000000, 4000000, 4000000, 4000000, 4000000, 4227942, 5083040, 4679114, 4000000, 4223673, 4111298, 4734347], "City Stars": [4030646, 4030646, 4030646, 4030646, 4030646, 4030646, 4030646, 4030646, 4034720, 4850739, 4465273, 4030646, 4030646, 4030646, 4517981], "Alex Roshdy": [1500000, 1500000, 1618917, 1500000, 1500000, 1500000, 1723914, 1717613, 1873391, 2252283, 2073305, 1666417, 1871500, 1821707, 2097778], "Mall of Arabia": [2000000, 2000000, 2000000, 2000000, 2000000, 2000000, 2000000, 2000000, 2000000, 2057843, 2000000, 2000000, 2000000, 2000000, 2000000], "Zayed": [1000000, 1000000, 1000000, 1000000, 1000000, 1000000, 1004059, 1000389, 1091119, 1311797, 1207555, 1000000, 1090017, 1061016, 1221809], "Mohandseen": [1000000, 1000000, 1000000, 1000000, 1000000, 1000000, 1000000, 1000000, 1078890, 1297094, 1194020, 1000000, 1077800, 1049124, 1208114], "El Rehab": [500000, 500000, 552857, 511393, 500000, 500000, 588714, 586562, 639760, 769151, 708030, 569078, 639114, 622109, 716387], "Madinty": [500000, 500000, 500000, 500000, 500000, 500000, 511139, 509271, 555459, 667800, 614733, 500000, 554898, 540134, 621989], "Loran": [500000, 500000, 500000, 500000, 500000, 500000, 500000, 500000, 513685, 617577, 568501, 500000, 513166, 500000, 575212], "Golden Square": [0, 0, 0, 0, 0, 0, 450000, 650000, 800000, 950000, 1050000, 1150000, 1250000, 1350000, 1500000]}};const POOL=[[0,500000,0,0,0,0,0],[500000,750000,4500,5500,7000,8000,9000],[750000,1000000,7500,9000,11000,12500,14000],[1000000,1500000,11000,13000,15000,17500,19500],[1500000,2000000,13000,16000,18500,21000,24000],[2000000,2500000,18000,21000,24500,28000,31000],[2500000,3000000,25000,28000,31500,35000,38000],[3000000,3500000,30000,34000,38000,42000,46000],[3500000,4000000,37000,40500,44000,47500,51000],[4000000,4500000,42000,45500,49000,52500,56000],[4500000,5000000,47000,50500,54000,57500,61000],[5000000,5500000,52000,55500,59000,62500,66000],[5500000,6000000,57000,60500,64000,67500,71000],[6000000,1e15,62000,67500,73000,78500,84000]];
const TB={'Alex Camp Chizar':104,'Madinty The Strip':105,'CFC':106,'City Stars':111,'Alex Roshdy':107,'Mall of Arabia':109,'Zayed':110,'Mohandseen':108,'El Rehab':114,'Madinty':103,'Loran':112,'Golden Square':0};
const LV=[.8,.85,.9,.95,1];
function poolFor(rev,lv){if(lv<0)return 0;const r=POOL.find(p=>rev>=p[0]&&rev<p[1]);return r?r[2+lv]:0}
function levelOf(ach){let l=-1;LV.forEach((x,i)=>{if(ach>=x-1e-9)l=i});return l}
let LM=null;
async function loadLastMonth(){if(!mcp&&!ODOO)return;const t=new Date();let y=t.getFullYear(),mo=t.getMonth();
 let a=iso(new Date(y,mo,1)),z=addD(TODAY,-1),pace=true;
 if(z<a){a=iso(new Date(y,mo-1,1));z=iso(new Date(y,mo,0));pace=false}
 const D=new Date(+z.slice(0,4),+z.slice(5,7),0).getDate(),d=+z.slice(8,10);
 try{const g=await call('account.move.line','read_group',[[['display_type','=','product'],['parent_state','=','posted'],['move_id.move_type','=','out_invoice'],['date','>=',a],['date','<=',z]],['price_subtotal:sum'],['journal_id']],{lazy:false});
  LM={a,z,d,D,pace,mtd:{},by:{}};g.forEach(r=>{if(r.journal_id){LM.mtd[r.journal_id[0]]=r.price_subtotal;LM.by[r.journal_id[0]]=r.price_subtotal/d*D}});
  const cm=a.slice(0,7);if(TG.m.includes(cm)&&!$('fMonth').dataset.touched)$('fMonth').value=cm;renderF();renderMap()}catch(e){}}
const M=v=>v>=1e6?(v/1e6).toFixed(2)+'M':Math.round(v/1e3)+'K';
function renderF(){const sel=$('fMonth');if(!sel.options.length){sel.innerHTML=TG.m.map(m=>`<option>${m}</option>`).join('');sel.onchange=()=>{sel.dataset.touched=1;renderF()}}
 const mi=TG.m.indexOf(sel.value);const j=jset()||(SEEN&&SEEN.length<Object.keys(BRL).length?SEEN:null);
 const rows=Object.entries(TG.T).map(([n,arr])=>({n,id:TB[n],t:arr[mi]||0})).filter(r=>r.t>0&&(!j||j.includes(r.id)));
 const sc=LV.map((p,li)=>{let rev=0,pool=0;rows.forEach(r=>{const v=r.t*p;rev+=v;pool+=poolFor(v,li)});return{rev,pool}});
 let nowRev=0,nowPool=0,nowMtd=0;const nowRows=rows.map(r=>{const v=LM?LM.by[r.id]||0:null;if(v==null)return{...r,v:null};const md=LM.mtd[r.id]||0;const l=levelOf(v/r.t);const pl=poolFor(v,l);nowRev+=v;nowPool+=pl;nowMtd+=md;const left=Math.max(1,LM.D-LM.d);const need=Math.max(0,(r.t*LV[GOAL]-md)/left);return{...r,v,md,l,pl,need}});
 $('fMeta').textContent=`${rows.length} branches · target ${M(rows.reduce((s,r)=>s+r.t,0))}`;
 $('fRungs').innerHTML=(LM?`<div class="rung now"><div class="l">${LM.pace?`On current pace (${LM.a.slice(8)}–${LM.z.slice(8)} ${LM.a.slice(0,7)})`:`If it stays like ${LM.a.slice(0,7)}`}</div><div class="p">${M(nowRev)}</div><div class="s">team pools ${Math.round(nowPool).toLocaleString('en-US')} EGP</div></div>`:'')+
  sc.map((x,i)=>`<div class="rung${i===GOAL?' sel':''}"><div class="l">KPIs at ${TIERL[i]}</div><div class="p">${M(x.rev)}</div><div class="s">team pools ${Math.round(x.pool).toLocaleString('en-US')} EGP</div></div>`).join('');
 const hf=document.getElementById('heroF');if(hf)hf.innerHTML=`${M(sc[GOAL].rev)}<small>${sel.value} · pools ${M(sc[GOAL].pool)} EGP</small>`;
 if(LM){const gap=sc[GOAL].rev-nowRev;const zero=nowRows.filter(r=>r.l<0).length;const left=Math.max(0,LM.D-LM.d);const needDay=left?Math.max(0,(sc[GOAL].rev-nowMtd)/left):0;const curDay=nowMtd/LM.d;
  $('fNow').innerHTML=LM.pace?`<b>الخلاصة:</b> من أول الشهر لحد ${LM.z} (${LM.d} يوم) دخل <b>${M(nowMtd)}</b>، يعني حوالي <b>${M(curDay)} في اليوم</b>. لو فضلنا ماشيين بنفس المعدل ده، الشهر هيقفل على حوالي <b>${M(nowRev)}</b>، و<b>${zero} من ${rows.length} فروع</b> هيبقوا تحت 80%، وكومشن الفرق حوالي <b>${Math.round(nowPool).toLocaleString('en-US')} جنيه</b>. عشان نوصل ${TIERL[GOAL]} (${M(sc[GOAL].rev)})، محتاجين <b>${M(needDay)} في اليوم</b> في الـ ${left} يوم الباقيين بدل ${M(curDay)}. الرقم ده بيتحدّث كل يوم: كل يوم إيراده أقل، المطلوب في الأيام الباقية بيزيد. <span class="meta">(الفواتير بتتسجل متأخر يوم أو اتنين، فأول أيام الشهر المعدل بيبان أقل من الحقيقة.)</span>`
  :`<b>الخلاصة:</b> لسه مفيش أيام كفاية من الشهر ده، فدي أرقام الشهر اللي فات (${LM.a.slice(0,7)}): <b>${M(nowRev)}</b>، و<b>${zero} من ${rows.length} فروع</b> تحت 80%، وكومشن الفرق حوالي <b>${Math.round(nowPool).toLocaleString('en-US')} جنيه</b>.`}
 else $('fNow').textContent='Loading last month from Odoo…';
 $('fTbl').querySelector('thead').innerHTML=`<tr><th>Branch</th><th>Target ${sel.value}</th><th>${LM&&LM.pace?'MTD (billed)':'Last month'}</th><th>${LM&&LM.pace?'Projected month':'—'}</th><th>Achievement</th><th>Needed / day for ${TIERL[GOAL]}</th><th>Pool on pace</th>${LV.map((p,i)=>`<th>Pool @ ${TIERL[i]}</th>`).join('')}</tr>`;
 $('fTbl').querySelector('tbody').innerHTML=nowRows.map(r=>`<tr><td>${r.n}</td><td>${M(r.t)}</td><td>${r.v==null?'—':M(r.md)}</td><td>${r.v==null||!LM.pace?'—':M(r.v)}</td><td class="${r.v!=null&&r.v/r.t<.8?'bad':r.v!=null&&r.v/r.t>=1?'good':''}">${r.v==null?'—':Math.round(r.v/r.t*100)+'%'}</td><td>${r.v==null||!LM.pace?'—':M(r.need)}</td><td>${r.v==null?'—':(r.pl||0).toLocaleString('en-US')}</td>${LV.map((p,i)=>`<td${i===GOAL?' style="font-weight:700"':''}>${poolFor(r.t*p,i).toLocaleString('en-US')}</td>`).join('')}</tr>`).join('')}


// ---- revenue map (tab 00)
const BASE_REV=17.3e6, NOW_PAT=4000, ARPP=4600;
const LEV=[
 {n:'Laser patients finish the course',ar:'مرضى الليزر يكمّلوا الكورس',t:'Internal',a:'2.08 sessions',b:'2.75 sessions',v:1.1e6,k:'KPI 1',d:'مريض الليزر محتاج 6–8 جلسات، والمتوسط عندنا جلستين في 6 شهور. كل مريض بيكمّل جلسة زيادة = فلوس من مريض إحنا دفعنا تمن جيبته خلاص. أدوات الشغل: ميعاد الجلسة الجاية يتحجز قبل ما المريض يمشي، وليستة اتصال للي وقفوا.'},
 {n:'Sell laser as packages, not single sessions',ar:'الليزر يتباع باكدج مش جلسة',t:'Internal',a:'~10% packages',b:'30% packages',v:0,k:'Protects KPI 1',d:'المريض اللي دافع باكدج مقدم بيكمّل الكورس، واللي بيدفع جلسة بجلسة بيقف بعد 2–3 جلسات. ده مش رقم إيراد لوحده، بس هو اللي بيضمن إن مؤشر 1 يتحقق، وبيجيب كاش مقدم.'},
 {n:'Lower no-show',ar:'No-show أقل',t:'Internal',a:'14.6%',b:'12.5%',v:0.6e6,k:'KPI 2',d:'كل شهر حوالي 1,080 ميعاد بيعدّي والمريض ما يجيش ومحدش يرجّعه. رسالة تأكيد قبلها بيوم، ومكالمة لنفس اليوم للي ما جاش، وكل ميعاد يتقفل في نفس اليوم.'},
 {n:'Botox patients come back on time',ar:'البوتوكس يرجع في ميعاده',t:'Internal',a:'19%',b:'32%',v:0.5e6,k:'KPI 4',d:'البوتوكس بيتعاد كل 4–6 شهور، و8 من كل 10 مرضى ما بيرجعوش. ليستة شهرية بالمرضى اللي عدّى عليهم 4 شهور، وميعاد يتحجز قبل ما يمشي.'},
 {n:'Offer injectables to laser patients',ar:'مريض الليزر يتعرض عليه حقن',t:'Internal',a:'5.7%',b:'11.3%',v:0.5e6,k:'KPI 5',d:'عندنا أكتر من 8,000 مريض ليزر في 6 شهور، و94% منهم ما اشتروش أي حاجة تانية. الدكتور أو الاستقبال يعرض استشارة سكين بوستر أو بوتوكس في الجلسة التالتة.'},
 {n:'Consultations turn into treatment',ar:'الكشف يتحول لعلاج',t:'Internal',a:'63%',b:'69%',v:0.13e6,k:'KPI 6',d:'الرقم صغير لأن الكشوفات حوالي 360 في الشهر بس، بس الفرق بين الدكاترة من 44% لـ 74%، ومدينتي إيست هب 8 من كل 10 بيمشوا. ده شغل تدريب ومتابعة دكتور دكتور.'},
 {n:'Average invoice in weak branches',ar:'متوسط الفاتورة في الفروع الضعيفة',t:'Internal',a:'1,730–1,900',b:'3,000 floor',v:0.5e6,k:'Tab 02',d:'مدينتي إيست هب ولوران متوسط الفاتورة فيهم أقل من نص باقي الفروع. باكدجات وعروض مركّبة بدل خدمات منفردة.'},
 {n:'Discounts under control',ar:'الخصومات تحت السيطرة',t:'Internal',a:'46–60% avg in 3 branches',b:'20% cap',v:0.2e6,k:'Tab 02',d:'Mall of Arabia والمهندسين والرحاب متوسط الخصم فيهم بين 46% و60%. أي خصم فوق 30% يحتاج موافقة.'},
 {n:'Win back lapsed patients',ar:'مرضى قدام يرجعوا',t:'External',a:'366 / month',b:'535 / month',v:0.8e6,k:'KPI 3',d:'حوالي 9,000 مريض جم النص الأول من السنة وما رجعوش. دول بيعرفونا وبيثقوا فينا، ورجوعهم أرخص بكتير من مريض جديد من إعلان.'},
 {n:'No lead left untouched',ar:'الليدز ما تتسابش',t:'External',a:'744 untouched / month',b:'0',v:0.4e6,k:'KPI 8',d:'كل شهر حوالي 744 ليد جديد محدش اتصل بيهم خالص، ونص الفولو أب مالوش ميعاد مكالمة جاية. كل ليد يتلمس في 24 ساعة، وكل فولو أب عليه Activity.'},
 {n:'Ad leads reach Odoo and pay',ar:'ليدز الإعلانات توصل وتدفع',t:'External',a:'~3% pay',b:'6%',v:0.35e6,k:'KPI 7 + Tab 04',d:'9 من كل 10 ليدز من الفورمز مش بيوصلوا Odoo خالص. لما كل ليد يدخل بمصدره، هنعرف أنهي حملة بتجيب مريض بيدفع، ونزوّد الصرف عليها بس.'}
];
if(Array.isArray(CFG.lev))CFG.lev.forEach((o,ix)=>{if(LEV[ix])Object.assign(LEV[ix],o)});
function renderMap(){const mi=TG.m.indexOf($('fMonth').value||TG.m[0]);const tgt=Object.values(TG.T).reduce((s,a)=>s+(a[mi>=0?mi:0]||0),0);
 const tot=LEV.reduce((s,l)=>s+l.v,0);const y27=TG.m.reduce((s,m,i)=>m.startsWith('2027')?s+Object.values(TG.T).reduce((x,a)=>x+(a[i]||0),0):s,0);
 $('rTop').innerHTML=`<div class="rung now"><div class="l">Today (September)</div><div class="p">${M(BASE_REV)}</div><div class="s">${Math.round(BASE_REV/tgt*100)}% of ${TG.m[mi>=0?mi:0]} target</div></div>
 <div class="rung"><div class="l">If every lever is closed</div><div class="p">${M(BASE_REV+tot)}</div><div class="s">${Math.round((BASE_REV+tot)/tgt*100)}% of target</div></div>
 <div class="rung"><div class="l">Month target</div><div class="p">${M(tgt)}</div><div class="s">${TG.m[mi>=0?mi:0]}</div></div>
 <div class="rung"><div class="l">2027 target</div><div class="p">${M(y27)}</div><div class="s">avg ${M(y27/12)} / month</div></div>`;
 $('rIntro').innerHTML=`<b>الفكرة باختصار:</b> الإيراد = عدد المرضى × الفلوس اللي المريض بيدفعها × عدد مرات رجوعه. الجدول تحت فيه كل ثغرة لقيناها في Odoo، ومقسومة لحاجات <b>جوه العيادة</b> (الفرع والدكتور والاستقبال) وحاجات <b>برة العيادة</b> (الكول سنتر والليدز والإعلانات). لو قفلناهم كلهم، الإيراد يطلع من حوالي <b>${M(BASE_REV)}</b> لحوالي <b>${M(BASE_REV+tot)}</b> في الشهر، يعني من <b>${Math.round(BASE_REV/tgt*100)}%</b> لـ <b>${Math.round((BASE_REV+tot)/tgt*100)}%</b> من تارجت الشهر.`;
 let cum=BASE_REV;
 $('rTbl').querySelector('tbody').innerHTML=LEV.map((l,i)=>{const p0=cum/tgt;cum+=l.v;const p1=cum/tgt;return `<tr><td>${i+1}</td><td style="white-space:normal"><b>${l.n}</b><div class="ar" style="font-size:11.5px;color:var(--muted)">${l.ar}</div></td><td>${l.t}</td>${EDIT?`<td><input class="edl" data-i="${i}" data-f="a" value="${esc(l.a)}" style="width:120px"></td><td><input class="edl" data-i="${i}" data-f="b" value="${esc(l.b)}" style="width:120px"></td><td><input class="edl" data-i="${i}" data-f="v" value="${(l.v/1e6).toFixed(2)}" style="width:70px"> M</td>`:`<td>${l.a}</td><td>${l.b}</td><td>${l.v?'+'+M(l.v):'—'}</td>`}<td>${l.v?Math.round(p0*100)+'% → '+Math.round(p1*100)+'%':'—'}</td><td>${l.k}</td></tr>`}).join('')+`<tr><td></td><td><b>Total</b></td><td></td><td></td><td></td><td><b>+${M(tot)}</b></td><td><b>${Math.round(BASE_REV/tgt*100)}% → ${Math.round((BASE_REV+tot)/tgt*100)}%</b></td><td></td></tr>`;
 cum=BASE_REV;
 $('rDesc').innerHTML=LEV.map((l,i)=>{const p0=cum/tgt;cum+=l.v;const p1=cum/tgt;return `<div class="note"><b>${i+1}. ${l.n}</b> · <span class="meta">${l.a} → ${l.b}${l.v?' · +'+M(l.v)+' / month · target '+Math.round(p0*100)+'% → '+Math.round(p1*100)+'%':''}</span>${EDIT?`<textarea class="edl ar" data-i="${i}" data-f="d" rows="3" style="width:100%;margin-top:6px">${esc(l.d)}</textarea><div hidden>`:''}<div class="ar" style="margin-top:4px">لو اشتغلنا عليها ووصلنا من <b>${l.a}</b> لـ <b>${l.b}</b>${l.v?`، الإيراد يزيد حوالي <b>${M(l.v)} في الشهر</b>، والتارجت يتحرك من <b>${Math.round(p0*100)}%</b> لـ <b>${Math.round(p1*100)}%</b>`:''}. ${l.d}</div>${EDIT?'</div>':''}</div>`}).join('')+
 `<div class="note ar" style="border-color:#9e6e4a"><b>بصراحة:</b> الـ 11 دول بيقرّبونا جداً من تارجت الربع الأخير (حوالي ${Math.round((BASE_REV+tot)/tgt*100)}%). بس تارجت 2027 متوسطه ${M(y27/12)} في الشهر، يعني محتاجين حوالي ${M(Math.max(0,y27/12-BASE_REV-tot))} زيادة في الشهر من برة الثغرات: مرضى جداد من إعلانات بقت متقاسة (بند 11)، وفرع Golden Square من أبريل 2027، وزيادة متوسط اللي المريض بيدفعه. كل الأرقام دي تقديرية من داتا Odoo يناير–سبتمبر 2026.</div>`;
 $('pTbl').querySelector('tbody').innerHTML=TG.m.map((m,i)=>{const t=Object.values(TG.T).reduce((s,a)=>s+(a[i]||0),0);const p1=t/ARPP,p2=t/5000;return `<tr><td>${m}</td><td>${M(t)}</td><td>${Math.round(p1).toLocaleString('en-US')}</td><td>${Math.round(p2).toLocaleString('en-US')}</td><td class="${p1-NOW_PAT>1500?'bad':''}">+${Math.round(p1-NOW_PAT).toLocaleString('en-US')} <span class="meta">(or +${Math.round(p2-NOW_PAT).toLocaleString('en-US')} @ 5,000)</span></td></tr>`}).join('');
 $('pNote').innerHTML=`<b>إزاي تقرا الجدول:</b> النهارده عندنا حوالي <b>4,000 مريض</b> بيدفعوا في الشهر، والمريض بيدفع في المتوسط حوالي <b>4,600 جنيه</b>. عشان نوصل لتارجت 2027 (${M(y27)})، محتاجين حوالي <b>${Math.round(y27/12/ARPP).toLocaleString('en-US')} مريض في الشهر</b> بنفس متوسط الفاتورة، أو <b>${Math.round(y27/12/5000).toLocaleString('en-US')}</b> لو المتوسط طلع 5,000. يعني يا نزوّد المرضى، يا نزوّد اللي المريض بيدفعه، والأحسن الاتنين مع بعض: بنود 1–8 بترفع اللي المريض بيدفعه وعدد مرات رجوعه، وبنود 9–11 بتزوّد عدد المرضى.`}

$('exp').onclick=async()=>{if(!LAST)return;const lines=[['KPI','Value','Tier reached','Goal','Goal value','Start (1 Oct)'].join(',')];
 KPI.forEach(k=>{const r=LAST.r[k.id];const v=r&&!r.err?r.v:null;const h=tierOf(k,v);lines.push([`"${k.n}"`,fmt(k,v),h<0?'below 80%':TIERL[h],TIERL[GOAL],fmt(k,tiers(k)[GOAL]),fmt(k,k.base)].join(','))});
 const csv=lines.join('\n');let dl=null;try{dl=window.claude&&await window.claude.use('downloads')}catch(e){}
 if(dl){try{await dl.save({filename:`performance-kpis_${LAST.a}_${LAST.z}.csv`,data:csv})}catch(e){}}else{alert('Export is not available in this view.')}};
$('syncNow').onclick=()=>load();

const [a0,z0]=preset(P);$('dFrom').value=a0;$('dTo').value=z0;segs();pills();branchSel();gday(a0,z0);
$('go').onclick=()=>{P='custom';segs();load()};
$('cards').innerHTML=KPI.map(k=>card(k,null)).join('');renderF();renderMap();$('fMonth').addEventListener('change',renderMap);
function applyScope(){const full=!SEEN||SEEN.length>=Object.keys(BRL).length;
 document.querySelectorAll('.tab[data-p="m"],.tab[data-p="r"]').forEach(t=>t.hidden=!full);
 if(!full&&document.querySelector('.tab.active[data-p="r"],.tab.active[data-p="m"]'))document.querySelector('.tab[data-p="k"]').click();
 $('fBrand').parentElement.hidden=!full;renderF()}

// ---- edit mode: owner/editors change start values, 100% levels and descriptions, then Save publishes a new version
let ART=null;
function readEdits(){const cfg={kpi:KPI.map(k=>({id:k.id,base:k.base,t100:k.t100,why:k.why})),lev:LEV.map(l=>({n:l.n,ar:l.ar,t:l.t,a:l.a,b:l.b,v:l.v,k:l.k,d:l.d}))};
 document.querySelectorAll('.ed').forEach(el=>{const o=cfg.kpi.find(x=>x.id===el.dataset.k);const k=KPI.find(x=>x.id===el.dataset.k);const f=el.dataset.f;
  if(f==='why')o.why=el.value.trim();else{const n=parseFloat(el.value);if(!isNaN(n))o[f]=frU(k,n)}});
 document.querySelectorAll('.edl').forEach(el=>{const o=cfg.lev[+el.dataset.i];const f=el.dataset.f;if(f==='v'){const n=parseFloat(el.value);if(!isNaN(n))o.v=Math.round(n*1e6)}else o[f]=el.value.trim()});
 return cfg}
function setEdit(on){EDIT=on;['saveBtn','cancelBtn'].forEach(id=>$(id).hidden=!on);$('editBtn').hidden=on||!ART;if(LAST)render(LAST);else $('cards').innerHTML=KPI.map(k=>card(k,on?{v:null}:null)).join('');renderMap()}
$('editBtn').onclick=()=>setEdit(true);
$('cancelBtn').onclick=()=>setEdit(false);
$('saveBtn').onclick=async()=>{const cfg=readEdits();const json=JSON.stringify(cfg).replace(/</g,'\\u003c');
 const html=SRC.replace(/(<script type="application\/json" id="cfg">)[\s\S]*?(<\/script>)/,'$1'+json.replace(/\$/g,'$$$$')+'$2');
 $('saveBtn').textContent='Saving…';try{await ART.publish(html)}catch(e){$('saveBtn').textContent='Save';alert(e&&e.code==='conflict'?'Someone saved a newer version; the page will reload to it.':'Could not save: '+((e&&e.code)||'error'))}};
(async()=>{try{ART=window.claude&&await window.claude.use('artifact')}catch(e){ART=null}
 let ok=!!ART;try{const u=window.claude&&await window.claude.use('user');if(u&&u.canEdit&&u.canEdit()===false)ok=false}catch(e){}
 if(ODOO)ok=false;if(!ok)ART=null;$('editBtn').hidden=!ART})();

async function initScope(){try{const g=await call('account.move','read_group',[[['move_type','=','out_invoice'],['state','=','posted'],['invoice_date','>=',addD(TODAY,-120)],['journal_id','in',Object.keys(BRL).map(Number)]],['id:count'],['journal_id']],{lazy:false});
 SEEN=g.map(r=>r.journal_id&&r.journal_id[0]).filter(j=>BRL[j]);if(!SEEN.length)SEEN=null}catch(e){SEEN=null}
 if(SEEN&&SEEN.length<Object.keys(BRL).length&&SEEN.length===1)BRANCH=String(SEEN[0]);branchSel();applyScope()}
(async()=>{if(ODOO){ME=await whoAmI()}else{try{mcp=window.claude&&window.claude.use?await window.claude.use('mcp'):null}catch(e){mcp=null}}
 if(mcp||ODOO)await initScope();load()})();
