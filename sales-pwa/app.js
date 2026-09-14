const LOCAL_KEY = 'saleslog_v2';
const defaultProducts = Array.from({length:5}, (_,i) => ({
  id: i + 1,
  name: `Product ${i + 1}`,
  price: 10,
  dealType: 'none',
  dealQty: 0,
  dealPrice: 0,
  freeQty: 0
}));

let state = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null') || {products: defaultProducts, sales: []};
let cart = {};
let supabaseClient = null;
let session = null;
let cloudMode = false;
let realtimeChannel = null;
let syncing = false;

const money = n => new Intl.NumberFormat('en-BE', {style:'currency', currency:'EUR'}).format(Number(n || 0));
const $ = s => document.querySelector(s);

function saveLocal(){ localStorage.setItem(LOCAL_KEY, JSON.stringify(state)); }
function toast(text){ const el=$('#toast'); el.textContent=text; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'), 1800); }
function esc(s=''){ return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function attr(s=''){ return esc(s); }

function dealText(p){
  if(p.dealType==='bundle' && p.dealQty>1) return `${p.dealQty} for ${money(p.dealPrice)}`;
  if(p.dealType==='free' && p.dealQty>0 && p.freeQty>0) return `Buy ${p.dealQty}, get ${p.freeQty} free`;
  return '';
}

function linePrice(p,q){
  if(p.dealType==='bundle' && p.dealQty>1){
    return Math.floor(q/p.dealQty)*p.dealPrice + (q%p.dealQty)*p.price;
  }
  if(p.dealType==='free' && p.dealQty>0 && p.freeQty>0){
    const group=p.dealQty+p.freeQty;
    return (Math.floor(q/group)*p.dealQty + Math.min(q%group,p.dealQty))*p.price;
  }
  return q*p.price;
}

function renderProducts(){
  $('#productGrid').innerHTML = state.products.map(p=>`<button class="product" onclick="addProduct(${p.id})"><b>${esc(p.name)}</b><small>${money(p.price)} each</small>${dealText(p)?`<span class="deal">${dealText(p)}</span>`:''}</button>`).join('');
  renderCart();
}

window.addProduct = id => { cart[id]=(cart[id]||0)+1; renderCart(); };
window.changeQty = (id,d) => { cart[id]=Math.max(0,(cart[id]||0)+d); if(!cart[id]) delete cart[id]; renderCart(); };

function renderCart(){
  const items=state.products.filter(p=>cart[p.id]);
  let total=0;
  $('#cart').innerHTML = items.length ? items.map(p=>{
    const q=cart[p.id], lp=linePrice(p,q); total+=lp;
    return `<div class="cart-item"><div><b>${esc(p.name)}</b><div class="history-meta">${q} unit${q>1?'s':''} · ${money(lp)}</div></div><div class="qty"><button onclick="changeQty(${p.id},-1)">−</button><b>${q}</b><button onclick="changeQty(${p.id},1)">+</button></div><strong>${money(lp)}</strong></div>`;
  }).join('') : `<p class="muted">Tap a product to add it.</p>`;
  $('#cartTotal').textContent=money(total);
}

async function recordSale(){
  const items=state.products.filter(p=>cart[p.id]).map(p=>({id:p.id,name:p.name,qty:cart[p.id],unitPrice:p.price,total:linePrice(p,cart[p.id])}));
  if(!items.length) return toast('Add a product first');
  const sale={
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    date: new Date().toISOString(),
    items,
    total: items.reduce((a,b)=>a+b.total,0),
    note: $('#saleNote').value.trim()
  };
  state.sales.unshift(sale); cart={}; $('#saleNote').value=''; saveLocal(); renderAll();
  if(cloudMode){
    const {error}=await supabaseClient.from('sales').insert({id:sale.id,user_id:session.user.id,sold_at:sale.date,total:sale.total,note:sale.note,items:sale.items});
    if(error){ toast('Saved locally — cloud sync failed'); return; }
  }
  toast('Sale recorded');
}

function renderHistory(){
  $('#historyList').innerHTML = state.sales.length ? state.sales.map(s=>`<div class="history-item"><div class="history-head"><b>${money(s.total)}</b><span>${new Date(s.date).toLocaleString()}</span></div><div>${s.items.map(i=>`${i.qty}× ${esc(i.name)}`).join(' · ')}</div>${s.note?`<div class="history-meta">${esc(s.note)}</div>`:''}<button class="ghost delete-sale" onclick="deleteSale('${s.id}')">Delete</button></div>`).join('') : `<p class="muted">No sales yet.</p>`;
}

window.deleteSale = async id => {
  if(!confirm('Delete this sale?')) return;
  state.sales=state.sales.filter(s=>s.id!==id); saveLocal(); renderAll();
  if(cloudMode){ const {error}=await supabaseClient.from('sales').delete().eq('id',id); if(error) toast('Deleted locally; cloud delete failed'); }
};

function renderStats(){
  const now=new Date();
  const today=state.sales.filter(s=>new Date(s.date).toDateString()===now.toDateString());
  const sum=a=>a.reduce((x,s)=>x+Number(s.total||0),0);
  $('#todayRevenue').textContent=money(sum(today));
  $('#allRevenue').textContent=money(sum(state.sales));
  $('#saleCount').textContent=state.sales.length;
  $('#unitCount').textContent=state.sales.reduce((a,s)=>a+s.items.reduce((x,i)=>x+Number(i.qty||0),0),0);
  $('#productStats').innerHTML=state.products.map(p=>{
    let q=0,r=0;
    state.sales.forEach(s=>s.items.filter(i=>Number(i.id)===Number(p.id)).forEach(i=>{q+=Number(i.qty||0);r+=Number(i.total||0);}));
    return `<div class="row stat-row"><span>${esc(p.name)}<small class="muted stat-small">${q} units</small></span><b>${money(r)}</b></div>`;
  }).join('');
}

function renderSettings(){
  $('#settingsProducts').innerHTML=state.products.map((p,idx)=>`<div class="setting-product" data-i="${idx}"><b>Product ${idx+1}</b><div class="setting-grid"><label>Name<input data-k="name" value="${attr(p.name)}"></label><label>Unit price<input data-k="price" type="number" min="0" step=".01" value="${p.price}"></label></div><label>Deal<select data-k="dealType"><option value="none" ${p.dealType==='none'?'selected':''}>No deal</option><option value="bundle" ${p.dealType==='bundle'?'selected':''}>Fixed bundle price</option><option value="free" ${p.dealType==='free'?'selected':''}>Buy X get Y free</option></select></label><div class="setting-grid"><label>Deal / buy quantity<input data-k="dealQty" type="number" min="0" value="${p.dealQty||0}"></label><label>Bundle price<input data-k="dealPrice" type="number" min="0" step=".01" value="${p.dealPrice||0}"></label><label>Free quantity<input data-k="freeQty" type="number" min="0" value="${p.freeQty||0}"></label></div></div>`).join('');
}

async function saveSettings(){
  document.querySelectorAll('.setting-product').forEach(box=>{
    const p=state.products[+box.dataset.i];
    box.querySelectorAll('[data-k]').forEach(inp=>{
      const k=inp.dataset.k;
      p[k]=['price','dealQty','dealPrice','freeQty'].includes(k)?Number(inp.value):inp.value;
    });
  });
  saveLocal(); renderAll();
  if(cloudMode){
    const rows=state.products.map((p,idx)=>({user_id:session.user.id,slot:idx+1,name:p.name,price:p.price,deal_type:p.dealType,deal_qty:p.dealQty,deal_price:p.dealPrice,free_qty:p.freeQty}));
    const {error}=await supabaseClient.from('products').upsert(rows,{onConflict:'user_id,slot'});
    if(error) return toast('Saved locally — cloud sync failed');
  }
  toast('Settings saved');
}

function exportCsv(){
  const rows=[['Date','Total','Items','Note'],...state.sales.map(s=>[new Date(s.date).toLocaleString(),s.total,s.items.map(i=>`${i.qty}x ${i.name}`).join('; '),s.note||''])];
  download('sales.csv',rows.map(r=>r.map(v=>`"${String(v).replaceAll('"','""')}"`).join(',')).join('\n'),'text/csv');
}
function download(name,text,type){ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text],{type})); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),500); }

async function loadCloud(){
  if(!cloudMode || syncing) return;
  syncing=true; setSyncBadge('Syncing…','working');
  try{
    const [{data:products,error:pe},{data:sales,error:se}] = await Promise.all([
      supabaseClient.from('products').select('*').order('slot'),
      supabaseClient.from('sales').select('*').order('sold_at',{ascending:false})
    ]);
    if(pe) throw pe; if(se) throw se;
    if(products?.length){
      state.products=products.map((p,idx)=>({id:idx+1,name:p.name,price:Number(p.price),dealType:p.deal_type,dealQty:Number(p.deal_qty),dealPrice:Number(p.deal_price),freeQty:Number(p.free_qty)}));
    } else {
      await pushProducts();
    }
    state.sales=(sales||[]).map(s=>({id:s.id,date:s.sold_at,items:s.items,total:Number(s.total),note:s.note||''}));
    saveLocal(); renderAll(); setSyncBadge('Synced','ok');
  } catch(e){ console.error(e); setSyncBadge('Sync issue','error'); toast('Cloud sync failed'); }
  finally{ syncing=false; }
}

async function pushProducts(){
  const rows=state.products.map((p,idx)=>({user_id:session.user.id,slot:idx+1,name:p.name,price:p.price,deal_type:p.dealType,deal_qty:p.dealQty,deal_price:p.dealPrice,free_qty:p.freeQty}));
  const {error}=await supabaseClient.from('products').upsert(rows,{onConflict:'user_id,slot'}); if(error) throw error;
}

async function pushLocalSalesIfCloudEmpty(){
  if(!cloudMode || !state.sales.length) return;
  const {count,error}=await supabaseClient.from('sales').select('*',{count:'exact',head:true});
  if(error || count>0) return;
  const rows=state.sales.map(s=>({id:s.id,user_id:session.user.id,sold_at:s.date,total:s.total,note:s.note||'',items:s.items}));
  await supabaseClient.from('sales').insert(rows);
}

function setSyncBadge(text,mode=''){ const b=$('#syncBadge'); b.textContent=text; b.className='sync-badge '+mode; }

function setupRealtime(){
  if(!cloudMode) return;
  if(realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
  realtimeChannel=supabaseClient.channel(`sales-${session.user.id}`)
    .on('postgres_changes',{event:'*',schema:'public',table:'sales',filter:`user_id=eq.${session.user.id}`},()=>loadCloud())
    .on('postgres_changes',{event:'*',schema:'public',table:'products',filter:`user_id=eq.${session.user.id}`},()=>loadCloud())
    .subscribe();
}

function showApp(){
  $('#authScreen').hidden=true; $('#mainApp').hidden=false;
  $('#today').textContent=new Date().toLocaleDateString(undefined,{weekday:'long',day:'numeric',month:'long'});
  renderAll();
}
function showAuth(){ $('#mainApp').hidden=true; $('#authScreen').hidden=false; }

async function signIn(){
  if(!supabaseClient) return toast('Connect Supabase first or use local mode');
  const email=$('#authEmail').value.trim(), password=$('#authPassword').value;
  if(!email||!password) return toast('Enter email and password');
  const {data,error}=await supabaseClient.auth.signInWithPassword({email,password});
  if(error) return toast(error.message);
  session=data.session; await enterCloudMode();
}

async function signUp(){
  if(!supabaseClient) return toast('Connect Supabase first or use local mode');
  const email=$('#authEmail').value.trim(), password=$('#authPassword').value;
  if(!email||password.length<6) return toast('Use an email and 6+ character password');
  const {data,error}=await supabaseClient.auth.signUp({email,password});
  if(error) return toast(error.message);
  if(data.session){ session=data.session; await enterCloudMode(); }
  else toast('Account created. Check your email if confirmation is enabled.');
}

async function enterCloudMode(){
  cloudMode=true; showApp(); $('#accountStatus').textContent=session.user.email; setSyncBadge('Syncing…','working');
  await pushLocalSalesIfCloudEmpty(); await loadCloud(); setupRealtime();
}

function enterLocalMode(){ cloudMode=false; session=null; showApp(); $('#accountStatus').textContent='Local mode'; setSyncBadge('Local'); }

async function signOut(){
  if(supabaseClient && cloudMode) await supabaseClient.auth.signOut();
  cloudMode=false; session=null; if(realtimeChannel) supabaseClient.removeChannel(realtimeChannel); showAuth();
}

function initSupabase(){
  const cfg=window.SALES_APP_CONFIG||{};
  const configured=cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase;
  if(configured){
    supabaseClient=window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseAnonKey);
    $('#backendHint').textContent='Cloud backend connected.';
  } else {
    $('#backendHint').innerHTML='Cloud is not configured yet. Follow <b>README.md</b>, or use local mode.';
  }
}

function renderAll(){ renderProducts(); renderHistory(); renderStats(); renderSettings(); }

function wireUi(){
  document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{document.querySelectorAll('nav button,.tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');$('#'+b.dataset.tab).classList.add('active');});
  $('#recordSale').onclick=recordSale;
  $('#saveSettings').onclick=saveSettings;
  $('#exportCsv').onclick=exportCsv;
  $('#exportJson').onclick=()=>download('sales-backup.json',JSON.stringify(state,null,2),'application/json');
  $('#importJson').onchange=async e=>{try{const x=JSON.parse(await e.target.files[0].text());if(!x.products||!x.sales)throw 0;state=x;saveLocal();renderAll();if(cloudMode){await pushProducts(); await pushLocalSalesIfCloudEmpty(); await loadCloud();}toast('Backup imported')}catch{toast('Invalid backup')}};
  $('#clearData').onclick=async()=>{if(!confirm('Delete all recorded sales?'))return;state.sales=[];saveLocal();renderAll();if(cloudMode)await supabaseClient.from('sales').delete().eq('user_id',session.user.id);toast('Sales deleted')};
  $('#signInBtn').onclick=signIn; $('#signUpBtn').onclick=signUp; $('#localModeBtn').onclick=enterLocalMode; $('#signOutBtn').onclick=signOut; $('#syncNow').onclick=loadCloud;
  let deferred;
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferred=e;const b=$('#installBtn');b.hidden=false;b.onclick=async()=>{await deferred.prompt();deferred=null;b.hidden=true;}});
}

async function boot(){
  initSupabase(); wireUi();
  if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
  if(supabaseClient){
    const {data}=await supabaseClient.auth.getSession();
    if(data.session){ session=data.session; await enterCloudMode(); return; }
  }
  showAuth();
}

boot();
