const LOCAL_KEY = 'saleslog_v3';
const defaultProducts = [
  {
    id: 1,
    name: 'Large product',
    price: 50,
    productType: 'fractional_large',
    stock: 50,
    standardAmount: 0.7,
    fullPrice: 60,
    dealType: 'none',
    dealQty: 0,
    dealPrice: 0,
    freeQty: 0
  },
  ...Array.from({length:4}, (_,i) => ({
    id: i + 2,
    name: `Product ${i + 2}`,
    price: 10,
    productType: 'standard',
    stock: 0,
    standardAmount: 1,
    fullPrice: 0,
    dealType: 'none',
    dealQty: 0,
    dealPrice: 0,
    freeQty: 0
  }))
];

function normalizeProduct(p, idx){
  const base = defaultProducts[idx] || defaultProducts[0];
  return {
    ...base,
    ...p,
    id: idx + 1,
    price: Number(p?.price ?? base.price),
    stock: Number(p?.stock ?? base.stock),
    standardAmount: Number(p?.standardAmount ?? base.standardAmount),
    fullPrice: Number(p?.fullPrice ?? base.fullPrice),
    dealQty: Number(p?.dealQty ?? base.dealQty),
    dealPrice: Number(p?.dealPrice ?? base.dealPrice),
    freeQty: Number(p?.freeQty ?? base.freeQty)
  };
}

let rawState = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
if(!rawState){
  const old = JSON.parse(localStorage.getItem('saleslog_v2') || 'null');
  rawState = old || {products: defaultProducts, sales: []};
}
let state = {
  products: (rawState.products || defaultProducts).map((p,i)=>normalizeProduct(p,i)),
  sales: rawState.sales || []
};
let cart = {};
let supabaseClient = null;
let session = null;
let cloudMode = false;
let realtimeChannel = null;
let syncing = false;

const money = n => new Intl.NumberFormat('en-BE', {style:'currency', currency:'EUR'}).format(Number(n || 0));
const qtyFmt = n => Number(n || 0).toLocaleString(undefined,{maximumFractionDigits:3});
const $ = s => document.querySelector(s);

function saveLocal(){ localStorage.setItem(LOCAL_KEY, JSON.stringify(state)); }
function toast(text){ const el=$('#toast'); el.textContent=text; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'), 2200); }
function esc(s=''){ return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function attr(s=''){ return esc(s); }
function cleanFloat(n){ return Math.round(Number(n || 0) * 1000) / 1000; }

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

const largeVariants = {
  standard: p => ({label:`Standard ${qtyFmt(p.standardAmount)}`, short:`${qtyFmt(p.standardAmount)} portion`, price:p.price, stockPer: p.standardAmount, deliveredPer:1}),
  full: p => ({label:'Full 1.0', short:'Full product', price:p.fullPrice, stockPer:1, deliveredPer:1}),
  '3plus1': p => ({label:'3 + 1 deal', short:'3+1 deal', price:p.price*3, stockPer:p.standardAmount*4, deliveredPer:4}),
  '2plus1': p => ({label:'2 + 1 deal', short:'2+1 deal', price:p.price*2, stockPer:p.standardAmount*3, deliveredPer:3})
};

function cartKey(productId, variant='unit'){ return `${productId}:${variant}`; }
function parseCartKey(key){ const [id,variant]=key.split(':'); return {id:Number(id),variant}; }

function cartStockForProduct(productId){
  return Object.entries(cart).reduce((sum,[key,q])=>{
    const {id,variant}=parseCartKey(key);
    if(id!==productId) return sum;
    const p=state.products.find(x=>x.id===id);
    if(!p) return sum;
    if(p.productType==='fractional_large') return sum + largeVariants[variant](p).stockPer*q;
    return sum;
  },0);
}

function renderLargeProduct(p){
  const remaining = Math.max(0,p.stock-cartStockForProduct(p.id));
  const buttons = [
    ['standard', `${qtyFmt(p.standardAmount)} for ${money(p.price)}`, `${qtyFmt(p.standardAmount)} stock`],
    ['full', `Full for ${money(p.fullPrice)}`, '1.0 stock'],
    ['3plus1', `3 + 1 · ${money(p.price*3)}`, `${qtyFmt(p.standardAmount*4)} stock used`],
    ['2plus1', `2 + 1 · ${money(p.price*2)}`, `${qtyFmt(p.standardAmount*3)} stock used · rare`]
  ];
  return `<div class="product large-product-card">
    <div class="product-top"><div><b>${esc(p.name)}</b><small>Fractional inventory</small></div><span class="stock-pill">${qtyFmt(remaining)} in stock</span></div>
    <div class="variant-grid">${buttons.map(([variant,title,sub])=>`<button class="variant-btn" onclick="addLargeVariant(${p.id},'${variant}')"><strong>${title}</strong><small>${sub}</small></button>`).join('')}</div>
  </div>`;
}

function renderProducts(){
  $('#productGrid').innerHTML = state.products.map(p=>{
    if(p.productType==='fractional_large') return renderLargeProduct(p);
    return `<button class="product" onclick="addProduct(${p.id})"><b>${esc(p.name)}</b><small>${money(p.price)} each</small>${dealText(p)?`<span class="deal">${dealText(p)}</span>`:''}</button>`;
  }).join('');
  renderCart();
}

window.addLargeVariant = (id,variant) => {
  const p=state.products.find(x=>x.id===id);
  const v=largeVariants[variant]?.(p);
  if(!p||!v) return;
  const key=cartKey(id,variant);
  const prospective=cartStockForProduct(id)+v.stockPer;
  if(prospective > p.stock + 0.0001) return toast(`Not enough stock. ${qtyFmt(p.stock)} available.`);
  cart[key]=(cart[key]||0)+1;
  renderProducts();
};
window.addProduct = id => { const key=cartKey(id,'unit'); cart[key]=(cart[key]||0)+1; renderCart(); };
window.changeQty = (key,d) => {
  const {id,variant}=parseCartKey(key);
  const p=state.products.find(x=>x.id===id);
  if(d>0 && p?.productType==='fractional_large'){
    const v=largeVariants[variant](p);
    if(cartStockForProduct(id)+v.stockPer > p.stock+0.0001) return toast('Not enough stock');
  }
  cart[key]=Math.max(0,(cart[key]||0)+d);
  if(!cart[key]) delete cart[key];
  renderProducts();
};

function cartEntries(){
  return Object.entries(cart).map(([key,q])=>{
    const {id,variant}=parseCartKey(key);
    const p=state.products.find(x=>x.id===id);
    if(!p || !q) return null;
    if(p.productType==='fractional_large'){
      const v=largeVariants[variant](p);
      return {
        key,p,variant,qty:q,label:v.label,
        total:v.price*q,
        unitPrice:v.price,
        stockUsed:cleanFloat(v.stockPer*q),
        deliveredQty:v.deliveredPer*q
      };
    }
    return {key,p,variant:'unit',qty:q,label:p.name,total:linePrice(p,q),unitPrice:p.price,stockUsed:0,deliveredQty:q};
  }).filter(Boolean);
}

function renderCart(){
  const items=cartEntries();
  const total=items.reduce((s,i)=>s+i.total,0);
  $('#cart').innerHTML = items.length ? items.map(i=>{
    const meta = i.p.productType==='fractional_large'
      ? `${i.qty}× ${esc(i.label)} · ${money(i.total)} · uses ${qtyFmt(i.stockUsed)} stock`
      : `${i.qty} unit${i.qty>1?'s':''} · ${money(i.total)}`;
    return `<div class="cart-item"><div><b>${esc(i.p.name)}${i.p.productType==='fractional_large'?` · ${esc(i.label)}`:''}</b><div class="history-meta">${meta}</div></div><div class="qty"><button onclick="changeQty('${i.key}',-1)">−</button><b>${i.qty}</b><button onclick="changeQty('${i.key}',1)">+</button></div><strong>${money(i.total)}</strong></div>`;
  }).join('') : `<p class="muted">Tap a product option to add it.</p>`;
  $('#cartTotal').textContent=money(total);
}

async function recordSale(){
  const entries=cartEntries();
  if(!entries.length) return toast('Add a product first');
  for(const i of entries){
    if(i.stockUsed>0 && i.stockUsed > i.p.stock+0.0001) return toast(`Not enough ${i.p.name} stock`);
  }
  const items=entries.map(i=>({
    id:i.p.id,
    name:i.p.name,
    variant:i.variant,
    variantLabel:i.label,
    qty:i.qty,
    deliveredQty:i.deliveredQty,
    unitPrice:i.unitPrice,
    total:i.total,
    stockUsed:i.stockUsed
  }));
  const sale={
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    date: new Date().toISOString(),
    items,
    total: items.reduce((a,b)=>a+b.total,0),
    note: $('#saleNote').value.trim()
  };

  if(cloudMode){
    const {error}=await supabaseClient.rpc('record_sale_with_stock',{
      p_sale_id:sale.id,
      p_sold_at:sale.date,
      p_total:sale.total,
      p_note:sale.note,
      p_items:sale.items
    });
    if(error){ console.error(error); return toast(error.message?.includes('Insufficient stock') ? 'Not enough stock' : 'Cloud sale failed — nothing was recorded'); }
    cart={}; $('#saleNote').value=''; await loadCloud(); toast('Sale recorded'); return;
  }

  entries.forEach(i=>{ if(i.stockUsed>0) i.p.stock=cleanFloat(i.p.stock-i.stockUsed); });
  state.sales.unshift(sale); cart={}; $('#saleNote').value=''; saveLocal(); renderAll(); toast('Sale recorded');
}

function itemHistoryText(i){
  if(i.variantLabel) return `${i.qty}× ${esc(i.name)} · ${esc(i.variantLabel)}${Number(i.stockUsed)>0?` · −${qtyFmt(i.stockUsed)} stock`:''}`;
  return `${i.qty}× ${esc(i.name)}`;
}

function renderHistory(){
  $('#historyList').innerHTML = state.sales.length ? state.sales.map(s=>`<div class="history-item"><div class="history-head"><b>${money(s.total)}</b><span>${new Date(s.date).toLocaleString()}</span></div><div>${s.items.map(itemHistoryText).join('<br>')}</div>${s.note?`<div class="history-meta">${esc(s.note)}</div>`:''}<button class="ghost delete-sale" onclick="deleteSale('${s.id}')">Delete & restore stock</button></div>`).join('') : `<p class="muted">No sales yet.</p>`;
}

window.deleteSale = async id => {
  if(!confirm('Delete this sale and restore any inventory it used?')) return;
  if(cloudMode){
    const {error}=await supabaseClient.rpc('delete_sale_restore_stock',{p_sale_id:id});
    if(error){ console.error(error); return toast('Could not delete sale'); }
    await loadCloud(); toast('Sale deleted; stock restored'); return;
  }
  const sale=state.sales.find(s=>s.id===id);
  if(sale){
    sale.items.forEach(i=>{
      const p=state.products.find(x=>Number(x.id)===Number(i.id));
      if(p && Number(i.stockUsed)>0) p.stock=cleanFloat(p.stock+Number(i.stockUsed));
    });
  }
  state.sales=state.sales.filter(s=>s.id!==id); saveLocal(); renderAll(); toast('Sale deleted; stock restored');
};

function renderStats(){
  const now=new Date();
  const today=state.sales.filter(s=>new Date(s.date).toDateString()===now.toDateString());
  const sum=a=>a.reduce((x,s)=>x+Number(s.total||0),0);
  $('#todayRevenue').textContent=money(sum(today));
  $('#allRevenue').textContent=money(sum(state.sales));
  $('#saleCount').textContent=state.sales.length;
  const delivered=state.sales.reduce((a,s)=>a+s.items.reduce((x,i)=>x+Number(i.deliveredQty ?? i.qty ?? 0),0),0);
  $('#unitCount').textContent=qtyFmt(delivered);
  $('#productStats').innerHTML=state.products.map(p=>{
    let q=0,r=0,stockUsed=0;
    state.sales.forEach(s=>s.items.filter(i=>Number(i.id)===Number(p.id)).forEach(i=>{q+=Number(i.deliveredQty ?? i.qty ?? 0);r+=Number(i.total||0);stockUsed+=Number(i.stockUsed||0);}));
    const extra=p.productType==='fractional_large'?` · ${qtyFmt(stockUsed)} stock used · ${qtyFmt(p.stock)} left`:'';
    return `<div class="row stat-row"><span>${esc(p.name)}<small class="muted stat-small">${qtyFmt(q)} delivered${extra}</small></span><b>${money(r)}</b></div>`;
  }).join('');
}

function renderSettings(){
  $('#settingsProducts').innerHTML=state.products.map((p,idx)=>{
    if(p.productType==='fractional_large'){
      return `<div class="setting-product special-setting" data-i="${idx}"><div class="setting-title"><b>Product 1 · Fractional large product</b><span class="stock-pill">${qtyFmt(p.stock)} stock</span></div>
        <div class="setting-grid"><label>Name<input data-k="name" value="${attr(p.name)}"></label><label>Current stock (whole products)<input data-k="stock" type="number" min="0" step=".1" value="${p.stock}"></label></div>
        <div class="setting-grid"><label>Standard amount sold<input data-k="standardAmount" type="number" min="0.01" step=".1" value="${p.standardAmount}"></label><label>Standard price<input data-k="price" type="number" min="0" step=".01" value="${p.price}"></label><label>Full-product price<input data-k="fullPrice" type="number" min="0" step=".01" value="${p.fullPrice}"></label></div>
        <div class="deal-summary"><b>Built-in deal buttons</b><span>3 + 1 = ${money(p.price*3)} · stock ${qtyFmt(p.standardAmount*4)}</span><span>2 + 1 = ${money(p.price*2)} · stock ${qtyFmt(p.standardAmount*3)}</span></div>
      </div>`;
    }
    return `<div class="setting-product" data-i="${idx}"><b>Product ${idx+1}</b><div class="setting-grid"><label>Name<input data-k="name" value="${attr(p.name)}"></label><label>Unit price<input data-k="price" type="number" min="0" step=".01" value="${p.price}"></label></div><label>Deal<select data-k="dealType"><option value="none" ${p.dealType==='none'?'selected':''}>No deal</option><option value="bundle" ${p.dealType==='bundle'?'selected':''}>Fixed bundle price</option><option value="free" ${p.dealType==='free'?'selected':''}>Buy X get Y free</option></select></label><div class="setting-grid"><label>Deal / buy quantity<input data-k="dealQty" type="number" min="0" value="${p.dealQty||0}"></label><label>Bundle price<input data-k="dealPrice" type="number" min="0" step=".01" value="${p.dealPrice||0}"></label><label>Free quantity<input data-k="freeQty" type="number" min="0" value="${p.freeQty||0}"></label></div></div>`;
  }).join('');
}

async function saveSettings(){
  document.querySelectorAll('.setting-product').forEach(box=>{
    const p=state.products[+box.dataset.i];
    box.querySelectorAll('[data-k]').forEach(inp=>{
      const k=inp.dataset.k;
      p[k]=['price','stock','standardAmount','fullPrice','dealQty','dealPrice','freeQty'].includes(k)?Number(inp.value):inp.value;
    });
  });
  saveLocal(); renderAll();
  if(cloudMode){
    const rows=productRowsForCloud();
    const {error}=await supabaseClient.from('products').upsert(rows,{onConflict:'user_id,slot'});
    if(error) return toast('Saved locally — cloud sync failed');
  }
  toast('Settings saved');
}

function exportCsv(){
  const rows=[['Date','Total','Items','Stock used','Note'],...state.sales.map(s=>[new Date(s.date).toLocaleString(),s.total,s.items.map(i=>`${i.qty}x ${i.name}${i.variantLabel?` (${i.variantLabel})`:''}`).join('; '),s.items.reduce((a,i)=>a+Number(i.stockUsed||0),0),s.note||''])];
  download('sales.csv',rows.map(r=>r.map(v=>`"${String(v).replaceAll('"','""')}"`).join(',')).join('\n'),'text/csv');
}
function download(name,text,type){ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text],{type})); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),500); }

function mapCloudProduct(p,idx){
  return normalizeProduct({
    id:idx+1,
    name:p.name,
    price:Number(p.price),
    productType:p.product_type || (idx===0?'fractional_large':'standard'),
    stock:Number(p.stock ?? (idx===0?50:0)),
    standardAmount:Number(p.standard_amount ?? (idx===0?0.7:1)),
    fullPrice:Number(p.full_price ?? (idx===0?60:0)),
    dealType:p.deal_type,
    dealQty:Number(p.deal_qty),
    dealPrice:Number(p.deal_price),
    freeQty:Number(p.free_qty)
  },idx);
}

function productRowsForCloud(){
  return state.products.map((p,idx)=>({
    user_id:session.user.id,
    slot:idx+1,
    name:p.name,
    price:p.price,
    product_type:p.productType || 'standard',
    stock:p.stock || 0,
    standard_amount:p.standardAmount || 1,
    full_price:p.fullPrice || 0,
    deal_type:p.dealType,
    deal_qty:p.dealQty,
    deal_price:p.dealPrice,
    free_qty:p.freeQty
  }));
}

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
      const bySlot=new Map(products.map(p=>[Number(p.slot),p]));
      state.products=defaultProducts.map((d,idx)=>bySlot.has(idx+1)?mapCloudProduct(bySlot.get(idx+1),idx):normalizeProduct(d,idx));
      if(products.length<5) await pushProducts();
    } else {
      state.products=defaultProducts.map((p,i)=>normalizeProduct(p,i));
      await pushProducts();
    }
    state.sales=(sales||[]).map(s=>({id:s.id,date:s.sold_at,items:s.items,total:Number(s.total),note:s.note||''}));
    saveLocal(); renderAll(); setSyncBadge('Synced','ok');
  } catch(e){ console.error(e); setSyncBadge('Sync issue','error'); toast('Cloud sync failed'); }
  finally{ syncing=false; }
}

async function pushProducts(){
  const rows=productRowsForCloud();
  const {error}=await supabaseClient.from('products').upsert(rows,{onConflict:'user_id,slot'}); if(error) throw error;
}

async function pushLocalSalesIfCloudEmpty(){
  if(!cloudMode || !state.sales.length) return;
  const {count,error}=await supabaseClient.from('sales').select('*',{count:'exact',head:true});
  if(error || count>0) return;
  // Older local sales are preserved, but inventory is not retroactively changed here.
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
  $('#importJson').onchange=async e=>{try{const x=JSON.parse(await e.target.files[0].text());if(!x.products||!x.sales)throw 0;state={products:x.products.map((p,i)=>normalizeProduct(p,i)),sales:x.sales};saveLocal();renderAll();if(cloudMode){await pushProducts(); await pushLocalSalesIfCloudEmpty(); await loadCloud();}toast('Backup imported')}catch{toast('Invalid backup')}};
  $('#clearData').onclick=async()=>{if(!confirm('Delete all recorded sales? This does not automatically rebuild stock.'))return;state.sales=[];saveLocal();renderAll();if(cloudMode)await supabaseClient.from('sales').delete().eq('user_id',session.user.id);toast('Sales deleted')};
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
