let {E,B,P,D,R}=DATA;let LG=DATA.LG||[]; // R: [date,hour,emp,br,dep,doc,outcome,showAny,rev,team]
const O_NB=0,O_ATT=1,O_UP=4,O_CN=3;
const $=s=>document.querySelector(s);
const fmt=n=>Math.round(n).toLocaleString('en-US');
const pct=(a,b)=>b?Math.round(a/b*100):null;
const pctS=(a,b)=>{const p=pct(a,b);return p==null?'—':p+'%'};
const FLOOR=75;
/* ---------- reports nav ---------- */
const IC={bar:'<path d="M3 21h18M6 17V9M11 17V5M16 17v-6"/>',steth:'<path d="M6 3v6a4 4 0 0 0 8 0V3M10 13v3a5 5 0 0 0 10 0v-2"/><circle cx="20" cy="12" r="2"/>',bag:'<path d="M5 8h14l-1 13H6zM9 8V6a3 3 0 0 1 6 0v2"/>',gauge:'<circle cx="12" cy="13" r="8"/><path d="M12 13l4-4"/>',funnel:'<path d="M3 4h18l-7 9v7l-4-2v-5z"/>',mega:'<path d="M3 11v3l12 5V6L3 11zM15 9a3 3 0 0 1 0 6"/>',box:'<path d="M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7"/>',store:'<path d="M4 9h16v11H4zM4 9l2-5h12l2 5M9 20v-6h6v6"/>',head:'<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1"/><rect x="17" y="14" width="4" height="6" rx="1"/>',sliders:'<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'};
const PAGES=[['NRS','Doctors, branches, targets','bar'],['Doctors Performance','Targets, ticket size, injectables','steth'],['Commercial Sales','Revenue ex-package, mix, payments','bag'],['Targets & Doctor Commission','Targets, branches, payslips','gauge'],['Commercial','The funnel, end to end','funnel'],['Marketing','Meta spend, leads, organic','mega'],['Inventory Performance','Cover, expiry, at-risk','box'],['Procurement & Products','Purchases, vendors, cash b…','store'],['Contact Centre','Queues, agents, bookings','head']];
/* ---------- users (prototype) ---------- */
const empIdx=n=>E.indexOf(n),brIdx=n=>B.indexOf(n),docIdx=n=>D.indexOf(n);
const USERS=[
 {id:'owner',name:'Youssef Attalla',rl:'Owner · all data',mail:'youssef@nouvelage.fr',role:'owner',pages:'all',scope:r=>true,lock:{},can:{exp:1,imp:1,sync:1}},
 {id:'ccm',name:'Contact Centre Manager',rl:'All contact-centre records',mail:'callcenter.manager@nouvelage.fr',role:'ccm',pages:['Contact Centre','Commercial'],scope:r=>true,lock:{},can:{exp:1,imp:0,sync:1}},
 {id:'agent',name:'Hend Ehab',rl:'Agent · her own opportunities',mail:'hend.ehab@nouvelage.fr',role:'agent',pages:['Contact Centre'],scope:r=>r[2]===empIdx('Hend Ehab Hassan'),lock:{agent:empIdx('Hend Ehab Hassan'),team:'1'},can:{exp:0,imp:0,sync:0}},
 {id:'bm',name:'CFC Branch Manager',rl:'Branch · CFC only',mail:'cfc.manager@nouvelage.fr',role:'bm',pages:['Contact Centre','Doctors Performance','Commercial Sales','Targets & Doctor Commission','Inventory Performance'],scope:r=>r[3]===brIdx('CFC'),lock:{branch:brIdx('CFC')},can:{exp:1,imp:0,sync:0}},
 {id:'doc',name:'Dr. Dimiana Saif',rl:'Doctor · her bookings',mail:'dimiana.saif@nouvelage.fr',role:'doc',pages:['Doctors Performance','Targets & Doctor Commission','Contact Centre'],scope:r=>r[5]===docIdx('Dr. Dimiana Saif'),lock:{doctor:docIdx('Dr. Dimiana Saif'),team:'all'},can:{exp:0,imp:0,sync:0}}];
/* ---------- state ---------- */
const st={from:'2026-09-01',to:'2026-09-30',preset:'today',entity:'all',branch:'all',doctor:'all',agent:'all',dept:'all',team:'1',who:'owner',tab:'pa',sort:{}};
function cairoToday(){const s=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());return s}
const iso=d=>d.toISOString().slice(0,10);
function addDays(s,n){const d=new Date(s+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return iso(d)}
function presetRange(p){const t=cairoToday();const [y,m]=t.split('-').map(Number);
 if(p==='today')return [t,t];if(p==='yesterday'){const y1=addDays(t,-1);return [y1,y1]}if(p==='7d')return [addDays(t,-6),t];
 if(p==='mtd')return [t.slice(0,8)+'01',t];
 if(p==='lm'){const f=new Date(Date.UTC(y,m-2,1)),l=new Date(Date.UTC(y,m-1,0));return [iso(f),iso(l)]}
 if(p==='qtd'){const q=Math.floor((m-1)/3)*3;return [iso(new Date(Date.UTC(y,q,1))),t]}
 if(p==='ytd')return [y+'-01-01',t]}
const dmy=s=>s.split('-').reverse().join('/');
/* ---------- url ---------- */
function readURL(){try{const u=new URLSearchParams(location.search);for(const k of ['from','to','entity','preset','team'])if(u.get(k))st[k]=u.get(k)}catch(e){}}
function writeURL(){try{const u=new URLSearchParams({from:st.from,to:st.to,entity:st.entity,team:st.team});if(st.preset)u.set('preset',st.preset);history.replaceState(null,'','?'+u.toString())}catch(e){}}
/* ---------- data ---------- */
const user=()=>USERS.find(u=>u.id===st.who);
function scoped(){const u=user();return R.filter(u.scope)}
function inRange(r){return r[0]>=st.from&&r[0]<=st.to}
function entityOK(){return true}
const ZATB=new Set(['Madinity','El Rehab','Golden Square']);
function brandOK(name){return st.entity==='all'||(st.entity==='zat')===ZATB.has(name)}
function rows(opts={}){const U=user();return scoped().filter(r=>brandOK(B[r[3]])&&inRange(r)
 &&(opts.ignoreTeam||st.team==='all'||String(r[9])===st.team)
 &&(st.branch==='all'||r[3]==+st.branch)&&(st.doctor==='all'||r[5]==+st.doctor)
 &&(st.agent==='all'||r[2]==+st.agent)&&(st.dept==='all'||r[4]==+st.dept))}
function agg(rs){const a={n:0,bk:0,nb:0,up:0,show:0,cn:0,ns:0,rev:0,own:0};
 for(const r of rs){a.n++;if(r[6]===O_NB){a.nb++;continue}a.bk++;if(r[7]){a.show++;a.rev+=r[8]}else if(r[6]===O_UP)a.up++;else if(r[6]===O_CN)a.cn++;else a.ns++;if(r[6]===O_ATT)a.own++}
 a.past=a.bk-a.up;a.br=pct(a.bk,a.n);a.sr=pct(a.show,a.past);return a}
function group(rs,i){const m=new Map();for(const r of rs){const k=typeof i==='function'?i(r):r[i];if(!m.has(k))m.set(k,[]);m.get(k).push(r)}return m}
const pill=v=>v==null?'<span class="dim">—</span>':`<span class="pill ${v>=FLOOR?'p-g':v>=50?'p-w':'p-b'}">${v}%</span>`;
/* ---------- filter controls ---------- */
function opts(sel,list,cur,allLabel,lockIdx,lockLabel){const el=$(sel);if(lockIdx!=null)list=[[lockIdx,lockLabel]];
 el.innerHTML=(lockIdx==null?`<option value="all">${allLabel}</option>`:'')+list.map(([k,label,n])=>`<option value="${k}">${label}${n!=null?' ('+n+')':''}</option>`).join('');
 el.value=lockIdx!=null?String(lockIdx):(list.some(([k])=>String(k)===String(cur))?String(cur):'all');el.disabled=lockIdx!=null;el.title=lockIdx!=null?'Locked by your permissions':'';return el.value}
function buildFilters(){const U=user(),L=U.lock;
 if(L.team){st.team=L.team}
 document.querySelectorAll('#team button').forEach(b=>{b.setAttribute('aria-pressed',b.dataset.t===st.team);b.disabled=!!L.team;b.style.opacity=L.team&&b.dataset.t!==st.team?.35:''});
 const base=scoped().filter(r=>inRange(r)&&(st.team==='all'||String(r[9])===st.team));
 const cnt=(i)=>[...group(base,i).entries()].sort((a,b)=>b[1].length-a[1].length);
 st.branch=opts('#fBranch',cnt(3).map(([k,v])=>[k,B[k],v.length]),st.branch,'All branches',L.branch,B[L.branch]);
 st.doctor=opts('#fDoctor',cnt(5).map(([k,v])=>[k,D[k]==='—'?'No doctor yet':D[k],v.length]),st.doctor,'All doctors',L.doctor,D[L.doctor]);
 st.agent=opts('#fAgent',cnt(2).map(([k,v])=>[k,E[k],v.length]),st.agent,'Everyone',L.agent,E[L.agent]);
 st.dept=opts('#fDept',cnt(4).map(([k,v])=>[k,P[k],v.length]),st.dept,'All departments');
 $('#bExport').style.display=U.can.exp?'':'none';$('#bSync').style.display=U.can.sync?'':'none';
 $('#team').style.display=L.team?'none':'';
 [['#fBranch','branch'],['#fDoctor','doctor'],['#fAgent','agent']].forEach(([s,k])=>{$(s).closest('label').style.display=L[k]!=null?'none':''});
}
function syncBar(){document.querySelectorAll('#preset button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.p===st.preset));
 document.querySelectorAll('#entity button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.e===st.entity));
 $('#dFrom').value=st.from;$('#dTo').value=st.to}
/* ---------- render ---------- */
function render(){
 syncBar();buildFilters();writeURL();
 const U=user();
 const rs=rows(),a=agg(rs);const empty=!rs.length;
 $('#stCount').textContent=fmt(scoped().filter(r=>entityOK()&&inRange(r)).length)+' opportunities';
 $('#hRange').textContent='· '+st.from+' → '+st.to;
 $('#hLede').textContent=U.role==='agent'?'Your opportunities for the range you pick — booked, upcoming and showed.':U.role==='bm'?'Contact-centre bookings sent to your branch, and who actually came in.':U.role==='doc'?'Contact-centre bookings made with you, and who actually came in.':'What the agents logged in Odoo for the range you pick — every panel follows the filters above.';
 const hs=[['Opportunities',empty?'—':fmt(a.n),'opened in Odoo'],['Booking rate',empty?'—':pctS(a.bk,a.n),fmt(a.bk)+' booked'],['Showed',empty?'—':fmt(a.show),'patients in the chair'],['Show rate',empty?'—':pctS(a.show,a.past),'policy floor is 75%']];
 $('#hStats').innerHTML=hs.map(h=>`<div><div class="k">${h[0]}</div><div class="v">${h[1]}</div><div class="d">${h[2]}</div></div>`).join('');
 $('#strip').innerHTML=empty?`<span class="warn">no Odoo records for this range</span>`:`<span><b>${fmt(a.n)}</b>opportunities ·</span><span><b>${fmt(a.bk)}</b>booked ·</span><span><b>${fmt(a.show)}</b>showed ·</span><span><b>${pctS(a.show,a.past)}</b>show rate ·</span><span class="warn">no call direction in Odoo</span>`;
 $('#emptyNote').innerHTML=empty?`<div class="notice ar red"><b>مفيش داتا للفترة دي.</b> ${LIVE.on?'أودو مفيهوش فرص كول سنتر في الفترة دي':'النسخة دي فيها فرص الكول سنتر من ١ لـ ٣٠ سبتمبر ٢٠٢٦ بس'}${st.entity==='zat'?'، ومفيهاش داتا ZAT لأنها مش على نفس الشركة في أودو':''}. اختار Last month أو حط تاريخ جوه سبتمبر. الأصفار هنا كانت هتبان كأن الكول سنتر مشتغلش، وده مش صح.</div>`:'';
 $('#h1t').textContent=empty?'Nothing in this range':`${fmt(a.n)} opportunities, ${fmt(a.bk)} booked, ${fmt(a.show)} in the chair`;
 const C={esp:'#58382c',car:'#9e6e4a',tau:'#c3a494',bad:'#a2412f',bone:'#e2d6cf'};
 $('#kCards').innerHTML=[['Opportunities',fmt(a.n),`${fmt(a.nb)} not booked`,1],['Booked',fmt(a.bk),`${pctS(a.bk,a.n)} booking rate`],['Showed',fmt(a.show),`${pctS(a.show,a.past)} of past bookings<br><em>matched by patient</em>`],['Upcoming',fmt(a.up),'dated in the future'],['Not closed',fmt(a.ns),'date passed, no visit found'],['Cancelled',fmt(a.cn),'no visit found'],['EGP',fmt(a.rev),'invoiced on showed visits<br><em>indicative</em>']]
  .map(c=>`<div class="card ${c[3]?'dark':''}"><div class="k">${c[0]}</div><div class="v">${empty?'—':c[1]}</div><div class="d">${empty?'&nbsp;':c[2]}</div></div>`).join('');
 const parts=[['Showed',a.show,C.esp],['Upcoming',a.up,C.car],['Not closed',a.ns,C.tau],['Cancelled',a.cn,C.bad],['No booking',a.nb,C.bone]];
 $('#oBar').innerHTML=empty?'':parts.map(p=>`<span title="${p[0]} ${p[1]}" style="width:${p[1]/a.n*100}%;background:${p[2]}"></span>`).join('');
 $('#oKey').innerHTML=empty?'':parts.map(p=>`<span><i style="background:${p[2]}"></i>${p[0]} ${fmt(p[1])} · ${pctS(p[1],a.n)}</span>`).join('');
 // histogram
 const hrs=[...Array(13)].map((_,i)=>9+i);const gh=group(rs,1);const mx=Math.max(1,...hrs.map(h=>(gh.get(h)||[]).length));
 $('#hist').innerHTML=empty?'<div class="empty">No opportunities in this range.</div>':`<div class="hist" style="grid-template-columns:repeat(${hrs.length},minmax(0,1fr))">${hrs.map(h=>{const v=gh.get(h)||[],b=v.filter(r=>r[6]!==O_NB).length;return `<div class="b" title="${h}:00 — ${v.length} opportunities, ${b} booked"><span class="lt" style="height:${(v.length-b)/mx*100}%"></span><span style="height:${b/mx*100}%;border-radius:0"></span></div>`}).join('')}</div>
  <div class="hlab" style="grid-template-columns:repeat(${hrs.length},minmax(0,1fr))">${hrs.map(h=>{const v=gh.get(h)||[];return `<div>${String(h).padStart(2,'0')}<small>${v.length?pctS(v.filter(r=>r[6]!==O_NB).length,v.length):'—'}</small></div>`}).join('')}</div>
  <div class="legend"><span><i style="background:${C.esp}"></i>Booked</span><span><i style="background:${C.tau}"></i>Not booked</span></div>
  <p class="hcap">The second line is the booking rate for opportunities opened in that hour.</p>`;
 // daily table
 const gd=[...group(rs,0).entries()].sort();
 table('#tDaily',gd.map(([d,v])=>({d,...agg(v)})),[['Date','d','t'],['Opportunities','n'],['Booked','bk'],['Booking rate','br','%'],['Showed','show'],['Show rate','sr','p'],['Source','src','tag']],'d',1);
 // agents
 const ga=[...group(rs,2).entries()].map(([k,v])=>{const lg=[...group(v,10).entries()].sort((a,b)=>b[1].length-a[1].length);const login=lg.length?LG[lg[0][0]]:'';const e=empInfo(E[k]);const xl=lg.some(([li])=>crossLogin(E[k],LG[li]));return {name:E[k],login:login+(lg.length>1?` +${lg.length-1}`:''),role:e?(e.job||e.dept||'—'):'Not in HR',xl:xl?'Cross-login':'',...agg(v)}});
 $('#h2t').textContent=empty?'Nobody in this range':`${ga.length} ${ga.length===1?'person':'people'} opened these opportunities`;
 table('#tAgents',ga,[['Person','name','t'],['Login','login','t'],['Role','role','t'],['Flag','xl','t'],['Opps','n'],['Booked','bk'],['Booking rate','br','%'],['No booking','nb'],['Upcoming','up'],['Showed','show'],['Show rate','sr','p'],['Not closed','ns'],['Cancelled','cn'],['Closed on own booking','own'],['EGP','rev']],'n');
 const gb=[...ga].filter(x=>x.past>0).sort((x,y)=>y.sr-x.sr);
 $('#agBars').innerHTML=gb.length?gb.map(x=>`<div class="hbar"><span>${x.name}</span><span class="tr"><i style="width:${x.sr}%"></i><b style="left:${FLOOR}%"></b></span><span>${x.sr}% <small>of ${x.past}</small></span></div>`).join(''):'<div class="empty">No past bookings in this range.</div>';
 const own=ga.reduce((s,x)=>s+x.own,0),sh=ga.reduce((s,x)=>s+x.show,0);
 $('#agNote').innerHTML=`<b>ليه «Closed on own booking» أقل بكتير من Showed؟</b> ${fmt(own)} حجز بس اتقفل «حضرت» على نفس حجز البنت، مع إن ${fmt(sh)} مريضة جت فعلاً. الفرق ده كريدت ضايع على البنات لحد ما الفروع تعمل Check-in على الحجز الموجود. ولحد ما ده يحصل، NRS بيحسب الحضور بمطابقة المريضة.`;
 // timing
 const W=[['Sat',6],['Sun',0],['Mon',1],['Tue',2],['Wed',3],['Thu',4],['Fri',5]];const wd=r=>new Date(r[0]+'T12:00:00Z').getUTCDay();
 const hm=new Map();let hmx=1;for(const r of rs){const k=wd(r)+'-'+r[1];hm.set(k,(hm.get(k)||0)+1)}for(const v of hm.values())hmx=Math.max(hmx,v);
 const gw=group(rs,wd);
 $('#tHeat').innerHTML=empty?'<tbody><tr><td class="empty">No opportunities in this range.</td></tr></tbody>':`<thead><tr><th></th>${hrs.map(h=>`<th>${String(h).padStart(2,'0')}</th>`).join('')}<th>Total</th></tr></thead><tbody>${W.map(([n,i])=>`<tr><td class="nm">${n}</td>${hrs.map(h=>{const v=hm.get(i+'-'+h)||0,al=v/hmx;return `<td style="background:color-mix(in srgb,#58382c ${Math.round(al*92)}%,transparent);color:${al>.5?'#fff':'inherit'}">${v||''}</td>`}).join('')}<td><b>${(gw.get(i)||[]).length}</b></td></tr>`).join('')}</tbody>`;
 const pk=[...group(rs,1).entries()].sort((a,b)=>b[1].length-a[1].length)[0];
 $('#h3t').textContent=empty?'No opportunities in this range':`Busiest at ${String(pk[0]).padStart(2,'0')}:00 — ${fmt(pk[1].length)} opportunities`;
 table('#tWd',W.map(([n,i])=>({name:n,...agg(gw.get(i)||[])})),[['Weekday','name','t'],['Opportunities','n'],['Booked','bk'],['Booking rate','br','%'],['Showed','show'],['Show rate','sr','p']],null);
 // branches, doctors
 const gbr=[...group(rs,3).entries()].map(([k,v])=>({name:B[k],...agg(v)}));
 $('#h4t').textContent=empty?'Nothing in this range':`${gbr.filter(x=>x.name!=='No branch').length} branches, ${new Set(rs.map(r=>r[5])).size-(rs.some(r=>D[r[5]]==='—')?1:0)} doctors`;
 table('#tBranch',gbr,[['Branch','name','t'],['Opportunities','n'],['Booked','bk'],['Upcoming','up'],['Showed','show'],['Show rate','sr','p'],['Not closed','ns'],['Cancelled','cn'],['EGP','rev']],'n');
 const gdc=[...group(rs.filter(r=>D[r[5]]!=='—'),5).entries()].map(([k,v])=>({name:D[k],...agg(v)})).sort((x,y)=>y.bk-x.bk).slice(0,15);
 table('#tDoctor',gdc,[['Doctor','name','t'],['Booked','bk'],['Upcoming','up'],['Showed','show'],['Show rate','sr','p'],['Cancelled','cn'],['EGP','rev']],'bk');
 // data quality (always over the scoped call-centre team in range)
 const T=agg(scoped().filter(r=>inRange(r)&&r[9]===1));
 $('#dq3').textContent=`في الفترة دي، ${fmt(T.own)} حجز بس اتقفل على حجز البنت، و${fmt(T.show)} مريضة جت فعلاً.`;
 $('#dq5').textContent=`${fmt(scoped().filter(r=>inRange(r)&&r[9]===1&&B[r[3]]==='No branch').length)} فرصة اتفتحت من غير فرع، فمش هنعرف الطلب كان على أنهي فرع.`;
 $('#dq6').textContent=`${fmt(T.ns)} حجز ميعاده عدّى ومفيش زيارة للمريضة، وحالته لسه Pending أو Confirmed.`;
 renderIDQ();
 renderCRM();renderUCM();renderAppt();renderSrcAll();
 lastTables.current=st.tab;
}

function renderCRM(){
 const {U,Bs,Ty,OUT}=CRM;const PN=CRM.PN||[];
 const brName=st.branch==='all'?null:B[+st.branch];const brOK=i=>!brName||Bs[i]===brName;
 const inR=d=>d>=st.from&&d<=st.to;const pName=st.agent==='all'?null:E[+st.agent];
 const L=CRM.L.filter(r=>inR(r[0])&&brOK(r[3])&&brandOK(Bs[r[3]])&&(!pName||PN[r[7]]===pName));
 const A=CRM.A.filter(r=>inR(r[0])&&brOK(r[6])&&brandOK(Bs[r[6]])&&(!pName||(r[8]>=0&&PN[r[8]]===pName)));
 const RB=CRM.RB.filter(r=>inR(r[0])&&brOK(r[1])&&brandOK(Bs[r[1]])&&(st.agent==='all'||r[5]==+st.agent)&&(st.team==='all'||String(r[6])===st.team));
 const empty=!L.length&&!A.length;renderLeadSource(L);
 const ccOp=r=>{const e=empInfo(PN[r[7]]);return e&&e.dept==='Contact Center'};
 const nCC=L.filter(ccOp).length,bk=L.filter(r=>r[4]).length;
 const done=A.filter(r=>r[4]===2).length,over=A.filter(r=>r[4]===1).length,dup=L.filter(r=>r[6]).length,ovw=L.filter(r=>r[8]).length;
 const unst=L.filter(r=>isUnstamped(PN[r[7]])).length;
 $('#hct').textContent=empty?'Nothing in this range':`${fmt(L.length)} opportunities by ${fmt(new Set(L.map(r=>r[7])).size)} people`;
 $('#cCards').innerHTML=[['Opportunities',fmt(L.length),`${fmt(L.length-unst)} stamped with a person`,1],['By the contact centre',fmt(nCC),pctS(nCC,L.length)+' opened by Contact Center staff'],['By branches',fmt(L.length-nCC),'receptionists & managers'],['Booked',fmt(bk),pctS(bk,L.length)+' have an appointment'],['Activities done',fmt(done),'marked done in the range'],['Overdue',fmt(over),'open, past their due date'],['Duplicates',fmt(dup),'branch reopened a CC patient'],['Overwritten',fmt(ovw),'“Last touched” ≠ opener']]
  .map(c=>`<div class="card ${c[3]?'dark':''}"><div class="k">${c[0]}</div><div class="v">${empty?'—':c[1]}</div><div class="d">${empty?'&nbsp;':c[2]}</div></div>`).join('');
 const med=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)]};
 // ---- who opened: login -> people (expandable)
 const stat=v=>{const lg=v.filter(r=>r[5]>=0).map(r=>r[5]);const b=v.filter(r=>r[4]).length;return {n:v.length,bk:b,br:pct(b,v.length),med:med(lg),dup:v.filter(r=>r[6]).length,ovw:v.filter(r=>r[8]).length}};
 const byLogin=[...group(L,2).entries()].map(([k,v])=>({login:U[k],v,...stat(v)})).sort((a,b)=>b.n-a.n);
 st.open=st.open||new Set();
 const cell=(x,k)=>k==='br'?(x.br==null?'—':x.br+'%'):k==='med'?(x.med==null?'—':x.med+' min'):fmt(x[k]);
 const COLS=[['Opportunities','n'],['Booked','bk'],['Booking %','br'],['Minutes to booking','med'],['Duplicates of CC','dup'],['Last touched by someone else','ovw']];
 let html=`<thead><tr><th class="l">Login / person</th>${COLS.map(c=>`<th>${c[0]}</th>`).join('')}<th class="l">Flag</th></tr></thead><tbody>`;
 for(const g of byLogin){const op=st.open.has(g.login);
  html+=`<tr class="lg-row" data-lg="${g.login}" tabindex="0" role="button" aria-expanded="${op}"><td class="nm"><span class="chev">${op?'▾':'▸'}</span> ${g.login} <small>${new Set(g.v.map(r=>r[7])).size} people · shared login</small></td>${COLS.map(c=>`<td><b>${cell(g,c[1])}</b></td>`).join('')}<td></td></tr>`;
  if(op){const ppl=[...group(g.v,7).entries()].map(([k,v])=>({name:PN[k],...stat(v)})).sort((a,b)=>b.n-a.n);
   for(const p of ppl){const e=empInfo(p.name);const xl=crossLogin(p.name,g.login);const flag=isUnstamped(p.name)?'<span class="tag" style="background:#eee;color:#666">Unstamped</span>':xl?`<span class="tag" style="background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)" title="Home login: ${e.home}${e.allowed&&e.allowed.length?'':' · not in allowed list'}">Cross-login · home ${e.home}</span>`:(e&&!e.active?'<span class="tag" style="background:color-mix(in srgb,var(--bad) 14%,transparent);color:var(--bad)">Inactive employee</span>':'');
    html+=`<tr class="pp-row"><td style="padding-left:40px">${p.name}<small style="display:block;color:var(--muted)">${e?[e.job,e.dept].filter(Boolean).join(' · ')||'No job or department in HR':'Not found in HR'}</small></td>${COLS.map(c=>`<td>${cell(p,c[1])}</td>`).join('')}<td class="l">${flag}</td></tr>`}}
 }
 html+='</tbody>';const tl=$('#tCrmLogin');tl.innerHTML=empty?'<tbody><tr><td class="empty">Nothing in this range.</td></tr></tbody>':html;
 lastTables['#tCrmLogin']={cols:[['Login','login','t'],...COLS.map(c=>[c[0],c[1]])],rows:byLogin};
 tl.querySelectorAll('.lg-row').forEach(r=>{const tg=()=>{const k=r.dataset.lg;st.open.has(k)?st.open.delete(k):st.open.add(k);renderCRM()};r.onclick=tg;r.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();tg()}}});
 // ---- activities by person
 const who=r=>r[8]>=0?PN[r[8]]:`Unstamped (login: ${U[r[3]]})`;
 const ga=[...group(A,who).entries()].map(([k,v])=>({name:k,n:v.length,done:v.filter(r=>r[4]===2).length,open:v.filter(r=>r[4]===0).length,over:v.filter(r=>r[4]===1).length,cc:v.filter(r=>r[7]).length}));
 table('#tActLogin',ga,[['Person','name','t'],['Activities','n'],['Done','done'],['Open','open'],['Overdue','over'],['On CC opps','cc']],'n');
 const gt=[...group(A,2).entries()].map(([k,v])=>({name:Ty[k],n:v.length,done:v.filter(r=>r[4]===2).length,over:v.filter(r=>r[4]===1).length}));
 table('#tActType',gt,[['Activity type','name','t'],['Activities','n'],['Done','done'],['Overdue','over']],'n');
 const oo=A.filter(r=>r[5]>=0),go=[...group(oo,5).entries()].sort((a,b)=>b[1].length-a[1].length),omx=Math.max(1,...go.map(x=>x[1].length));
 $('#outBars').innerHTML=go.length?go.map(([k,v])=>`<div class="hbar"><span>${OUT[k]}</span><span class="tr"><i style="width:${v.length/omx*100}%"></i></span><span>${fmt(v.length)} <small>${pctS(v.length,oo.length)}</small></span></div>`).join(''):'<div class="empty">No open activities in this range.</div>';
 const days=[...new Set(A.map(r=>r[0]))].sort(),gd=group(A,0),dmx=Math.max(1,...days.map(d=>gd.get(d).length));
 $('#actHist').innerHTML=days.length?`<div class="hist" style="grid-template-columns:repeat(${days.length},minmax(0,1fr))">${days.map(d=>{const v=gd.get(d),dn=v.filter(r=>r[4]===2).length;return `<div class="b" title="${d}: ${v.length} activities, ${dn} done"><span class="lt" style="height:${(v.length-dn)/dmx*100}%"></span><span style="height:${dn/dmx*100}%;border-radius:0"></span></div>`}).join('')}</div><div class="hlab" style="grid-template-columns:repeat(${days.length},minmax(0,1fr))">${days.map(d=>`<div>${+d.slice(8)}</div>`).join('')}</div><div class="legend"><span><i style="background:#58382c"></i>Done</span><span><i style="background:#c3a494"></i>Logged, still open</span></div>`:'<div class="empty">No activities in this range.</div>';
 // ---- re-booked
 const own=RB.filter(r=>r[4]===1).length,re=RB.length-own;
 $('#rbNote').innerHTML=`<b>من كل ${fmt(RB.length)} مريضة اتحجزلها من الكول سنتر وجت فعلاً، ${fmt(re)} (${pctS(re,RB.length)}) اتعملها حجز جديد</b> وحجز الكول سنتر اتساب مفتوح. الباقيين (${fmt(own)}) اتعملهم Check-in على نفس الحجز، وده الصح.`;
 $('#rbCards').innerHTML=[['CC bookings that showed',fmt(RB.length),'patient matched',1],['Closed on the CC booking',fmt(own),pctS(own,RB.length)+' — the right way'],['Re-booked',fmt(re),pctS(re,RB.length)+' — credit lost']]
  .map(c=>`<div class="card ${c[3]?'dark':''}"><div class="k">${c[0]}</div><div class="v">${RB.length?c[1]:'—'}</div><div class="d">${RB.length?c[2]:'&nbsp;'}</div></div>`).join('');
 const rbWho=r=>r[7]>=0?PN[r[7]]:`Unstamped (login: ${U[r[2]]})`;
 const gb=[...group(RB,1).entries()].map(([k,v])=>{const r=v.filter(x=>x[4]===0);const top=[...group(r,rbWho).entries()].sort((a,b)=>b[1].length-a[1].length)[0];return {name:Bs[k],n:v.length,own:v.length-r.length,re:r.length,rp:pct(r.length,v.length),by:top?top[0]:'—'}});
 table('#tRbBranch',gb,[['Branch','name','t'],['Showed','n'],['Closed on CC booking','own'],['Re-booked','re'],['Re-booked %','rp','%'],['Mostly re-booked by','by','t']],'re');
 const gag=[...group(RB,5).entries()].map(([k,v])=>{const r=v.filter(x=>x[4]===0).length;return {name:E[k],n:v.length,own:v.length-r,re:r,rp:pct(r,v.length)}});
 table('#tRbAgent',gag,[['Person','name','t'],['Showed','n'],['Credited','own'],['Credit lost','re'],['Lost %','rp','%']],'n');
 const dupR=L.filter(r=>r[6]);
 const gdup=[...group(dupR,3).entries()].map(([k,v])=>{const g=[...group(v,7).entries()].sort((a,b)=>b[1].length-a[1].length)[0];return {name:Bs[k],n:v.length,bk:v.filter(r=>r[4]).length,by:g?`${PN[g[0]]} (${g[1].length})`:'—'}});
 table('#tDup',gdup,[['Branch','name','t'],['Duplicate opportunities','n'],['With a new booking','bk'],['Mostly opened by','by','t']],'n');
 $('#crmFix').innerHTML=`<div class="notice ar red"><b>١. الريسبشن يعمل Check-in على حجز الكول سنتر.</b> ${fmt(re)} حجز اتعملوا من جديد في الفترة دي، و${fmt(dup)} أوبورتيونيتي اتفتحت للمريضة تاني. الجدول اللي فوق بيقول مين بالاسم.</div>
 <div class="notice ar red"><b>٢. الأكتيفيتي المفتوحة تتقفل.</b> ${fmt(over)} أكتيفيتي ميعادها عدّى ولسه مفتوحة.</div>
 <div class="notice ar red"><b>٣. «Last touched» بيتمسح مع كل تعديل.</b> ${fmt(ovw)} أوبورتيونيتي حقل الموظف فيها اتغيّر لاسم غير اللي فتحها. NRS بقى بياخد اللي فتح من أول رسالة في الشاتر، بس الحقل نفسه لازم يتقفل بعد الإنشاء.</div>
 <div class="notice ar"><b>٤. النتيجة تتكتب بكلمات ثابتة.</b> الملخصات مكتوبة بأكتر من ٦٠ طريقة. قايمة اختيارات ثابتة هتخلّي الأرقام مظبوطة من غير تخمين.</div>`;
}
/* ================= UCM ================= */
const UCM={calls:[],weeks:[],ext:null,db:null,canWrite:false,mem:false,ready:false};
const DEF_EXT=[["1028", "Maha HR", "", "other", ""], ["1030", "Hellana HR", "", "other", ""], ["1031", "HR", "", "other", ""], ["1036", "Saad Hassan", "", "other", ""], ["1040", "Fatma", "", "other", ""], ["1041", "Mina Saeed", "", "other", ""], ["1043", "Micheal", "", "other", ""], ["1045", "Mohamed", "", "other", ""], ["1046", "Emad", "", "other", ""], ["1047", "1047", "", "other", ""], ["1048", "Madonna", "", "other", ""], ["1049", "1049", "", "other", ""], ["1050", "Mohamed Bayome", "", "other", ""], ["1060", "ACC Mohandsin", "", "other", ""], ["1061", "Nourhan Safwat", "", "other", ""], ["1063", "Engy", "", "other", ""], ["1070", "ACC Loran", "", "other", ""], ["1071", "Loran", "", "branch", "Loran"], ["1072", "Loran", "", "branch", "Loran"], ["1080", "Mohamed Hassan", "", "other", ""], ["1084", "Hend", "", "other", ""], ["1085", "1085", "", "other", ""], ["1091", "Nada Zayed", "", "branch", "Zayed"], ["1092", "1092", "", "branch", "Zayed"], ["1200", "Karim Mattry", "", "other", ""], ["1202", "You Real Estate 2", "", "other", ""], ["1203", "You Real Estate 3", "", "other", ""], ["1208", "You Real Estate 8", "", "other", ""], ["2012", "Merna", "", "other", ""], ["2013", "Merna Ehab", "", "other", ""], ["2015", "2015", "", "other", ""], ["2020", "Acc The Strip", "", "other", ""], ["2021", "Rec 1 The Strip", "", "branch", "Madinity The Strip"], ["2022", "Rec 2 The Strip", "", "branch", "Madinity The Strip"], ["2030", "Mohamed Essam", "", "other", ""], ["2031", "Alex res1", "", "branch", "Alex Camp Chizar"], ["2032", "Alex res2", "", "branch", "Alex Camp Chizar"], ["2033", "Alex res3", "", "branch", "Alex Camp Chizar"], ["2035", "Clinic 1", "", "branch", "Alex Camp Chizar"], ["2038", "Clinic4", "", "branch", "Alex Camp Chizar"], ["2040", "Acc CFC", "", "other", ""], ["2041", "CFC 1", "", "branch", "CFC"], ["2042", "2042", "", "branch", "CFC"], ["2043", "ACC CFC", "", "other", ""], ["2050", "Acc MOA", "", "other", ""], ["2051", "Rec1 MOA", "", "branch", "Mall Of Arabia"], ["2052", "Rec2 MOA", "", "branch", "Mall Of Arabia"], ["2070", "Rehab", "", "branch", "El Rehab"], ["2071", "Rehab Rec2", "", "branch", "El Rehab"], ["2086", "Mandenty1", "", "branch", "Madinity"], ["6001", "Nada Nouvelage", "Nada Mahmoud Mohamed Fouda", "cc", ""], ["6002", "Rawan Nouvelage", "Rowan Ahmed Salah", "cc", ""], ["6003", "Mariam Nouvelage", "Mariam Hany Mounir", "cc", ""], ["6004", "Nourhan Nouvelage", "Nourhan Mohamed Abdel Aziz", "cc", ""], ["6005", "Donia Nouvelage", "Donia Hamdy Mohamed Marzouk", "cc", ""], ["6006", "Fatma Nouvelage", "Fatma El Sayed Eissa", "cc", ""], ["6007", "Yara zat", "Yara Khaled Abdallah Ali", "cc", ""], ["6008", "Mariam zat", "", "cc", ""], ["6009", "Hend Nouvelage", "Hend Ehab Hassan", "cc", ""], ["6011", "Zenab Nouvelage", "Zeinab Osama", "cc", ""], ["6012", "Yara Nouvelage", "", "cc", ""]];
const extMap=()=>UCM.ext||DEF_EXT;
// --- weeks (Sun–Sat, Cairo) ---
function weekStartOf(s){const d=new Date(s+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-d.getUTCDay());return iso(d)}
function requiredWeek(){const t=cairoToday();const ws=weekStartOf(t);return {start:addDays(ws,-7),end:addDays(ws,-1)}}
const nice=s=>new Date(s+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'});
// --- store adapter ---
function memStore(){const m=new Map();const col=p=>({doc:id=>docRef(p+'/'+id),get:async()=>({docs:[...m.entries()].filter(([k])=>k.startsWith(p+'/')&&k.slice(p.length+1).indexOf('/')<0).map(([k,v])=>({id:k.split('/').pop(),exists:true,data:()=>v}))})});
 const docRef=p=>({get:async()=>({exists:m.has(p),data:()=>m.get(p)}),set:async v=>{m.set(p,JSON.parse(JSON.stringify(v)))},delete:async()=>{m.delete(p)}});return {collection:col,doc:docRef}}
async function ucmInit(){
 let db=null,user=null;
 try{if(window.claude&&claude.use){[db,user]=await Promise.all([claude.use('db'),claude.use('user')])}}catch(e){}
 if(!db){UCM.mem=true;db=memStore();UCM.canWrite=true;UCM.owner=true}
 else{let c=null,ed=false;try{if(user){c=await user.can('data.write');ed=await user.canEdit()}}catch(e){}UCM.canWrite=ed||c===null;try{UCM.owner=user?await user.isOwner():false}catch(e){UCM.owner=false}}
 UCM.db=db;await ucmLoad();UCM.ready=true;gateCheck();render();
}
async function ucmLoad(){const db=UCM.db;
 try{const w=await db.collection('ucm_weeks').get();UCM.weeks=w.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>a.id<b.id?1:-1)}catch(e){UCM.weeks=[]}
 try{const c=await db.collection('ucm_calls').get();const rows=[];for(const d of c.docs){const v=d.data();if(v&&v.r)for(const r of JSON.parse(v.r))rows.push(r)}UCM.calls=rows}catch(e){UCM.calls=[]}
 try{const e=await db.doc('ucm_settings/extensions').get();if(e.exists&&e.data().map)UCM.ext=JSON.parse(e.data().map)}catch(e){}
}
// --- gate ---
function gateCheck(){const rw=requiredWeek();const have=UCM.weeks.find(w=>w.id===rw.start&&(w.last||w.end)>=addDays(rw.end,-1));
 let sk=false;try{sk=UCM.owner&&sessionStorage.getItem('nrs-ucm-skip')===rw.start}catch(e){}
 if(have||sk){$('#gate').hidden=true;return}
 $('#gate').hidden=false;$('#gTitle').textContent=`Upload last week's UCM`;
 $('#gSub').innerHTML=`<span dir="rtl" style="display:block;font-family:'IBM Plex Sans Arabic',sans-serif;text-align:right">الصفحة دي بتفتح بعد ما ملف UCM بتاع الأسبوع اللي فات يترفع. الملف بيترفع كل يوم حد الصبح.</span><b>${nice(rw.start)} → ${nice(rw.end)}</b>`;
 if(!UCM.canWrite){$('#gBody').innerHTML=`<div class="notice ar">لسه محدش رفع ملف الأسبوع ده. الصفحة هتفتح أول ما الأدمن يرفعه.</div>`;return}
 drawUpload($('#gBody'),rw,true);
 if(UCM.owner){$('#gBody').insertAdjacentHTML('beforeend',`<div class="g-act"><button class="btn ghost" id="gSkip">Skip for now</button><span class="hcap" style="margin:0;align-self:center">Only you see this. The page stays locked for everyone else.</span></div>`);$('#gSkip').onclick=()=>{try{sessionStorage.setItem('nrs-ucm-skip',rw.start)}catch(e){}$('#gate').hidden=true;toast('Skipped for this visit — it asks again in a new tab')}}
}
function drawUpload(host,rw,isGate){
 host.innerHTML=`${UCM.mem?'<div class="notice ar" style="margin-bottom:14px">نسخة تجربة: الملف اللي هيترفع هنا مش هيتحفظ.</div>':''}
 <label class="drop" id="drop"><input type="file" id="ucmFile" accept=".csv,.xlsx,.xls" hidden><b>Drop the UCM CDR export here</b><span>CSV or Excel · from UCM → CDR → Export</span></label>
 <div id="ucmStep"></div>
 ${isGate?'':'<div class="g-act"><button class="btn ghost" id="ucmClose">Close</button></div>'}`;
 const dz=host.querySelector('#drop'),fi=host.querySelector('#ucmFile');
 fi.onchange=()=>fi.files[0]&&readFile(fi.files[0],host,rw,isGate);
 ['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('over')}));
 ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('over')}));
 dz.addEventListener('drop',e=>{const f=e.dataTransfer.files[0];f&&readFile(f,host,rw,isGate)});
 const c=host.querySelector('#ucmClose');if(c)c.onclick=()=>{$('#gate').hidden=true;gateCheck()};
}
// --- parsing ---
const FIELDS=[['start','Call start',1,['start','start time','starttime','calldate','call date','call time','date','time','start_time']],
 ['answer','Answer time',0,['answer','answer time','answertime','answer_time']],
 ['src','Caller number',1,['src','caller number','caller','from','source','callerid','caller id','calling number','caller_number']],
 ['dst','Callee number',1,['dst','callee number','callee','to','destination','called number','dest','callee_number']],
 ['disp','Status',1,['disposition','status','call status','result']],
 ['talk','Talk seconds',0,['billsec','talk duration','talk time','talk','talktime','talk_duration']],
 ['dur','Total duration',0,['duration','call duration','total duration','call_duration']],
 ['agent','Answered by',0,['dstanswer','answered by','dstchanext','dstchannel_ext','agent','extension','answered_by']],
 ['act','Action type',0,['action_type','action type','call type','lastapp']],
 ['sess','Call ID',0,['session','uniqueid','call id','callid','linkedid']]];
const norm=s=>String(s??'').trim().toLowerCase().replace(/\s+/g,' ');
function guessMap(head){const h=head.map(norm);const m={};for(const [k,,,syn] of FIELDS){let i=-1;for(const s of syn){i=h.indexOf(s);if(i>=0)break}m[k]=i}return m}
function toSec(v){if(v==null||v==='')return null;if(typeof v==='number')return v<1?Math.round(v*86400):Math.round(v);const s=String(v).trim();const p=s.split(':').map(Number);if(p.length===3&&p.every(isFinite))return p[0]*3600+p[1]*60+p[2];if(p.length===2&&p.every(isFinite))return p[0]*60+p[1];const n=Number(s);return isFinite(n)?Math.round(n):null}
function toDT(v){if(v==null||v==='')return null;if(typeof v==='number'){const ms=Math.round((v-25569)*86400000);const d=new Date(ms);return {d:iso(d),h:d.getUTCHours(),m:d.getUTCMinutes(),s:d.getUTCSeconds()}}
 const s=String(v).trim();let m=s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
 if(m)return {d:`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`,h:+m[4],m:+m[5],s:+(m[6]||0)};
 m=s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
 if(m){let h=+m[4];if(m[7]){const pm=/pm/i.test(m[7]);if(pm&&h<12)h+=12;if(!pm&&h===12)h=0}return {d:`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`,h,m:+m[5],s:+(m[6]||0)}}
 return null}
const digits=s=>String(s??'').replace(/\D/g,'');
const isInt=s=>{const d=digits(s);return d.length>0&&d.length<=5};
async function sha12(s){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,12)}
function statusCode(s){s=String(s||'').toUpperCase();if(/NO ?ANSWER|NOANSWER|MISSED|ABANDON/.test(s))return 1;if(/ANSWER/.test(s))return 0;if(/BUSY/.test(s))return 2;if(/FAIL|CONGEST|CHANUNAVAIL/.test(s))return 3;return 4}
function readFile(f,host,rw,isGate){const step=host.querySelector('#ucmStep');step.innerHTML='<p class="g-sub">Reading the file…</p>';
 if(!window.XLSX){step.innerHTML='<p class="g-err">The file reader did not load. Reload the page and try again.</p>';return}
 const fr=new FileReader();fr.onerror=()=>{step.innerHTML='<p class="g-err">The file could not be read.</p>'};
 fr.onload=()=>{let rows;try{const wb=XLSX.read(new Uint8Array(fr.result),{type:'array'});const ws=wb.Sheets[wb.SheetNames[0]];rows=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:''})}catch(e){step.innerHTML='<p class="g-err">This is not a CSV or Excel file UCM exports.</p>';return}
  let hi=0,best=-1;for(let i=0;i<Math.min(15,rows.length);i++){const m=guessMap(rows[i]);const sc=Object.values(m).filter(x=>x>=0).length;if(sc>best){best=sc;hi=i}}
  const head=rows[hi].map(String),body=rows.slice(hi+1).filter(r=>r.some(c=>c!==''));
  const hn=head.map(norm);if(['cdr','session','call type','dest channel extension','call status'].every(k=>hn.includes(k))){gsFlow(step,head,body,f.name,rw);return}
  showMap(step,head,body,guessMap(head),f.name,rw,isGate)};
 fr.readAsArrayBuffer(f)}
function showMap(step,head,body,m,fname,rw,isGate){
 const opt=k=>`<option value="-1">— not in the file —</option>`+head.map((h,i)=>`<option value="${i}" ${m[k]===i?'selected':''}>${h||'(column '+(i+1)+')'}</option>`).join('');
 step.innerHTML=`<p class="g-sub" style="margin:16px 0 0"><b>${fname}</b> · ${fmt(body.length)} rows. Check the columns, then save.</p>
 <div class="map">${FIELDS.map(([k,l,req])=>`<label for="mp_${k}">${l}${req?' *':''}</label><select id="mp_${k}">${opt(k)}</select>`).join('')}</div>
 <div id="mpSum"></div><div class="g-act"><button class="btn solid" id="mpGo">Check file</button></div><div id="mpMsg"></div>`;
 step.querySelector('#mpGo').onclick=async()=>{const mm={};for(const [k] of FIELDS)mm[k]=+step.querySelector('#mp_'+k).value;
  const miss=FIELDS.filter(([k,,req])=>req&&mm[k]<0).map(x=>x[1]);if(miss.length){step.querySelector('#mpMsg').innerHTML=`<p class="g-err">Pick a column for: ${miss.join(', ')}.</p>`;return}
  step.querySelector('#mpMsg').innerHTML='<p class="g-sub">Working…</p>';
  const calls=await buildCalls(body,mm);
  if(!calls.length){step.querySelector('#mpMsg').innerHTML='<p class="g-err">No inbound or outbound calls could be read with these columns. Check Call start and the two numbers.</p>';return}
  const ds=calls.map(c=>c[0]).sort(),from=ds[0],to=ds[ds.length-1];
  const inW=calls.filter(c=>c[0]>=rw.start&&c[0]<=rw.end).length;
  const nin=calls.filter(c=>c[2]===1).length,nout=calls.length-nin;
  step.querySelector('#mpSum').innerHTML=`<div class="sumrow"><div><b>${fmt(nin)}</b><span>inbound</span></div><div><b>${fmt(nout)}</b><span>dials</span></div><div><b>${from.slice(5)}</b><span>first day</span></div><div><b>${to.slice(5)}</b><span>last day</span></div></div>`;
  if(!inW){step.querySelector('#mpMsg').innerHTML=`<p class="g-err">This file covers ${from} → ${to}, not ${rw.start} → ${rw.end}. Export last week from UCM and upload that.</p>`;return}
  step.querySelector('#mpMsg').innerHTML=`<p class="g-ok">${fmt(inW)} calls fall inside ${nice(rw.start)} → ${nice(rw.end)}. Calls outside that week are saved under their own weeks.</p><div class="g-act"><button class="btn solid" id="mpSave">Save and open</button></div>`;
  step.querySelector('#mpSave').onclick=()=>saveCalls(calls,fname,step)};
}

async function buildCallsGS(head,body){const hn=head.map(norm);const ix=k=>hn.indexOf(k);
 const I={cdr:ix('cdr'),src:ix('caller number'),dst:ix('callee number'),st:ix('start time'),an:ix('answer time'),talk:ix('talk time'),stat:ix('call status'),type:ix('call type'),dext:ix('dest channel extension'),act:ix('action type'),sess:ix('session')};
 const S=new Map();for(const r of body){const k=String(r[I.sess]);if(!S.has(k))S.set(k,[]);S.get(k).push(r)}
 const secs=v=>{const t=toDT(v);return t?(t.h*3600+t.m*60+t.s):null};
 const out=[],nums=new Set();
 for(const legs of S.values()){const mains=legs.filter(r=>r[I.cdr]==='main_cdr');const m=mains[0]||legs[0];const type=String(m[I.type]);
  const t=toDT(legs.map(r=>r[I.st]).sort()[0]);if(!t)continue;
  if(type==='Outbound'){const ext=digits(m[I.src]),num=digits(m[I.dst]).slice(-10);const ok=String(m[I.stat]).toUpperCase()==='ANSWERED';
   if(num.length===10)nums.add(num);out.push([t.d,t.h,2,ext,ok?1:0,-1,ok?(toSec(m[I.talk])||0):0,num,'',ok?0:1]);continue}
  if(type!=='Inbound')continue;
  const num=digits(m[I.src]).slice(-10);if(num.length===10)nums.add(num);
  const ql=legs.find(r=>/QUEUE\[\d+\]/.test(r[I.act])&&String(r[I.dext])===(String(r[I.act]).match(/QUEUE\[(\d+)\]/)||[])[1]);
  const q=(legs.map(r=>String(r[I.act]).match(/QUEUE\[(\d+)\]/)).find(Boolean)||[])[1]||'';
  const ag=legs.filter(r=>/^6[0-4]\d\d$/.test(String(r[I.dext]))&&String(r[I.stat]).toUpperCase()==='ANSWERED').sort((a,b)=>String(a[I.an])<String(b[I.an])?-1:1)[0];
  let st,ext='',wait=-1,talk=0;
  if(ag){st=0;ext=String(ag[I.dext]);talk=toSec(ag[I.talk])||0;const a=secs(ag[I.an]),b=secs((ql||legs.find(r=>/QUEUE/.test(r[I.act]))||m)[I.st]);if(a!=null&&b!=null&&a>=b)wait=a-b}
  else if(q)st=1;else if(legs.some(r=>/^ANNOUNCE/.test(r[I.act])))st=5;else st=6;
  out.push([t.d,t.h,1,ext,ag?1:0,wait,talk,num,q,st])}
 const H=new Map();await Promise.all([...nums].map(async n=>H.set(n,await sha12(n))));
 for(const c of out)c[7]=c[7].length===10?H.get(c[7]):'';
 return out}
async function gsFlow(step,head,body,fname,rw){step.innerHTML='<p class="g-sub" style="margin-top:14px">Grandstream UCM CDR recognised. Reading calls…</p>';
 const calls=await buildCallsGS(head,body);if(!calls.length){step.innerHTML='<p class="g-err">No inbound or outbound calls in this file.</p>';return}
 const ds=calls.map(c=>c[0]).sort(),from=ds[0],to=ds[ds.length-1];const nin=calls.filter(c=>c[2]===1).length;
 const inW=calls.filter(c=>c[0]>=rw.start&&c[0]<=rw.end).length;
 step.innerHTML=`<p class="g-sub" style="margin:16px 0 0"><b>${fname}</b> · Grandstream UCM CDR · ${fmt(body.length)} rows → ${fmt(calls.length)} calls</p><div class="sumrow"><div><b>${fmt(nin)}</b><span>inbound calls</span></div><div><b>${fmt(calls.length-nin)}</b><span>dials</span></div><div><b>${from.slice(5)}</b><span>first day</span></div><div><b>${to.slice(5)}</b><span>last day</span></div></div><div id="mpMsg"></div>`;
 const msg=step.querySelector('#mpMsg');
 if(!inW){msg.innerHTML=`<p class="g-err">This file covers ${from} → ${to}, not ${rw.start} → ${rw.end}. Export last week from UCM and upload that.</p>`;return}
 msg.innerHTML=`<p class="g-ok">${fmt(inW)} calls fall inside ${nice(rw.start)} → ${nice(rw.end)}. Calls outside that week are saved under their own weeks.</p><div class="g-act"><button class="btn solid" id="mpSave">Save and open</button></div>`;
 step.querySelector('#mpSave').onclick=()=>saveCalls(calls,fname,step)}
async function buildCalls(body,m){const g=(r,k)=>m[k]>=0?r[m[k]]:'';
 // group legs by call id when present
 let groups;if(m.sess>=0){const mp=new Map();for(const r of body){const k=String(g(r,'sess'))||Math.random();if(!mp.has(k))mp.set(k,[]);mp.get(k).push(r)}groups=[...mp.values()]}else groups=body.map(r=>[r]);
 const out=[],nums=new Set();
 for(const legs of groups){const first=legs[0];const t=toDT(g(first,'start'));if(!t)continue;
  const src=g(first,'src'),dst=legs.map(r=>g(r,'dst')).find(x=>x!=='')||'';
  let dir=0;if(!isInt(src)&&digits(src).length>=7)dir=1;else if(isInt(src)&&digits(dst).length>=7)dir=2;if(!dir)continue;
  const ansLeg=legs.find(r=>statusCode(g(r,'disp'))===0);const st=ansLeg?0:Math.min(...legs.map(r=>statusCode(g(r,'disp'))));
  const L2=ansLeg||first;let ext='';
  if(dir===2)ext=digits(src);else{const a=digits(g(L2,'agent'));ext=a&&a.length<=5?a:(isInt(g(L2,'dst'))&&ansLeg?digits(g(L2,'dst')):'')}
  let wait=-1;if(ansLeg&&m.answer>=0){const a=toDT(g(ansLeg,'answer'));if(a&&a.d===t.d)wait=Math.max(0,(a.h-t.h)*3600+(a.m-t.m)*60+(a.s-t.s))}
  let talk=ansLeg?(toSec(g(ansLeg,'talk'))??toSec(g(ansLeg,'dur'))??0):0;
  const q=(String(legs.map(r=>g(r,'act')).join(' ')).match(/QUEUE\[(\d+)\]/i)||[])[1]||'';
  const num=digits(dir===1?src:dst).slice(-10);if(num.length===10)nums.add(num);
  out.push([t.d,t.h,dir,ext,st===0?1:0,wait,talk,num,q,st])}
 const H=new Map();await Promise.all([...nums].map(async n=>H.set(n,await sha12(n))));
 for(const c of out)c[7]=c[7].length===10?H.get(c[7]):'';
 return out}
async function saveCalls(calls,fname,step){const db=UCM.db;const btn=step.querySelector('#mpSave');btn.disabled=true;btn.textContent='Saving…';
 try{const byW=new Map();for(const c of calls){const w=weekStartOf(c[0]);if(!byW.has(w))byW.set(w,[]);byW.get(w).push(c)}
  let who='';try{const u=await claude.use('user');if(u){const me=await u.me();who=me&&me.id||''}}catch(e){}
  for(const [w,rows] of byW){const old=UCM.weeks.find(x=>x.id===w);const oldN=old?old.chunks||0:0;const CH=2500,n=Math.ceil(rows.length/CH);
   for(let i=0;i<n;i++)await db.collection('ucm_calls').doc(`${w}_${i}`).set({w,i,r:JSON.stringify(rows.slice(i*CH,(i+1)*CH))});
   for(let i=n;i<oldN;i++)await db.collection('ucm_calls').doc(`${w}_${i}`).delete();
   const days=rows.map(r=>r[0]).sort();await db.collection('ucm_weeks').doc(w).set({start:w,end:addDays(w,6),first:days[0],last:days[days.length-1],rows:rows.length,inbound:rows.filter(r=>r[2]===1).length,outbound:rows.filter(r=>r[2]===2).length,chunks:n,file:fname,uploadedAt:new Date().toISOString(),by:who})}
  await ucmLoad();toast('UCM saved');$('#gate').hidden=true;gateCheck();render()
 }catch(e){btn.disabled=false;btn.textContent='Save and open';step.querySelector('#mpMsg').insertAdjacentHTML('beforeend',`<p class="g-err">Saving failed${e&&e.code?' ('+e.code+')':''}. Only editors of this page can upload.</p>`)}}
function openImport(){if(!UCM.canWrite){toast('Only editors of this page can upload UCM');return}const rw=requiredWeek();$('#gate').hidden=false;$('#gTitle').textContent='Upload a UCM export';$('#gSub').textContent='Any range. Each week replaces what was uploaded for it before.';drawUpload($('#gBody'),{start:'0000-00-00',end:'9999-99-99'},false)}
// --- render calls tab ---
function extName(e){const x=extMap().find(r=>r[0]===e);return x?x[1]:(e||'Unassigned')}
function extGroup(e){const x=extMap().find(r=>r[0]===e);return x?x[3]||'other':(/^60\d\d$/.test(e)?'cc':'other')}
function extBranch(e){const x=extMap().find(r=>r[0]===e);return x&&x[4]||''}
function extEmp(e){const x=extMap().find(r=>r[0]===e);return x&&x[2]?x[2]:''}
function renderUCM(){
 const agentName=st.agent==='all'?null:E[+st.agent];
 const teamOK=c=>{if(c[2]===1)return st.team!=='0';const g=extGroup(c[3]);if(g==='other')return false;return st.team==='all'||(st.team==='1'?g==='cc':g==='branch')};
 const brName=st.branch==='all'?null:B[+st.branch];
 const C=UCM.calls.filter(c=>c[0]>=st.from&&c[0]<=st.to&&teamOK(c)&&(!agentName||extEmp(c[3])===agentName)&&(!brName||(c[2]===2&&extBranch(c[3])===brName)||(c[2]===1&&false)));
 const IN=C.filter(c=>c[2]===1),OUT=C.filter(c=>c[2]===2);
 const Q=IN.filter(c=>c[8]),ans=IN.filter(c=>c[4]),con=OUT.filter(c=>c[4]);
 const avg=a=>a.length?Math.round(a.reduce((s,x)=>s+x,0)/a.length):null;
 const mmss=s=>s==null?'—':`${Math.floor(s/60)}m ${String(s%60).padStart(2,'0')}s`;
 const hrs=t=>`${Math.floor(t/3600)}h ${String(Math.floor(t%3600/60)).padStart(2,'0')}m`;
 const waits=ans.map(c=>c[5]).filter(x=>x>=0);
 $('#uExtWrap').style.display=UCM.canWrite?'':'none';
 table('#tUWeeks',UCM.weeks.map(w=>({name:`${w.start} → ${w.end}`+((w.last||w.end)<addDays(w.end,-1)?` (calls to ${w.last})`:''),in:w.inbound,out:w.outbound,file:w.file||'',at:(w.uploadedAt||'').slice(0,16).replace('T',' ')})),[['Week','name','t'],['Inbound','in'],['Dials','out'],['File','file','t'],['Uploaded','at','t']],null);
 const GL={cc:'Call centre',branch:'Branch',other:'Other'};
 $('#tUExt').innerHTML=`<thead><tr><th class="l">Extension</th><th class="l">Name on the phones</th><th class="l">Odoo employee</th><th class="l">Team</th><th class="l">Branch</th></tr></thead><tbody>${extMap().map((r,i)=>`<tr><td class="nm">${r[0]}</td><td class="l"><input class="ext-in" data-i="${i}" data-k="1" value="${String(r[1]).replace(/"/g,'&quot;')}"></td><td class="l"><select class="ext-in" data-i="${i}" data-k="2"><option value="">— none —</option>${E.map(n=>`<option ${n===r[2]?'selected':''}>${n}</option>`).join('')}</select></td><td class="l"><select class="ext-in" data-i="${i}" data-k="3">${Object.entries(GL).map(([k,v])=>`<option value="${k}" ${k===r[3]?'selected':''}>${v}</option>`).join('')}</select></td><td class="l"><select class="ext-in" data-i="${i}" data-k="4"><option value="">—</option>${B.filter(b=>b!=='No branch'&&b!=='Older lead').map(b=>`<option ${b===r[4]?'selected':''}>${b}</option>`).join('')}</select></td></tr>`).join('')}</tbody>`;
 if(!C.length){$('#uBody').style.display='none';$('#hut').textContent='No UCM calls in this range';
  $('#uEmpty').innerHTML=`<div class="notice ar">مفيش مكالمات من UCM في الفترة دي${brName?' للفرع ده':''}. ${UCM.weeks.length?'الأسابيع اللي اترفعت: '+UCM.weeks.map(w=>w.start+' → '+w.end).join('، ')+'.':'لسه مفيش أسابيع اترفعت.'}</div>`;return}
 $('#uBody').style.display='';$('#uEmpty').innerHTML='';
 $('#hut').textContent=IN.length?`${fmt(IN.length)} inbound calls, ${fmt(OUT.length)} dials`:`${fmt(OUT.length)} dials`;
 $('#strip').insertAdjacentHTML('beforeend',`<span>· UCM <b>${fmt(IN.length)}</b>inbound ·</span><span><b>${pctS(ans.length,Q.length)}</b>answered in queue ·</span><span><b>${fmt(OUT.length)}</b>dials</span>`);
 const ivr=IN.filter(c=>c[9]===6).length,ooh=IN.filter(c=>c[9]===5).length;
 $('#uCards').innerHTML=[['Inbound calls',fmt(IN.length),'every call into the IVR',1],['Reached a queue',fmt(Q.length),`${pctS(Q.length,IN.length)} of inbound`],['Answered',fmt(ans.length),`${pctS(ans.length,Q.length)} of queued · ${fmt(Q.length-ans.length)} abandoned`],['Ended in IVR',fmt(ivr),`${pctS(ivr,IN.length)} hung up before a queue`],['Out-of-hours',fmt(ooh),'got the closed message'],['Wait to answer',waits.length?mmss(avg(waits)):'—','queue entry to pick-up'],['Talk, inbound',mmss(avg(ans.map(c=>c[6]))),'average per answered call'],['Dials',fmt(OUT.length),`${pctS(con.length,OUT.length)} connected`],['Talk, outbound',mmss(avg(con.map(c=>c[6]))),'average per connected call']]
  .map(c=>`<div class="card ${c[3]?'dark':''}"><div class="k">${c[0]}</div><div class="v">${c[1]}</div><div class="d">${c[2]}</div></div>`).join('');
 const H24=[...Array(24)].map((_,i)=>i);
 const hist=(arr,okF,label)=>{if(!arr.length)return '<div class="empty">No calls.</div>';const g=group(arr,1),mx=Math.max(1,...H24.map(h=>(g.get(h)||[]).length));return `<div class="hist" style="grid-template-columns:repeat(24,minmax(0,1fr))">${H24.map(h=>{const v=g.get(h)||[],a=v.filter(okF).length;return `<div class="b" title="${String(h).padStart(2,'0')}:00 — ${v.length} calls, ${a} ${label}"><span class="lt" style="height:${(v.length-a)/mx*100}%"></span><span style="height:${a/mx*100}%;border-radius:0"></span></div>`}).join('')}</div><div class="hlab" style="grid-template-columns:repeat(24,minmax(0,1fr))">${H24.map(h=>{const v=g.get(h)||[];return `<div>${String(h).padStart(2,'0')}<small>${v.length?pctS(v.filter(okF).length,v.length):'—'}</small></div>`}).join('')}</div><div class="legend"><span><i style="background:#58382c"></i>${label[0].toUpperCase()+label.slice(1)}</span><span><i style="background:#c3a494"></i>Not ${label}</span></div>`};
 $('#uHistIn').innerHTML=hist(IN,c=>c[4],'answered');
 if(IN.length){const offH=IN.filter(c=>c[1]<10||c[1]>=22);$('#uHistIn').insertAdjacentHTML('beforeend',`<p class="hcap">The second line is the share of all inbound calls answered by an agent in that hour. ${fmt(offH.length)} calls arrived before 10:00 or after 22:00; ${fmt(offH.filter(c=>c[4]).length)} of them were answered.</p>`)}
 $('#uHistOut').innerHTML=hist(OUT,c=>c[4],'connected');
 // agents
 const exts=[...new Set(C.map(c=>c[3]))];
 const R0=R.filter(r=>r[0]>=st.from&&r[0]<=st.to);
 const ga=exts.map(e=>{const i=C.filter(c=>c[3]===e&&c[2]===1),o=C.filter(c=>c[3]===e&&c[2]===2),oc=o.filter(c=>c[4]);const emp=extEmp(e),ei=E.indexOf(emp);const a=agg(ei>=0?R0.filter(r=>r[2]===ei):[]);const g=e?extGroup(e):'cc';
  return {ext:e||'—',name:e?extName(e):'Not answered',team:g==='branch'?(extBranch(e)||'Branch'):'Call centre',ina:i.filter(c=>c[4]).length,ahtS:mmss(avg(i.filter(c=>c[4]).map(c=>c[6]))),dials:o.length,con:oc.length,cr:pct(oc.length,o.length),talk:[...i,...o].reduce((s,c)=>s+c[6],0),opp:ei>=0?a.n:'—',bk:ei>=0?a.bk:'—',show:ei>=0?a.show:'—'}}).filter(x=>x.ext!=='—'||x.ina);
 table('#tUAgent',ga.map(x=>({...x,talkS:hrs(x.talk)})),[['Ext','ext','t'],['Name','name','t'],['Team','team','t'],['Inbound answered','ina'],['AHT in','ahtS','t'],['Dials','dials'],['Connected','con'],['Connection rate','cr','%'],['Talk','talkS','t'],['Odoo opps','opp','t'],['Booked','bk','t'],['Showed','show','t']],'dials');
 $('#uAgentCap').textContent='Odoo columns come from the employee linked to the extension (table at the bottom), for the same dates. Branch extensions are the reception lines doing follow-up calls.';
 // match calls -> odoo opportunities (call centre)
 const HH=DATA.H;const byH=new Map();R.forEach((r,i)=>{const h=HH[i];if(!h)return;if(!byH.has(h))byH.set(h,[]);byH.get(h).push(r)});
 const near=(d,r)=>Math.abs(new Date(d+'T12:00:00Z')-new Date(r[0]+'T12:00:00Z'))<=86400000*1.01;
 const talked=[...ans,...con].filter(c=>c[7]);const callers=new Map();for(const c of talked){if(!callers.has(c[7]))callers.set(c[7],c[0])}
 let mOpp=0,mBk=0,mSh=0;
 for(const [h,d] of callers){const rs=(byH.get(h)||[]).filter(r=>near(d,r));if(rs.length){mOpp++;if(rs.some(r=>r[6]!==O_NB))mBk++;if(rs.some(r=>r[6]!==O_NB&&r[7]))mSh++}}
 const calledH=new Map();for(const c of talked){if(!calledH.has(c[7]))calledH.set(c[7],[]);calledH.get(c[7]).push(c[0])}
 let oppNoCall=0,oppTot=0;R.forEach((r,i)=>{if(r[0]<st.from||r[0]>st.to)return;if(st.team!=='all'&&String(r[9])!==st.team)return;oppTot++;const ds=calledH.get(HH[i])||[];if(!ds.some(d=>near(d,r)))oppNoCall++});
 const callsDays=new Set(C.map(c=>c[0]));const covered=[...callsDays].some(d=>R.some(r=>r[0]===d));
 $('#uMatch').innerHTML=[['Numbers talked to',fmt(callers.size),'answered or connected',1],['With an Odoo opportunity',fmt(mOpp),pctS(mOpp,callers.size)+' within a day of the call'],['Booked',fmt(mBk),pctS(mBk,mOpp)+' of those'],['Showed',fmt(mSh),pctS(mSh,mBk)+' of booked'],['Opps with no call',fmt(oppNoCall),`${pctS(oppNoCall,oppTot)} of ${fmt(oppTot)} opportunities`]]
  .map(c=>`<div class="card ${c[3]?'dark':''}"><div class="k">${c[0]}</div><div class="v">${c[1]}</div><div class="d">${c[2]}</div></div>`).join('');
 $('#uMatchNote').innerHTML=`<b>المطابقة برقم التليفون.</b> كل رقم اتكلمنا معاه في UCM بندوّر عليه في الفرص اللي على يوزر الكول سنتر في أودو، في نفس اليوم أو يوم قبله أو بعده. «Opps with no call» فرص اتفتحت ومالهاش مكالمة متردّ عليها في السنترال، وغالباً دي واتساب أو شات، أو رقم متسجل غلط.${covered?'':'<br>داتا أودو اللي في الصفحة مش مغطية أيام المكالمات دي، فالمطابقة هتبان لما تسحب نفس الفترة من أودو.'}`;
 const gd=[...group(C,0).entries()].sort();
 table('#tUDaily',gd.map(([d,v])=>{const i=v.filter(c=>c[2]===1),q=i.filter(c=>c[8]),o=v.filter(c=>c[2]===2);return {d,in:i.length,q:q.length,a:i.filter(c=>c[4]).length,ar:pct(i.filter(c=>c[4]).length,q.length),ivr:i.filter(c=>c[9]===6).length,dials:o.length,con:o.filter(c=>c[4]).length,cr:pct(o.filter(c=>c[4]).length,o.length)}}),[['Date','d','t'],['Inbound','in'],['Queued','q'],['Answered','a'],['Answer rate','ar','%'],['Ended in IVR','ivr'],['Dials','dials'],['Connected','con'],['Connection rate','cr','%'],['Source','src','tagU']],'d',1);
 const QN={'6502':'ZAT','6514':'Nouvel Age'};
 const gq=[...group(Q,8).entries()].map(([q,v])=>{const a=v.filter(c=>c[4]).length;return {q:q+(QN[q]&&QN[q]!==q?' · '+QN[q]:''),n:v.length,a,ab:v.length-a,abr:pct(v.length-a,v.length),w:mmss(avg(v.filter(c=>c[4]&&c[5]>=0).map(c=>c[5])))}});
 $('#uQueueWrap').style.display=gq.length?'':'none';
 table('#tUQueue',gq,[['Queue','q','t'],['Offered','n'],['Answered','a'],['Abandoned','ab'],['Abandon rate','abr','%'],['Avg wait','w','t']],'n');
}
$('#bImport').onclick=openImport;
document.addEventListener('click',async e=>{if(e.target.id!=='bExtSave')return;const rows=extMap().map(r=>[...r]);document.querySelectorAll('#tUExt .ext-in').forEach(el=>{rows[+el.dataset.i][+el.dataset.k]=el.value});
 try{await UCM.db.doc('ucm_settings/extensions').set({map:JSON.stringify(rows)});UCM.ext=rows;$('#extMsg').textContent='Saved';render()}catch(err){$('#extMsg').textContent='Not saved — only editors can change this'}});

/* ================= LIVE ODOO ================= */
const LIVE={mcp:null,on:false,busy:false,at:null,err:null,range:null};
const OSRV='odoo-nouvelage18',OTOOL='odoo_search_records';
const ATT_ST=['done','payment_received','done_with_due','checked_in','assessment','in_process','waiting','medical_info','waiting_for_advance_payment','discount_approval'];
function cairoOff(d){try{const dt=new Date(d+'T12:00:00Z');const h=+new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Cairo',hour:'2-digit',hourCycle:'h23'}).format(dt);return h-12}catch(e){return 3}}
function utcBound(d){const off=cairoOff(d);const t=new Date(d+'T00:00:00Z');t.setUTCHours(t.getUTCHours()-off);return t.toISOString().slice(0,19).replace('T',' ')}
function toCairo(s){const off=cairoOff(s.slice(0,10));const t=new Date(s.replace(' ','T')+'Z');t.setUTCHours(t.getUTCHours()+off);return {d:t.toISOString().slice(0,10),h:t.getUTCHours(),ms:t.getTime()}}
async function oSearch(model,domain,fields,label){const out=[];const LIM=2000;
 for(let off=0;;off+=LIM){liveMsg(`Pulling ${label} from Odoo… ${fmt(out.length)}`);
  const res=await LIVE.mcp.callTool(OSRV,OTOOL,{model,domain,fields,limit:LIM,offset:off,order:'id asc'},{cache:false});
  let p=res.payload;if(typeof p==='string'){try{p=JSON.parse(p)}catch(e){throw {code:'tool_error',message:'Unexpected answer from Odoo'}}}
  const recs=(p&&p.records)||[];out.push(...recs);if(recs.length<LIM)break}
 return out}
function liveMsg(m){const s=$('#stLive');if(s)s.textContent=m}
async function livePull(){if(!LIVE.mcp||LIVE.busy)return;
 let from=st.from,to=st.to;const days=(new Date(to)-new Date(from))/864e5;
 if(days>92){toast('Live pull covers up to 3 months at a time — showing the last 3 months of your range');from=addDays(to,-92);st.from=from}
 LIVE.busy=true;LIVE.err=null;document.body.classList.add('loading');
 try{const a=utcBound(from),b=utcBound(addDays(to,1));const tcap=[addDays(to,45),cairoToday()].sort()[0];
  const leads=await oSearch('crm.lead',[['create_date','>=',a],['create_date','<',b],['active','in',[true,false]]],['id','create_date','create_uid','branch_id','department_id','employee_id','partner_id','phone','mobile','source_id','campaign_id','medium_id','referred'],'opportunities');
  const appts=await oSearch('appointment',[['crm_lead_id.create_date','>=',a],['crm_lead_id.create_date','<',b]],['id','crm_lead_id','create_date','states','date','specialist_id','invoice_total'],'bookings');
  const att=await oSearch('appointment',[['date','>=',from],['date','<=',tcap],['states','in',ATT_ST]],['id','partner_id','date','invoice_total','create_uid','branch_id'],'visits');
  const acts=await oSearch('mail.activity',[['res_model','=','crm.lead'],['create_date','>=',a],['create_date','<',b],['active','in',[true,false]]],['id','res_id','activity_type_id','summary','create_date','date_deadline','create_uid'],'activities');
  const msgs=await oSearch('mail.message',[['model','=','crm.lead'],['date','>=',a],['date','<',b],['mail_activity_type_id','!=',false]],['id','res_id','date','author_id','mail_activity_type_id','create_uid','body'],'done activities');
  const rc=await oSearch('mail.message',[['model','=','crm.lead'],['create_date','>=',a],['create_date','<',b],['body','ilike','Record created']],['id','res_id','create_date','body'],'who opened');
  const bkm=await oSearch('mail.message',[['model','=','crm.lead'],['create_date','>=',a],['body','ilike','Appointment APPT']],['id','res_id','create_date','body'],'who booked');
  const emps=await oSearch('hr.employee',[['active','in',[true,false]]],['id','name','department_id','job_title','main_user_id','pos_user_ids','active'],'people');
  const attIds=att.map(x=>x.id);let ast=[];for(let i=0;i<attIds.length;i+=800){ast=ast.concat(await oSearch('mail.message',[['model','=','appointment'],['res_id','in',attIds.slice(i,i+800)],['body','ilike','Record created']],['id','res_id','create_date','body'],'who re-booked'))}
  liveMsg('Matching patients…');await liveBuild(leads,appts,att,acts,msgs,rc,bkm,emps,ast);
  await liveAppt(from,to);
  LIVE.on=true;LIVE.at=new Date();LIVE.range=[from,to];
 }catch(e){LIVE.err=e;const c=e&&e.code;
  toast(c==='needs_reauth'?'Reconnect odoo-nouvelage18 in Settings → Connectors':c==='server_not_connected'?'Add the odoo-nouvelage18 connector to pull live':c==='not_in_manifest'||c==='not_granted'?'Odoo access was not allowed for this page':c==='tool_error'?('Odoo refused the query: '+(e.message||'')):'Odoo did not answer — showing the last data')}
 LIVE.busy=false;document.body.classList.remove('loading');render();liveStatus()}
function liveStatus(){const el=$('#stLive');if(!el)return;
 if(LIVE.busy)return;
 if(LIVE.on){const m=Math.max(0,Math.round((Date.now()-LIVE.at)/60000));el.textContent=m?`Live · synced ${m} min ago`:'Live · synced just now'}
 else el.textContent=LIVE.mcp?(LIVE.err?'Odoo not reached · snapshot 1 Oct':'Snapshot 1 Oct'):'Snapshot 1 Oct'}
setInterval(liveStatus,60000);

const FAMMAP={'Injectables':['Filler','Botox','Skin Booster','Threads','Body Filler','Kenacort','Meso Therapy','Plasma','Regenerative Injectables','Regenerative Medicine','Stem Cells','Injection/Meso Therapy','Injection/Skin Booster','Biostimulators','bot','btox','metox','bio','prido','stem','pl'],'Laser':['Diode Laser Removal','DEKA Laser Hair Removal','Deka ND:Yag Laser','Laser Hair Removal','CO2','Q-Switched','Deka Laser Aera','hair','dekk'],'Body Contouring':['Body Contouring','Slim Age','Onda','Devices/LPG','Devices/RF','RF'],'Skin & Facials':['HydraFacial','Peeling','Microblading & Lash Lift','Derma Roller','skin ta','skin prot','skin protector','skln','pee','oxy','HIFU']};
function famOf(n){for(const [f,l] of Object.entries(FAMMAP))if(l.includes(n))return f;return /^Q\s+.*TH$/.test(n)?'Laser':'Visits & Other'}
async function liveAppt(from,to){
 const nm=x=>x?x[1]:'';const stamp=b=>{const m=String(b||'').replace(/<[^>]+>/g,'\n').match(/Employee:\s*([^\n<]+)/);return m?m[1].trim():''};
 const ap=await oSearch('appointment',[['date','>=',from],['date','<=',to]],['id','date','slot_id','branch_id','specialist_id','states','create_uid','rescheduled_from_id'],'appointments');
 const ids=ap.map(a=>a.id);let sl=[],rc=[],ac=[];
 for(let i=0;i<ids.length;i+=800){const c=ids.slice(i,i+800);
  sl=sl.concat(await oSearch('appointment.service.line',[['appointment_id','in',c]],['id','appointment_id','service_category_id'],'services'));
  rc=rc.concat(await oSearch('mail.message',[['model','=','appointment'],['res_id','in',c],['body','ilike','Record created']],['id','res_id','create_date','body'],'who booked'));
  ac=ac.concat(await oSearch('mail.message',[['model','=','appointment'],['res_id','in',c],['mail_activity_type_id','!=',false]],['id','res_id','date','body','mail_activity_type_id'],'confirmation calls'))}
 const first=new Map();[...rc].sort((a,b)=>a.create_date<b.create_date?-1:a.create_date>b.create_date?1:a.id-b.id).forEach(m=>{if(!first.has(m.res_id))first.set(m.res_id,stamp(m.body))});
 const cats=new Map();for(const s of sl){const k=s.appointment_id&&s.appointment_id[0];if(!k||!s.service_category_id)continue;if(!cats.has(k))cats.set(k,[]);cats.get(k).push(String(s.service_category_id[1]).trim())}
 const calls=new Map();for(const m of ac){const ty=nm(m.mail_activity_type_id);if(ty!=='Call'&&ty!=='To-Do')continue;if(!calls.has(m.res_id))calls.set(m.res_id,[]);calls.get(m.res_id).push([m.date,stamp(m.body)])}
 const SHOW=['checked_in','assessment','in_process','waiting','medical_info','waiting_for_advance_payment','discount_approval','done','done_with_due','payment_received'];
 const sc=s=>SHOW.includes(s)?0:s==='confirm'?1:s==='pending'?2:s==='cancel'?3:s==='rescheduled'?4:s==='no_show'?5:6;
 const slot=a=>{const m=String(nm(a.slot_id)).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/);return m?((+m[1])%12+(m[3]==='PM'?12:0))*60+(+m[2]):-1};
 const EI=CRM.EI||{};
 const who=a=>first.get(a.id)||`Unstamped (login: ${nm(a.create_uid)})`;
 const src=a=>{const p=first.get(a.id);if(p)return (EI[p]||[''])[0]==='Contact Center'?0:1;const lg=nm(a.create_uid);return ['Call Center','Call Center Manager'].includes(lg)?0:lg==='Administrator'?2:1};
 const BRn=[...new Set(ap.map(a=>nm(a.branch_id)||'No branch'))].sort(),DOCn=[...new Set(ap.map(a=>nm(a.specialist_id)||'No doctor'))].sort();
 const PPn=[...new Set([...ap.map(who),...[...calls.values()].flat().map(x=>x[1]).filter(Boolean)])].sort();
 const CATn=[...new Set([...[...cats.values()].flat(),'Not set'])].sort(),FAMn=['Injectables','Laser','Skin & Facials','Body Contouring','Visits & Other','Not set'];
 const rows=ap.map(a=>{const cs=cats.get(a.id)||[];const c0=cs[0]||'Not set';const cc=(calls.get(a.id)||[]).filter(x=>x[0].slice(0,10)<=a.date).sort();const conf=cc.length?cc[cc.length-1]:null;const brn=nm(a.branch_id)||'No branch';
  return [a.date,slot(a),BRn.indexOf(brn),DOCn.indexOf(nm(a.specialist_id)||'No doctor'),sc(a.states),src(a),PPn.indexOf(who(a)),FAMn.indexOf(cs.length?famOf(c0):'Not set'),CATn.indexOf(c0),cs.length,conf?1:0,conf&&conf[1]?PPn.indexOf(conf[1]):-1,a.rescheduled_from_id?1:0,ZATB.has(brn)?1:0]});
 Object.assign(APPT,{BR:BRn,DOC:DOCn,PP:PPn,CAT:CATn,FAM:FAMn,R:rows,RANGE:[from,to]});
}
async function liveBuild(leads,appts,att,acts,msgs,rc,bkm,emps,ast){
 const today=cairoToday();const nm=x=>x?x[1]:'';
 const stamp=b=>{const m=String(b||'').replace(/<[^>]+>/g,'\n').match(/Employee:\s*([^\n<]+)/);return m?m[1].trim():''};
 const firstBy=arr=>{const m=new Map();for(const x of [...arr].sort((p,q)=>p.create_date<q.create_date?-1:p.create_date>q.create_date?1:p.id-q.id))if(!m.has(x.res_id))m.set(x.res_id,x);return m};
 const RCm=firstBy(rc),BKm=firstBy(bkm),ASm=firstBy(ast);
 const EI={},dn={};for(const e of emps){const k=String(e.name).trim();dn[k]=(dn[k]||0)+1}CRM.DUPN=Object.entries(dn).filter(x=>x[1]>1);for(const e of emps)EI[String(e.name).trim()]=[nm(e.department_id),e.job_title||'',nm(e.main_user_id),e.pos_user_ids||[],e.active?1:0];CRM.EI=EI;
 const opener=l=>{const m=RCm.get(l.id);const s=m?stamp(m.body):'';return s||`Unstamped (login: ${nm(l.create_uid)})`};
 const deptOf=n=>(EI[n]||[''])[0];
 const CCU=new Set(['Call Center','Call Center Manager']);
 const apl=new Map();for(const a of appts){const k=a.crm_lead_id&&a.crm_lead_id[0];if(!k)continue;if(!apl.has(k))apl.set(k,[]);apl.get(k).push(a)}
 const pa=new Map();for(const a of att){const k=a.partner_id&&a.partner_id[0];if(!k)continue;if(!pa.has(k))pa.set(k,[]);pa.get(k).push(a)}
 const OP=new Map(leads.map(l=>[l.id,opener(l)]));
 const brs=new Set(['No branch','Older lead']),deps=new Set(['Unassigned']),docs=new Set(),users=new Set(),people=new Set();
 for(const l of leads){brs.add(nm(l.branch_id)||'No branch');users.add(nm(l.create_uid));people.add(OP.get(l.id));deps.add(nm(l.department_id)||'Unassigned')}
 for(const a of appts)if(a.specialist_id)docs.add(a.specialist_id[1]);
 for(const a of att){brs.add(nm(a.branch_id)||'No branch');users.add(nm(a.create_uid))}
 for(const a of acts)users.add(nm(a.create_uid));for(const m of msgs){users.add(nm(m.author_id)||nm(m.create_uid));const s=stamp(m.body);if(s)people.add(s)}
 for(const m of ast){const s=stamp(m.body);if(s)people.add(s)}
 const Bn=[...brs].sort(),Pn=[...deps].sort(),Dn=[...docs].sort().concat(['—']),Un=[...users].sort(),PN=[...people].sort(),LGn=Un;
 const isCCRec=l=>deptOf(OP.get(l.id))==='Contact Center'||CCU.has(nm(l.create_uid));
 const cc=leads.filter(isCCRec);
 const rows=[],hs=[],rbs=[];
 const phones=cc.map(l=>digits(l.phone||l.mobile||'').slice(-10));
 const uniq=[...new Set(phones.filter(p=>p.length===10))];const HM=new Map();await Promise.all(uniq.map(async p=>HM.set(p,await sha12(p))));
 cc.forEach((l,ix)=>{const t=toCairo(l.create_date);const aps=(apl.get(l.id)||[]).sort((x,y)=>x.id-y.id);
  let o=0;if(aps.length){if(aps.some(a=>ATT_ST.includes(a.states)))o=1;else{const live=aps.filter(a=>a.states==='pending'||a.states==='confirm');
   if(live.length){const d=live.map(a=>a.date).filter(Boolean).sort().pop();o=d&&d>=today?4:2}else if(aps.some(a=>a.states==='no_show'))o=2;else o=aps.some(a=>a.states==='cancel')?3:2}}
  const pid=l.partner_id&&l.partner_id[0];const hits=(pa.get(pid)||[]).filter(a=>a.date>=t.d);
  const op=OP.get(l.id);const pi=PN.indexOf(op);const team=deptOf(op)==='Contact Center'?1:0;const sp=aps.find(a=>a.specialist_id);
  rows.push([t.d,t.h,pi,Bn.indexOf(nm(l.branch_id)||'No branch'),Pn.indexOf(nm(l.department_id)||'Unassigned'),Dn.indexOf(sp?sp.specialist_id[1]:'—'),o,hits.length?1:0,Math.round(hits.reduce((s,a)=>s+(a.invoice_total||0),0)),team,LGn.indexOf(nm(l.create_uid))]);
  hs.push(phones[ix].length===10?HM.get(phones[ix]):'');
  if(aps.length&&pid){const own=aps.some(a=>ATT_ST.includes(a.states));const ids=new Set(aps.map(a=>a.id));
   if(own)rbs.push([t.d,Bn.indexOf(nm(l.branch_id)||'No branch'),-1,-1,1,pi,team,-1]);
   else{const h=hits.filter(a=>!ids.has(a.id)).sort((x,y)=>x.date<y.date?-1:1)[0];if(h){const sm=ASm.get(h.id);const s=sm?stamp(sm.body):'';rbs.push([t.d,Bn.indexOf(nm(l.branch_id)||'No branch'),Un.indexOf(nm(h.create_uid)),Bn.indexOf(nm(h.branch_id)||'No branch'),0,pi,team,s?PN.indexOf(s):-1])}}}});
 const ccByP=new Map();for(const l of cc){if(deptOf(OP.get(l.id))!=='Contact Center')continue;const p=l.partner_id&&l.partner_id[0];if(!p)continue;if(!ccByP.has(p))ccByP.set(p,[]);ccByP.get(p).push(toCairo(l.create_date).ms)}
 const srcName=l=>nm(l.source_id)||(l.referred?'Referral':'Not set'),campName=l=>nm(l.campaign_id)||nm(l.medium_id)||(l.referred?'Referred by '+l.referred:'—');
 const SRCn=[...new Set(leads.map(srcName))].sort(),CAMPn=[...new Set(leads.map(campName))].sort();CRM.SRC=SRCn;CRM.CAMP=CAMPn;
 const Lr=leads.map(l=>{const t=toCairo(l.create_date);const op=OP.get(l.id);const bm=BKm.get(l.id);const aps=apl.get(l.id)||[];
  let lag=-1;if(bm)lag=Math.max(0,Math.floor((toCairo(bm.create_date).ms-t.ms)/60000));else if(aps.length)lag=Math.max(0,Math.floor((Math.min(...aps.map(a=>toCairo(a.create_date).ms))-t.ms)/60000));
  let dup=0;if(deptOf(op)!=='Contact Center'&&l.partner_id){dup=(ccByP.get(l.partner_id[0])||[]).some(x=>x<t.ms&&t.ms-x<=30*864e5)?1:0}
  const lt=nm(l.employee_id);
  return [t.d,t.h,Un.indexOf(nm(l.create_uid)),Bn.indexOf(nm(l.branch_id)||'No branch'),(bm||aps.length)?1:0,lag,dup,PN.indexOf(op),lt&&lt!==op?1:0,SRCn.indexOf(srcName(l)),CAMPn.indexOf(campName(l))]});
 const lm=new Map(leads.map(l=>[l.id,l]));const lb=id=>{const l=lm.get(id);return l?(nm(l.branch_id)||'No branch'):'Older lead'};const lcc=id=>{const l=lm.get(id);return l&&isCCRec(l)?1:0};
 const tyi=n=>{n=String(n||'').trim();const i=CRM.Ty.indexOf(n);return i>=0?i:CRM.Ty.indexOf('To-Do')};
 const Ar=[];
 for(const a of acts){const t=toCairo(a.create_date);Ar.push([t.d,t.h,tyi(nm(a.activity_type_id)),Un.indexOf(nm(a.create_uid)),a.date_deadline&&a.date_deadline<today?1:0,outcomeOf(a.summary),Bn.indexOf(lb(a.res_id)),lcc(a.res_id),-1])}
 for(const m of msgs){const t=toCairo(m.date);const s=stamp(m.body);Ar.push([t.d,t.h,tyi(nm(m.mail_activity_type_id)),Un.indexOf(nm(m.author_id)||nm(m.create_uid)),2,-1,Bn.indexOf(lb(m.res_id)),lcc(m.res_id),s?PN.indexOf(s):-1])}
 E=PN;B=Bn;P=Pn;D=Dn;R=rows;LG=LGn;DATA.H=hs;CRM.U=Un;CRM.PN=PN;CRM.Bs=Bn;CRM.L=Lr;CRM.A=Ar;CRM.RB=rbs;
 st.branch=st.doctor=st.agent=st.dept='all';
}
function outcomeOf(s){if(!s)return 10;s=String(s).toLowerCase();const P=[[0,['no ans','no answer','not answer','na sw','لم يتم الرد','مردتش']],[2,['error','not in serv','no server']],[1,['busy','closed','مغلق']],[3,['book','حجز']],[4,['call us back','هتكلمنا','lma t3oz','will call']],[5,['not inters','msh 3awza','msh 7aba','مش عايزة']],[6,['msafra','مسافرة']],[7,['answer']],[8,['wp','whatsapp','msg','offer','واتس']],[9,['done']]];for(const [i,ps] of P)if(ps.some(p=>s.includes(p)))return i;return 11}
async function liveInit(){try{if(window.claude&&claude.use)LIVE.mcp=await claude.use('mcp')}catch(e){LIVE.mcp=null}liveStatus();if(LIVE.mcp)livePull()}


/* ---------- people (sub-user identity) ---------- */
function empInfo(n){const x=(CRM.EI||{})[n];return x?{dept:x[0],job:x[1],home:x[2],allowed:x[3],active:x[4]}:null}
function isUnstamped(n){return /^Unstamped/.test(n)}
function crossLogin(name,login){const e=empInfo(name);return !!(e&&e.home&&login&&e.home!==login)}

function renderIDQ(){const {U,PN}=CRM;const inR=d=>d>=st.from&&d<=st.to;const L=CRM.L.filter(r=>inR(r[0]));
 const cross=new Map();for(const r of L){const p=PN[r[7]],lg=U[r[2]];if(crossLogin(p,lg)){const k=p+'|'+lg;cross.set(k,(cross.get(k)||0)+1)}}
 const cr=[...cross.entries()].map(([k,n])=>{const [p,lg]=k.split('|');const e=empInfo(p);return {name:p,lg,home:e.home,ok:e.allowed&&e.allowed.length?'Yes':'—',n}});
 table('#tIdCross',cr,[['Person','name','t'],['Worked under','lg','t'],['Home login (HR)','home','t'],['Opportunities','n']],'n');
 const ov=L.filter(r=>r[8]);const byL=[...group(ov,2).entries()].map(([k,v])=>({name:U[k],n:v.length,of:L.filter(r=>r[2]===k).length,p:pct(v.length,L.filter(r=>r[2]===k).length)}));
 table('#tIdOvw',byL,[['Login','name','t'],['Overwritten','n'],['Of opportunities','of'],['Share','p','%']],'n');
 const people=[...new Set(L.map(r=>PN[r[7]]))];const hr=[];
 for(const p of people){if(isUnstamped(p))continue;const e=empInfo(p);if(!e){hr.push({name:p,issue:'Name on the stamp not found in HR'});continue}
  if(!e.active)hr.push({name:p,issue:'Archived employee still signing in'});if(!e.dept)hr.push({name:p,issue:'No department'});if(!e.job)hr.push({name:p,issue:'No job title'})}
 const norm=s=>s.toLowerCase().replace(/^dr\.?\s*/,'').replace(/[^a-z]/g,'');const seen=new Map();for(const n of Object.keys(CRM.EI||{})){const k=norm(n);if(!seen.has(k))seen.set(k,[]);seen.get(k).push(n)}
 for(const [k,v] of seen)if(v.length>1&&k.length>4)hr.push({name:v.join(' / '),issue:'Same person, more than one employee record'});
 for(const [n,k] of (CRM.DUPN||[]))hr.push({name:n,issue:`${k} employee records with the exact same name`});
 for(const n of Object.keys(CRM.EI||{}))if(n.trim().length<=4)hr.push({name:n,issue:'Test or junk employee record'});
 table('#tIdHR',hr,[['Employee','name','t'],['Issue','issue','t']],null);
 const unst=L.filter(r=>isUnstamped(PN[r[7]])).length;
 $('#idCards').innerHTML=[['Stamped',pctS(L.length-unst,L.length),`${fmt(L.length-unst)} of ${fmt(L.length)} opportunities carry a person`,1],['Cross-login',fmt(cr.reduce((s,x)=>s+x.n,0)),`by ${cr.length} people`],['Overwritten',fmt(ov.length),'employee field ≠ opener'],['HR fixes',fmt(hr.length),'records to clean']]
  .map(c=>`<div class="card ${c[3]?'dark':''}"><div class="k">${c[0]}</div><div class="v">${c[1]}</div><div class="d">${c[2]}</div></div>`).join('')}
/* ================= APPOINTMENTS ================= */
const AP_ST=['Showed','Confirmed','Pending','Cancelled','Rescheduled','No-show','Other'];
const AP_SRC=['Contact centre','Branch','System'];
let apSort='n';const apOpen=new Set();
function apRows(){const brName=st.branch==='all'?null:B[+st.branch],docName=st.doctor==='all'?null:D[+st.doctor],pName=st.agent==='all'?null:E[+st.agent];
 return APPT.R.filter(r=>r[0]>=st.from&&r[0]<=st.to&&(st.entity==='all'||(st.entity==='zat'?r[13]===1:r[13]===0))&&(!brName||APPT.BR[r[2]]===brName)&&(!docName||APPT.DOC[r[3]]===docName)&&(!pName||APPT.PP[r[6]]===pName))}
function apAgg(rs){const T=cairoToday();const a={n:0,sh:0,cf:0,pe:0,cn:0,rs:0,ns:0,up:0,nc:0,past:0,call:0,cc:0,br:0};
 for(const r of rs){if(r[4]===4){a.rs++;continue}a.n++;if(r[5]===0)a.cc++;else if(r[5]===1)a.br++;
  if(r[4]===0)a.sh++;else if(r[4]===3)a.cn++;else if(r[4]===5)a.ns++;else if(r[4]===1||r[4]===2){if(r[0]>=T)a.up++;else a.nc++}
  if(r[4]===1)a.cf++;if(r[4]===2)a.pe++;if(r[10])a.call++;if(r[0]<T&&r[4]!==3)a.past++}
 a.shr=pct(a.sh,a.past);a.arr=pct(a.sh,a.n-a.cn);a.cfr=pct(a.cf+0,a.cf+a.pe);a.cnr=pct(a.cn,a.n);return a}
const pillCls=v=>v==null?'bp-n':v>=80?'bp-g':v>=60?'bp-a':'bp-r';
const hm=m=>m<0?'—':`${String(Math.floor(m/60)%12||12)}:${String(m%60).padStart(2,'0')}${m>=720?'p':'a'}`;
function renderAppt(){
 const T=cairoToday();const rs=apRows();const a=apAgg(rs);
 const covered=LIVE.on||(st.from<=APPT.RANGE[1]&&st.to>=APPT.RANGE[0]);
 const lbl=st.from===st.to?(st.from===T?'today':nice(st.from)):`${nice(st.from)} → ${nice(st.to)}`;
 $('#hat').textContent=rs.length?`${fmt(a.n)} appointments ${st.from===st.to&&st.from===T?'today':'· '+lbl}`:'No appointments in this range';
 $('#hap').textContent=`Every appointment in Odoo for ${lbl}, by branch, hour, service and doctor — and who booked it: the contact centre or the branch.`;
 if(!rs.length){$('#apBody').style.display='none';$('#apEmpty').innerHTML=`<div class="notice ar">${covered?'مفيش مواعيد في الفترة دي بالفلاتر دي.':`النسخة دي فيها المواعيد من ${APPT.RANGE[0]} لـ ${APPT.RANGE[1]} بس. لما الصفحة تتفتح من حساب عليه كونكتور أودو، أي فترة بتتسحب لايف.`}</div>`;return}
 $('#apBody').style.display='';$('#apEmpty').innerHTML=(!LIVE.on&&(st.from<APPT.RANGE[0]||st.to>APPT.RANGE[1]))?`<div class="notice ar">النسخة دي فيها المواعيد من ${APPT.RANGE[0]} لـ ${APPT.RANGE[1]} بس، فالأرقام دي للجزء ده من الفترة. السحب اللايف بيجيب أي فترة.</div>`:'';
 const card=(k,v,d,dark)=>`<div class="card ${dark?'dark':''}"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
 $('#apCards').innerHTML=card('Booked',fmt(a.n),`${fmt(a.rs)} moved to another day`,1)+card('Showed',fmt(a.sh),st.to>=T?`${pctS(a.sh,a.n-a.cn)} of booked so far`:`${pctS(a.sh,a.past)} of the ones that were due`)+card('Still to come',fmt(a.up),'pending or confirmed')+card('Confirmed',pctS(a.cf,a.cf+a.pe),`${fmt(a.cf)} confirmed · ${fmt(a.pe)} pending`)+card('Not closed',fmt(a.nc),'day passed, still pending or confirmed')+card('Cancelled',fmt(a.cn),pctS(a.cn,a.n)+' of booked')+card('Contact centre',pctS(a.cc,a.n),`${fmt(a.cc)} booked by the contact centre`);
 // source split
 const sC=apAgg(rs.filter(r=>r[5]===0)),sB=apAgg(rs.filter(r=>r[5]!==0));
 const sb=(t,cls,s)=>`<div class="src ${cls}"><h4>${t}</h4><div class="big">${fmt(s.n)}<small>${pctS(s.n,a.n)} of bookings</small></div>
  <div class="row"><span>${st.to>=T?'Arrived so far':'Showed, of the ones due'}</span><b>${st.to>=T?pctS(s.sh,s.n-s.cn):(s.past?pctS(s.sh,s.past):'—')}</b></div><div class="row"><span>Confirmed</span><b>${pctS(s.cf,s.cf+s.pe)}</b></div><div class="row"><span>Cancelled</span><b>${pctS(s.cn,s.n)}</b></div><div class="row"><span>Moved to another day</span><b>${fmt(s.rs)}</b></div><div class="row"><span>Got a confirmation call</span><b>${pctS(s.call,s.n)}</b></div></div>`;
 $('#apSrc').innerHTML=sb('Booked by the contact centre','',sC)+sb('Booked by the branches','br',sB);
 // brands
 const za=apAgg(rs.filter(r=>r[13]===1)),na=apAgg(rs.filter(r=>r[13]===0));
 $('#apBrands').innerHTML=`<span><b>${fmt(na.n)}</b>Nouvel Age</span><span><b>${fmt(za.n)}</b>ZAT</span>`;
 // branches
 const gb=[...group(rs,2).entries()].map(([k,v])=>({k,name:APPT.BR[k],zat:v[0][13],v,...apAgg(v)}));
 const so={n:(x,y)=>y.n-x.n,sh:(x,y)=>(y.shr??-1)-(x.shr??-1),cf:(x,y)=>(y.cfr??-1)-(x.cfr??-1),name:(x,y)=>x.name.localeCompare(y.name)}[apSort];gb.sort(so);
 $('#apBranches').innerHTML=gb.map(b=>{const op=apOpen.has(b.name);
  const slots=[...Array(26)].map((_,i)=>540+i*30);const gs=group(b.v.filter(r=>r[4]!==4),r=>Math.floor(r[1]/30)*30);const mx=Math.max(1,...slots.map(s=>(gs.get(s)||[]).length));
  const docs=[...group(b.v.filter(r=>r[4]!==4),3).entries()].map(([k,v])=>[APPT.DOC[k],v.length]).sort((x,y)=>y[1]-x[1]).slice(0,8);
  const svc=[...group(b.v.filter(r=>r[4]!==4),7).entries()].map(([k,v])=>[APPT.FAM[k],v.length]).sort((x,y)=>y[1]-x[1]);
  return `<div class="brrow ${op?'open':''}"><button data-b="${b.name}" aria-expanded="${op}"><div><div class="bn">${b.name}</div><div class="bs">${b.zat?'ZAT':'Nouvel Age'} · ${fmt(b.cc)} contact centre · ${fmt(b.br)} branch</div></div>
  <div class="m"><small>Booked</small><b>${fmt(b.n)}</b></div><div class="m hide"><small>Showed</small><b>${fmt(b.sh)}</b></div><div class="m hide"><small>To come</small><b>${fmt(b.up)}</b></div><div class="m hide"><small>Not closed</small><b>${fmt(b.nc)}</b></div>
  <span class="bigpill ${st.to>=T?'bp-n':pillCls(b.shr)}" title="${st.to>=T?'Arrived so far, of booked (not cancelled)':'Showed, of the ones that were due'}">${(st.to>=T?b.arr:b.shr)??'—'}${(st.to>=T?b.arr:b.shr)==null?'':'%'}</span><span class="chev">▶</span></button>
  ${op?`<div class="brdet"><div><h4>Hour by hour</h4><div class="mini">${slots.map(s=>{const v=gs.get(s)||[];const c=v.filter(r=>r[5]===0).length;return `<i title="${hm(s)} · ${v.length} (${c} contact centre)" style="height:${v.length/mx*100}%;background:linear-gradient(to top,var(--espresso) ${v.length?c/v.length*100:0}%,var(--taupe) 0)"></i>`}).join('')}</div><div class="minil"><span>9a</span><span>12p</span><span>3p</span><span>6p</span><span>9:30p</span></div><div class="legend"><span><i style="background:var(--espresso)"></i>Contact centre</span><span><i style="background:var(--taupe)"></i>Branch</span></div></div>
  <div><h4>Doctors</h4>${docs.map(d=>`<div class="li"><span>${d[0]}</span><span>${d[1]}</span></div>`).join('')}</div>
  <div><h4>Services</h4>${svc.map(d=>`<div class="li"><span>${d[0]}</span><span>${d[1]} · ${pctS(d[1],b.n)}</span></div>`).join('')}</div></div>`:''}</div>`}).join('');
 $('#apBranches').querySelectorAll('.brrow>button').forEach(btn=>btn.onclick=()=>{const k=btn.dataset.b;apOpen.has(k)?apOpen.delete(k):apOpen.add(k);renderAppt()});
 // heat
 const act=rs.filter(r=>r[4]!==4&&r[1]>=0);const slots=[...Array(26)].map((_,i)=>540+i*30);
 const hmap=new Map();let hx=1;for(const r of act){const k=r[2]+'|'+Math.floor(r[1]/30)*30;hmap.set(k,(hmap.get(k)||0)+1);hx=Math.max(hx,hmap.get(k))}
 const tot=s=>act.filter(r=>Math.floor(r[1]/30)*30===s).length;
 $('#apHeat').innerHTML=`<thead><tr><th style="text-align:left">Branch</th>${slots.map(s=>`<th>${s%60?'':hm(s).replace(':00','')}</th>`).join('')}<th>Total</th></tr></thead><tbody>${gb.map(b=>`<tr><td class="nm">${b.name}</td>${slots.map(s=>{const v=hmap.get(b.k+'|'+s)||0,al=v/hx;return `<td title="${b.name} ${hm(s)}: ${v}" style="background:color-mix(in srgb,#58382c ${Math.round(al*92)}%,transparent);color:${al>.5?'#fff':'inherit'}">${v||''}</td>`}).join('')}<td><b>${b.n}</b></td></tr>`).join('')}</tbody><tfoot><tr><td class="nm">All</td>${slots.map(s=>`<td>${tot(s)||''}</td>`).join('')}<td>${fmt(a.n)}</td></tr></tfoot>`;
 // services
 const gf=[...group(rs.filter(r=>r[4]!==4),7).entries()].map(([k,v])=>({name:APPT.FAM[k],v,n:v.length})).sort((x,y)=>y.n-x.n);
 $('#apSvc').innerHTML=gf.map(f=>{const s=apAgg(f.v);const cats=[...group(f.v,8).entries()].map(([k,v])=>[APPT.CAT[k],v.length]).sort((x,y)=>y[1]-x[1]).slice(0,6);
  return `<div class="svc"><div class="t"><b>${f.name}</b><span>${pctS(f.n,a.n)} of total</span></div><div class="n">${fmt(f.n)}</div><div class="sub">${fmt(s.cc)} contact centre · ${fmt(s.br)} branch${s.past?` · ${pctS(s.sh,s.past)} showed`:''}</div><div class="bar"><i style="width:${f.n/a.n*100}%"></i></div>${cats.map(c=>`<div class="li"><span>${c[0]}</span><span>${fmt(c[1])} · ${pctS(c[1],f.n)}</span></div>`).join('')}</div>`}).join('');
 // doctors
 const gd=[...group(rs,3).entries()].map(([k,v])=>{const s=apAgg(v);const sl=v.filter(r=>r[4]!==4&&r[1]>=0).map(r=>r[1]).sort((x,y)=>x-y);const brs=[...new Set(v.map(r=>APPT.BR[r[2]]))].join(' · ');
  return {name:APPT.DOC[k],brs,n:s.n,sh:s.sh,up:s.up,nc:s.nc,cn:s.cn,rs:s.rs,ccs:pct(s.cc,s.n),span:sl.length?`${hm(sl[0])} – ${hm(sl[sl.length-1]+30)}`:'—',shr:st.to>=T?s.arr:s.shr}});
 table('#apDoc',gd,[['Doctor','name','t'],['Branches','brs','t'],['Booked','n'],['Showed','sh'],[st.to>=T?'Arrived so far':'Show rate','shr','p'],['To come','up'],['Not closed','nc'],['Cancelled','cn'],['Moved','rs'],['By contact centre','ccs','%'],['First – last slot','span','t']],'n');
 // day timeline
 const one=st.from===st.to;$('#apDayWrap').style.display=one?'':'none';
 if(one){$('#apDayLbl').textContent=lbl;
  const byDoc=[...group(rs.filter(r=>r[1]>=0),3).entries()].map(([k,v])=>({k,v,br:APPT.BR[v[0][2]],first:Math.min(...v.map(r=>r[1]))})).sort((x,y)=>x.br.localeCompare(y.br)||x.first-y.first);
  /* The ONLY edit to this script, and the reason is on screen: the window was
     fixed at 09:00–22:00 (`(m-540)/(1320-540)`), so an appointment earlier than
     9am produced a NEGATIVE left offset and drew itself on top of the doctor's
     name instead of on the track. The approved snapshot has 134 of them, the
     earliest at 01:00, so the standalone file does this too — it is not
     something the port introduced.
     The window now stretches to hold whatever the day actually contains.
     A day that fits inside 09:00–22:00 keeps exactly the old bounds, the old
     slot width (3000/780 === 100/26) and the old 10a–8p labels, so normal days
     render identically; only a day with outliers widens. */
  const mm=rs.filter(r=>r[1]>=0).map(r=>r[1]);
  const lo=Math.min(540,...mm),hi=Math.max(1320,...mm);
  const X=m=>(m-lo)/(hi-lo)*100;
  const HRS=[];for(let h=Math.ceil(lo/120)*2;h*60<hi;h+=2)HRS.push(h);
  $('#apLegend').innerHTML=[0,1,2,3,4].map(i=>`<span><i class="s${i}"></i>${AP_ST[i]}</span>`).join('')+`<span><i class="snc"></i>Not closed</span>`;
  $('#apDay').innerHTML=`<div class="tlh"><div></div><div>${HRS.map(h=>`<span style="left:${X(h*60)}%">${h>12?h-12:h}${h<12?'a':'p'}</span>`).join('')}</div></div>`+byDoc.map(d=>{const g=group(d.v,1);
   return `<div class="tlr"><div class="lab" title="${APPT.DOC[d.k]}">${APPT.DOC[d.k]}<small>${d.br} · ${d.v.filter(r=>r[4]!==4).length} appts</small></div><div class="tlt">${[...g.entries()].map(([m,v])=>{const live=v.filter(r=>r[4]!==4);const pick=live.length?live:v;const s=pick.some(r=>r[4]===0)?0:pick.some(r=>(r[4]===1||r[4]===2)&&r[0]<T)?'nc':pick.some(r=>r[4]===1)?1:pick.some(r=>r[4]===2)?2:pick[0][4];
    return `<i class="${s==='nc'?'snc':'s'+s}" style="left:${X(m)}%;width:calc(${3000/(hi-lo)}% - 2px)" title="${hm(m)} · ${pick.map(r=>AP_ST[r[4]]+' · '+APPT.FAM[r[7]]+' · '+AP_SRC[r[5]]).join(' | ')}">${pick.length>1?pick.length:''}</i>`}).join('')}</div></div>`}).join('')}
 // confirmation calls
 const due=rs.filter(r=>r[4]!==4&&r[4]!==3&&r[0]<T);const wc=due.filter(r=>r[10]),nc=due.filter(r=>!r[10]);
 $('#apConfCards').innerHTML=card('Got a confirmation call',fmt(a.call),`${pctS(a.call,a.n)} of booked`,1)+card('Showed, with a call',wc.length?pctS(wc.filter(r=>r[4]===0).length,wc.length):'—',`${fmt(wc.length)} were due`)+card('Showed, no call',nc.length?pctS(nc.filter(r=>r[4]===0).length,nc.length):'—',`${fmt(nc.length)} were due`);
 const gc=[...group(rs.filter(r=>r[10]&&r[11]>=0),11).entries()].map(([k,v])=>{const d=v.filter(r=>r[0]<T&&r[4]!==3&&r[4]!==4);return {name:APPT.PP[k],n:v.length,brs:[...new Set(v.map(r=>APPT.BR[r[2]]))].join(' · '),due:d.length,sh:pct(d.filter(r=>r[4]===0).length,d.length)}});
 table('#apConf',gc,[['Who called','name','t'],['Branches','brs','t'],['Appointments called','n'],['Of them due','due'],['Showed','sh','p']],'n');
 $('#apNote').innerHTML=`<b>إزاي تقرا الصفحة دي.</b> «Booked by» بيتحدد من اسم الموظفة اللي عملت الحجز بالـ PIN: لو من قسم Contact Center يبقى كول سنتر، غير كده يبقى الفرع. «Showed» محسوبة على المواعيد اللي يومها جه بس. ومكالمة التأكيد = أكتيفيتي Call أو To-Do اتعلّمت Done على الحجز نفسه في يومه أو قبله. ${a.call<a.n*0.2?`<br><b>ملحوظة:</b> ${pctS(a.call,a.n)} بس من الحجوزات عليها مكالمة تأكيد متسجلة، وأغلبها من كام موظفة بس في الجدول اللي فوق. يا إما الفروع مش بتأكد، يا إما بتأكد ومش بتسجل على الحجز.`:''}`;
}
document.querySelectorAll('#apSort button').forEach(b=>b.onclick=()=>{apSort=b.dataset.s;document.querySelectorAll('#apSort button').forEach(x=>x.setAttribute('aria-pressed',x===b));renderAppt()});


/* ---------- contact centre vs branches, on every tab ---------- */
function srcBoxes(sel,boxes){const el=$(sel);if(!el)return;el.innerHTML=boxes.map(b=>`<div class="src ${b.cls||''}"><h4>${b.title}</h4><div class="big">${b.big}<small>${b.bigl||''}</small></div>${b.rows.map(r=>`<div class="row"><span>${r[0]}</span><b>${r[1]}</b></div>`).join('')}</div>`).join('')}
function oppSplit(){const {PN,Bs}=CRM;const inR=d=>d>=st.from&&d<=st.to;const L=CRM.L.filter(r=>inR(r[0])&&brandOK(Bs[r[3]]));
 const isCC=r=>{const e=empInfo(PN[r[7]]);return e?e.dept==='Contact Center':false};
 const med=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)]};
 const S=v=>{const b=v.filter(r=>r[4]).length;const lg=v.filter(r=>r[5]>=0).map(r=>r[5]);return {n:v.length,b,br:pctS(b,v.length),med:med(lg),dup:v.filter(r=>r[6]).length,people:new Set(v.map(r=>r[7])).size}};
 const ap=APPT.R.filter(r=>r[0]>=st.from&&r[0]<=st.to&&(st.entity==='all'||(st.entity==='zat'?r[13]===1:r[13]===0)));
 const A=v=>apAgg(v);return {cc:S(L.filter(isCC)),br:S(L.filter(r=>!isCC(r))),acc:A(ap.filter(r=>r[5]===0)),abr:A(ap.filter(r=>r[5]!==0)),tot:L.length}}
function renderSrcAll(){const s=oppSplit();const T=cairoToday();
 const box=(t,cls,o,a)=>({title:t,cls,big:fmt(o.n),bigl:`opportunities · ${o.people} people`,rows:[['Booked',`${fmt(o.b)} · ${o.br}`],['Minutes to booking (median)',o.med==null?'—':o.med+' min'],['Re-opened a contact-centre patient',fmt(o.dup)],['Appointments in the range',fmt(a.n)],[st.to>=T?'Arrived so far':'Showed, of the ones due',st.to>=T?pctS(a.sh,a.n-a.cn):(a.past?pctS(a.sh,a.past):'—')],['Cancelled',pctS(a.cn,a.n)]]});
 const b=[box('Contact centre','',s.cc,s.acc),box('Branches','br',s.br,s.abr)];
 srcBoxes('#exSrc',b);srcBoxes('#crSrc',b);
 // calls split
 const C=UCM.calls.filter(c=>c[0]>=st.from&&c[0]<=st.to&&c[2]===2);const cc=C.filter(c=>extGroup(c[3])==='cc'),brc=C.filter(c=>extGroup(c[3])==='branch');const IN=UCM.calls.filter(c=>c[0]>=st.from&&c[0]<=st.to&&c[2]===1);
 const avg=a=>a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length):0;const mm=s=>`${Math.floor(s/60)}m ${String(s%60).padStart(2,'0')}s`;
 srcBoxes('#caSrc',[{title:'Contact centre lines',big:fmt(cc.length+IN.length),bigl:'calls on the phones',rows:[['Inbound calls',fmt(IN.length)],['Answered in queue',pctS(IN.filter(c=>c[4]).length,IN.filter(c=>c[8]).length)],['Dials',fmt(cc.length)],['Connected',pctS(cc.filter(c=>c[4]).length,cc.length)],['Avg talk, dials',mm(avg(cc.filter(c=>c[4]).map(c=>c[6])))]]},
  {title:'Branch reception lines',cls:'br',big:fmt(brc.length),bigl:'dials (follow-up & confirmation)',rows:[['Inbound calls','routed to the contact centre'],['Dials',fmt(brc.length)],['Connected',pctS(brc.filter(c=>c[4]).length,brc.length)],['Avg talk, dials',mm(avg(brc.filter(c=>c[4]).map(c=>c[6])))],['Lines',fmt(new Set(brc.map(c=>c[3])).size)]]}]);
 // branch staff table (agents tab)
 const {PN,Bs,U}=CRM;const inR=d=>d>=st.from&&d<=st.to;const L=CRM.L.filter(r=>inR(r[0])&&brandOK(Bs[r[3]]));
 const ap=APPT.R.filter(r=>r[0]>=st.from&&r[0]<=st.to);
 const nonCC=L.filter(r=>{const e=empInfo(PN[r[7]]);return !(e&&e.dept==='Contact Center')});
 const gs=[...group(nonCC,7).entries()].map(([k,v])=>{const name=PN[k];const e=empInfo(name);const lg=[...group(v,2).entries()].sort((a,b)=>b[1].length-a[1].length)[0];const b=v.filter(r=>r[4]).length;const mine=ap.filter(r=>APPT.PP[r[6]]===name);const ma=apAgg(mine);
  return {name,role:e?(e.job||e.dept||'—'):'Not in HR',login:U[lg[0]],n:v.length,b,br:pct(b,v.length),dup:v.filter(r=>r[6]).length,ap:ma.n,sh:st.to>=T?ma.arr:ma.shr}});
 table('#tBranchStaff',gs,[['Person','name','t'],['Login','login','t'],['Role','role','t'],['Opps','n'],['Booked','b'],['Booking rate','br','%'],['Re-opened CC patient','dup'],['Appointments booked','ap'],[st.to>=T?'Arrived so far':'Show rate','sh','p']],'n');
 // timing split
 const gh=group(L,1);const hrs=[...Array(14)].map((_,i)=>9+i);const isC=r=>{const e=empInfo(PN[r[7]]);return e&&e.dept==='Contact Center'};
 table('#tSrcHour',hrs.map(h=>{const v=gh.get(h)||[];const c=v.filter(isC),b=v.filter(r=>!isC(r));return {h:String(h).padStart(2,'0')+':00',cc:c.length,ccb:pct(c.filter(r=>r[4]).length,c.length),br:b.length,brb:pct(b.filter(r=>r[4]).length,b.length)}}),[['Hour','h','t'],['Contact centre opps','cc'],['CC booked','ccb','%'],['Branch opps','br'],['Branch booked','brb','%']],null);
}


function renderLeadSource(L){const {PN}=CRM;const SRC=CRM.SRC||['Not set'],CAMP=CRM.CAMP||['—'];
 const sOf=r=>SRC[r[9]??0]||'Not set',cOf=r=>CAMP[r[10]??0]||'—';
 const isCC=r=>{const e=empInfo(PN[r[7]]);return e&&e.dept==='Contact Center'};
 const set=L.filter(r=>sOf(r)!=='Not set');
 $('#lsCards').innerHTML=[['Opportunities',fmt(L.length),'in the range',1],['With a source',fmt(set.length),pctS(set.length,L.length)+' of opportunities'],['Sources used',fmt(new Set(set.map(sOf)).size),'flyer, agreement, ads…'],['Campaigns / agreements',fmt(new Set(set.map(cOf).filter(x=>x!=='—')).size),'e.g. a flyer drop or a corporate deal']]
  .map(c=>`<div class="card ${c[3]?'dark':''}"><div class="k">${c[0]}</div><div class="v">${c[1]}</div><div class="d">${c[2]}</div></div>`).join('');
 $('#lsNote').innerHTML=set.length<L.length*0.5?`<div class="notice ar red" style="margin-top:14px"><b>${set.length?`${pctS(L.length-set.length,L.length)} من الفرص`:'ولا فرصة'} من غير مصدر.</b> خانات Source وMedium وCampaign على الأوبورتيونيتي فاضية، والمصادر المتعرّفة في أودو هي الافتراضية بتاعة أودو بس (Facebook وNewsletter وLinkedIn…). عشان الجزء ده يشتغل:
 <ol><li><b>المصادر:</b> فريق أودو يعمل قايمة Sources بتاعتنا: Flyer، Corporate agreement، Walk-in، Referral، Facebook، Instagram، TikTok، WhatsApp، Google، Phone call. والخانة تبقى إجبارية قبل الحفظ.</li>
 <li><b>الحملات:</b> كل توزيع فلاير ليه Campaign باسم المكان والتاريخ (مثلاً «Flyer · Madinaty · Oct 2026»)، وكل اتفاق ليه Campaign باسم الجهة (مثلاً «CIB agreement»).</li>
 <li><b>الترشيح:</b> لو الليد جاية من ترشيح، اسم اللي رشّحها يتكتب في Referred By.</li></ol>
 أول ما ده يتملا، الجداول دي هتوريك كل مصدر جاب كام فرصة واتحجز منها كام، ومين اللي دخلها بالاسم، يوم بيوم، على الفلتر اللي فوق.</div>`:'';
 const st2=v=>{const b=v.filter(r=>r[4]).length;return {n:v.length,bk:b,br:pct(b,v.length),cc:v.filter(isCC).length,brn:v.filter(r=>!isCC(r)).length}};
 const gs=[...group(L,r=>sOf(r)+'|'+cOf(r)).entries()].map(([k,v])=>{const [s,c]=k.split('|');const top=[...group(v,7).entries()].sort((a,b)=>b[1].length-a[1].length).slice(0,2).map(([p,x])=>`${PN[p]} (${x.length})`).join(', ');return {s,c,...st2(v),top}});
 table('#tLsSrc',gs,[['Source','s','t'],['Campaign / agreement','c','t'],['Opps','n'],['Booked','bk'],['Booking %','br','%'],['By contact centre','cc'],['By branches','brn'],['Mostly entered by','top','t']],'n');
 const gw=[...group(L,r=>PN[r[7]]+'|'+sOf(r)).entries()].map(([k,v])=>{const [p,s]=k.split('|');return {p,s,...st2(v)}});
 table('#tLsWho',gw,[['Entered by','p','t'],['Source','s','t'],['Opps','n'],['Booked','bk'],['Booking %','br','%']],'n');
 const srcs=[...new Set(L.map(sOf))].sort((a,b)=>L.filter(r=>sOf(r)===b).length-L.filter(r=>sOf(r)===a).length).slice(0,7);
 const gd=[...group(L,0).entries()].sort();
 $('#tLsDay').innerHTML=gd.length?`<thead><tr><th class="l">Date</th>${srcs.map(s=>`<th>${s}</th>`).join('')}<th>Total</th></tr></thead><tbody>${gd.map(([d,v])=>`<tr><td class="nm">${d}</td>${srcs.map(s=>`<td>${fmt(v.filter(r=>sOf(r)===s).length)||''}</td>`).join('')}<td><b>${fmt(v.length)}</b></td></tr>`).join('')}</tbody>`:'<tbody><tr><td class="empty">Nothing in this range.</td></tr></tbody>';
}

const lastTables={};
function table(sel,data,cols,def,asc){
 const s=st.sort[sel]||{k:def,d:asc?1:-1};
 const d=s.k?[...data].sort((x,y)=>{const a=x[s.k],b=y[s.k];return (typeof a==='string'?String(a).localeCompare(b):(a??-1)-(b??-1))*s.d}):data;
 const el=$(sel);lastTables[sel]={cols,rows:d};
 if(!data.length){el.innerHTML='<tbody><tr><td class="empty">Nothing in this range.</td></tr></tbody>';return}
 const sum=k=>data.reduce((t,x)=>t+(x[k]||0),0);
 const cell=(c,x)=>{const v=x[c[1]];if(c[2]==='t')return `<td class="${c===cols[0]?'nm':''}">${v}</td>`;if(c[2]==='tag')return `<td><span class="tag">ODOO</span></td>`;if(c[2]==='tagU')return `<td><span class="tag">UCM</span></td>`;if(c[2]==='p')return `<td>${pill(v)}</td>`;if(c[2]==='%')return `<td>${v==null?'—':v+'%'}</td>`;if(c[2]==='m')return `<td>${v==null?'—':v+' min'}</td>`;return `<td>${fmt(v)}</td>`};
 const foot=cols.map((c,i)=>{if(i===0)return '<td>Total</td>';if(c[1]==='br')return `<td>${pctS(sum('bk'),sum('n'))}</td>`;if(c[1]==='sr')return `<td>${pill(pct(sum('show'),sum('past')))}</td>`;if(c[2]==='t'||c[2]==='%'||c[2]==='tag'||c[2]==='tagU'||c[2]==='m')return '<td></td>';return `<td>${fmt(sum(c[1]))}</td>`}).join('');
 el.innerHTML=`<thead><tr>${cols.map(c=>`<th data-k="${c[1]}" ${s.k===c[1]?`data-dir="${s.d<0?'↓':'↑'}"`:''}>${c[0]}</th>`).join('')}</tr></thead><tbody>${d.map(x=>`<tr>${cols.map(c=>cell(c,x)).join('')}</tr>`).join('')}</tbody><tfoot><tr>${foot}</tr></tfoot>`;
 el.querySelectorAll('th').forEach(th=>th.onclick=()=>{const k=th.dataset.k;st.sort[sel]={k,d:s.k===k?-s.d:-1};render()});
}
/* ---------- tabs ---------- */
const TABS=[['pa','Appointments'],['p1','Executive summary'],['pc','CRM'],['pu','Calls'],['p2','Agents'],['p3','Timing'],['p4','Branches & doctors'],['p5','Data quality']];
$('#tabs').innerHTML=TABS.map(([id,n],i)=>`<button role="tab" data-tab="${id}" aria-selected="${id==='pa'}"><em>0${i}</em>${n.replace('&','&amp;')}</button>`).join('');
function stickTabs(){$('#tabs').style.top=(matchMedia('(max-width:900px)').matches?0:$('#topbar').offsetHeight)+'px'}
document.querySelectorAll('#tabs button').forEach(b=>b.onclick=()=>{st.tab=b.dataset.tab;document.querySelectorAll('#tabs button').forEach(x=>x.setAttribute('aria-selected',x===b));document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('on',p.id===st.tab));const top=$('.tabs').getBoundingClientRect().top+scrollY-parseFloat($('#tabs').style.top||0);if(scrollY>top)scrollTo({top});try{localStorage.setItem('nrs-cc-tab',st.tab)}catch(e){}});
/* ---------- wiring ---------- */
document.querySelectorAll('#preset button').forEach(b=>b.onclick=()=>{st.preset=b.dataset.p;[st.from,st.to]=presetRange(st.preset);LIVE.mcp?livePull():render()});
$('#bShow').onclick=()=>{let f=$('#dFrom').value,t=$('#dTo').value;if(!f||!t){toast('Pick both dates');return}if(f>t)[f,t]=[t,f];st.from=f;st.to=t;st.preset='';LIVE.mcp?livePull():render()};
document.querySelectorAll('#entity button').forEach(b=>b.onclick=()=>{st.entity=b.dataset.e;render()});
document.querySelectorAll('#team button').forEach(b=>b.onclick=()=>{if(user().lock.team)return;st.team=b.dataset.t;render()});
$('#fBranch').onchange=e=>{st.branch=e.target.value;render()};$('#fDoctor').onchange=e=>{st.doctor=e.target.value;render()};
$('#fAgent').onchange=e=>{st.agent=e.target.value;render()};$('#fDept').onchange=e=>{st.dept=e.target.value;render()};
$('#bSync').onclick=()=>{if(!LIVE.mcp){toast('Connect odoo-nouvelage18 in Settings → Connectors to pull live');return}livePull()};

let downloads=null;
if(window.claude&&claude.use)claude.use('downloads').then(d=>{downloads=d}).catch(()=>{});
$('#bExport').onclick=async()=>{if(!user().can.exp){toast('Export is not part of your role');return}
 const map={pa:'#apDoc',pu:'#tUAgent',pc:'#tCrmLogin',p1:'#tDaily',p2:'#tAgents',p3:'#tWd',p4:'#tBranch',p5:'#tIdCross'};const t=lastTables[map[st.tab]];
 if(!t||!t.rows.length){toast('Nothing to export for this range');return}
 const esc=v=>{v=v==null?'':String(v);return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
 const csv=[t.cols.map(c=>c[0]).join(',')].concat(t.rows.map(x=>t.cols.map(c=>c[2]==='tag'?'ODOO':esc(x[c[1]])).join(','))).join('\n');
 const name=`nrs-contact-centre_${st.from}_${st.to}.csv`;
 if(!downloads){toast('Export needs the NRS viewer — open this page from claude.ai');return}
 try{await downloads.save({filename:name,data:csv});}catch(e){toast('Export was not saved')}};
function toast(m){const t=$('#toast');t.textContent=m;t.style.display='block';clearTimeout(t._h);t._h=setTimeout(()=>t.style.display='none',2600)}
addEventListener('resize',stickTabs);
readURL();
if(st.preset&&st.preset!=='lm'&&!new URLSearchParams(location.search).get('from'))[st.from,st.to]=presetRange(st.preset);
render();stickTabs();ucmInit();liveInit();
try{const s=localStorage.getItem('nrs-cc-tab');const b=s&&document.querySelector(`#tabs button[data-tab="${s}"]`);b&&b.click()}catch(e){}
