const LOCAL_KEY = 'saleslog_v5_0';
const defaultProducts = [
  {
    id: 1, name: 'Large product', price: 50, productType: 'fractional_large',
    stock: 50, standardAmount: 0.7, fullPrice: 60,
    dealType: 'none', dealQty: 0, dealPrice: 0, freeQty: 0
  },
  {
    id: 2, name: 'Ketnet', price: 15, productType: 'standard',
    stock: 0, standardAmount: 1, fullPrice: 0,
    dealType: 'none', dealQty: 0, dealPrice: 0, freeQty: 0
  },
  {
    id: 3, name: '3Motion', price: 15, productType: 'standard',
    stock: 0, standardAmount: 1, fullPrice: 0,
    dealType: 'none', dealQty: 0, dealPrice: 0, freeQty: 0
  },
  {
    id: 4, name: 'NEP', price: 15, productType: 'standard',
    stock: 0, standardAmount: 1, fullPrice: 0,
    dealType: 'none', dealQty: 0, dealPrice: 0, freeQty: 0
  },
  {
    id: 5, name: 'Median', price: 35, productType: 'standard',
    stock: 0, standardAmount: 1, fullPrice: 0,
    dealType: 'none', dealQty: 0, dealPrice: 0, freeQty: 0
  }
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
let syncPromise = null;
let syncQueued = false;
let realtimeReloadTimer = null;

let currentRole = 'driver';
let adminDrivers = [];
let selectedDriverId = null;
let selectedDriverEmail = '';
let selectedDriverName = '';


function configuredAdminEmails(){
  const cfg = window.SALES_APP_CONFIG || {};
  return Array.isArray(cfg.adminEmails)
    ? cfg.adminEmails.map(e => String(e).trim().toLowerCase()).filter(Boolean)
    : [];
}

function resolveRole(){
  const email = String(session?.user?.email || '').trim().toLowerCase();
  currentRole = cloudMode && email && configuredAdminEmails().includes(email) ? 'admin' : 'driver';
  return currentRole;
}

function isAdmin(){
  return resolveRole() === 'admin';
}

function applyRoleUI(){
  const admin = isAdmin();
  const badge = $('#roleBadge');
  const nav = $('#adminNav');

  if(badge){
    badge.textContent = admin ? 'Admin' : 'Driver';
    badge.className = 'role-badge' + (admin ? ' admin' : '');
  }
  if(nav) nav.hidden = !admin;

  // The normal Settings product section remains read-only.
  if($('#saveSettings')) $('#saveSettings').hidden = true;

  // Never leave a driver on an admin screen.
  if(!admin && $('#admin')?.classList.contains('active')){
    document.querySelectorAll('nav button,.tab').forEach(x => x.classList.remove('active'));
    document.querySelector('[data-tab="sale"]')?.classList.add('active');
    $('#sale')?.classList.add('active');
  }
}

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

function paidUnitsFor(p,q){
  if(p.dealType==='free' && p.dealQty>0 && p.freeQty>0){
    const group=p.dealQty+p.freeQty;
    return Math.floor(q/group)*p.dealQty + Math.min(q%group,p.dealQty);
  }
  return q;
}

const largeVariants = {
  standard: p => ({label:`Standard ${qtyFmt(p.standardAmount)}`, short:`${qtyFmt(p.standardAmount)} portion`, price:p.price, stockPer: p.standardAmount, deliveredPer:1, paidPortions:1}),
  full: p => ({label:'Full 1.0', short:'Full product', price:p.fullPrice, stockPer:1, deliveredPer:1, paidPortions:1}),
  '3plus1': p => ({label:'3 + 1 deal', short:'3+1 deal', price:p.price*3, stockPer:p.standardAmount*4, deliveredPer:4, paidPortions:3}),
  '2plus1': p => ({label:'2 + 1 deal', short:'2+1 deal', price:p.price*2, stockPer:p.standardAmount*3, deliveredPer:3, paidPortions:2}),
  free: p => ({label:`Free ${qtyFmt(p.standardAmount)}`, short:'Free', price:0, stockPer:p.standardAmount, deliveredPer:1, paidPortions:0})
};

function cartKey(productId, variant='unit'){ return `${productId}:${variant}`; }
function parseCartKey(key){ const [id,variant]=key.split(':'); return {id:Number(id),variant}; }

function cartStockForProduct(productId){
  return Object.entries(cart).reduce((sum,[key,value])=>{
    const {id,variant}=parseCartKey(key);
    if(id!==productId) return sum;
    const p=state.products.find(x=>x.id===id);
    if(!p) return sum;
    if(value && typeof value==='object' && value.manual) return sum + Number(value.stockUsed||0);
    if(p.productType==='fractional_large' && largeVariants[variant]) return sum + largeVariants[variant](p).stockPer*Number(value||0);
    return sum + Number(value||0);
  },0);
}

function renderLargeProduct(p){
  const remaining = Math.max(0,p.stock-cartStockForProduct(p.id));
  const buttons = [
    ['standard', `${qtyFmt(p.standardAmount)} for ${money(p.price)}`, `${qtyFmt(p.standardAmount)} stock · driver +€10`],
    ['full', `Full for ${money(p.fullPrice)}`, '1.0 stock · driver +€10'],
    ['3plus1', `3 + 1 · ${money(p.price*3)}`, `${qtyFmt(p.standardAmount*4)} stock · driver +€30`],
    ['2plus1', `2 + 1 · ${money(p.price*2)}`, `${qtyFmt(p.standardAmount*3)} stock · driver +€20 · rare`],
    ['free', `Free ${qtyFmt(p.standardAmount)}`, `${qtyFmt(p.standardAmount)} stock · no commission`]
  ];
  return `<div class="product large-product-card">
    <div class="product-top"><div><b>${esc(p.name)}</b><small>Fractional inventory</small></div><span class="stock-pill">${qtyFmt(remaining)} in stock</span></div>
    <div class="variant-grid">${buttons.map(([variant,title,sub])=>`<button class="variant-btn ${variant==='free'?'free-variant':''}" onclick="addLargeVariant(${p.id},'${variant}')"><strong>${title}</strong><small>${sub}</small></button>`).join('')}</div>
  </div>`;
}

function renderProducts(){
  $('#productGrid').innerHTML = state.products.map(p=>{
    if(p.productType==='fractional_large') return renderLargeProduct(p);
    const remaining=Math.max(0,Number(p.stock||0)-cartStockForProduct(p.id));
    return `<button class="product" onclick="addProduct(${p.id})"><b>${esc(p.name)}</b><small>${money(p.price)} each · ${qtyFmt(remaining)} in stock</small>${dealText(p)?`<span class="deal">${dealText(p)}</span>`:''}</button>`;
  }).join('') + renderUnifiedMisc();
  renderCart();
}

function renderUnifiedMisc(){
  const opts=state.products.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
  return `<details class="misc-sale unified-misc">
    <summary>Misc sale</summary>
    <div class="misc-grid">
      <label>Product<select id="miscProduct" onchange="updateMiscHelp()">${opts}</select></label>
      <label>Sale price €<input id="miscPrice" type="number" min="0" step=".01" placeholder="50"></label>
      <label>Stock used / units delivered<input id="miscStock" type="number" min="0.001" step=".1" value="0.7"></label>
      <label id="miscPaidWrap">Paid portions (Large only)<input id="miscPaid" type="number" min="0" step="1" value="1"></label>
    </div>
    <button class="ghost wide" type="button" onclick="addMiscSale()">Add misc sale</button>
    <small class="muted" id="miscHelp">Large: commission is based on paid portions. Other products calculate commission automatically.</small>
  </details>`;
}

window.updateMiscHelp = () => {
  const id=Number($('#miscProduct')?.value||1);
  const p=state.products.find(x=>x.id===id);
  if(!p) return;
  const large=p.productType==='fractional_large';
  if($('#miscPaidWrap')) $('#miscPaidWrap').style.display=large?'':'none';
  if($('#miscStock') && document.activeElement!==$('#miscStock')) $('#miscStock').value=large?p.standardAmount:1;
  const own=isOwnCustomer();
  let text='';
  if(id===1) text=`Large: ${own?'€15':'€10'} × paid portions.`;
  else if(id===2 || id===3) text=`${p.name}: ${own?'€15':'€10'} per €50 sold (calculated proportionally).`;
  else if(id===4) text=`NEP: ${own?'€15':'€12.50'} per €50 sold (calculated proportionally).`;
  else if(id===5) text=`Median: ${own?'€15':'€10'} per unit sold.`;
  if($('#miscHelp')) $('#miscHelp').textContent=text;
};

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
window.addMiscSale = () => {
  const id=Number($('#miscProduct')?.value);
  const p=state.products.find(x=>x.id===id);
  if(!p) return;
  const price=Number($('#miscPrice')?.value);
  const stockUsed=Number($('#miscStock')?.value);
  const paidPortions=Math.max(0,Math.floor(Number($('#miscPaid')?.value)||0));
  if(!Number.isFinite(price) || price<0) return toast('Enter a valid misc sale price');
  if(!Number.isFinite(stockUsed) || stockUsed<=0) return toast('Enter stock used');
  if(cartStockForProduct(id)+stockUsed > Number(p.stock||0)+0.0001) return toast(`Not enough ${p.name} stock`);
  const key=`${id}:misc:${Date.now()}`;
  cart[key]={qty:1,manual:true,price,stockUsed,paidPortions,label:'Misc sale'};
  renderProducts();
};

window.addProduct = id => {
  const p=state.products.find(x=>x.id===id);
  if(!p) return;
  if(cartStockForProduct(id)+1 > Number(p.stock||0)+0.0001) return toast(`Not enough ${p.name} stock`);
  const key=cartKey(id,'unit'); cart[key]=(cart[key]||0)+1; renderProducts();
};
window.changeQty = (key,d) => {
  if(cart[key] && typeof cart[key]==='object'){ if(d<0) delete cart[key]; renderProducts(); return; }
  const {id,variant}=parseCartKey(key);
  const p=state.products.find(x=>x.id===id);
  if(d>0 && p){
    const addStock=p.productType==='fractional_large' ? largeVariants[variant](p).stockPer : 1;
    if(cartStockForProduct(id)+addStock > Number(p.stock||0)+0.0001) return toast(`Not enough ${p.name} stock`);
  }
  cart[key]=Math.max(0,(cart[key]||0)+d);
  if(!cart[key]) delete cart[key];
  renderProducts();
};

function isOwnCustomer(){ return !!$('#ownCustomer')?.checked; }
function currentCommissionRate(){ return isOwnCustomer() ? 15 : 10; }

function commissionFor(p, revenue, units=1, paidPortions=1){
  const own=isOwnCustomer();
  if(Number(p.id)===1) return Number(paidPortions||0) * (own?15:10);
  if(Number(p.id)===2 || Number(p.id)===3) return Number(revenue||0) * (own?15:10) / 50;
  if(Number(p.id)===4) return Number(revenue||0) * (own?15:12.5) / 50;
  if(Number(p.id)===5) return Number(units||0) * (own?15:10);
  return 0;
}

function commissionLabelFor(p){
  const own=isOwnCustomer();
  if(Number(p.id)===1) return `${money(own?15:10)} per paid portion`;
  if(Number(p.id)===2 || Number(p.id)===3) return `${money(own?15:10)} per €50 sold`;
  if(Number(p.id)===4) return `${money(own?15:12.5)} per €50 sold`;
  if(Number(p.id)===5) return `${money(own?15:10)} per unit`;
  return '';
}

function cartEntries(){
  return Object.entries(cart).map(([key,value])=>{
    const parts=key.split(':');
    const id=Number(parts[0]);
    const variant=parts[1] || 'unit';
    const p=state.products.find(x=>x.id===id);
    if(!p || !value) return null;
    if(value && typeof value==='object' && value.manual){
      const delivered=p.productType==='fractional_large' ? 1 : Number(value.stockUsed||0);
      const paid=Number(value.paidPortions||0);
      return {key,p,variant:'misc',qty:1,label:value.label||'Misc sale',total:Number(value.price),unitPrice:Number(value.price),stockUsed:cleanFloat(value.stockUsed),deliveredQty:delivered,paidPortions:paid,commission:commissionFor(p,Number(value.price),delivered,paid),commissionRate:null,manual:true};
    }
    const q=Number(value);
    if(p.productType==='fractional_large'){
      const v=largeVariants[variant](p);
      return {
        key,p,variant,qty:q,label:v.label,
        total:v.price*q,
        unitPrice:v.price,
        stockUsed:cleanFloat(v.stockPer*q),
        deliveredQty:v.deliveredPer*q,
        paidPortions:(v.paidPortions ?? v.deliveredPer)*q,
        commission:(v.paidPortions ?? v.deliveredPer)*q*currentCommissionRate(),commissionRate:currentCommissionRate()
      };
    }
    const paid=paidUnitsFor(p,q);
    const total=linePrice(p,q);
    return {key,p,variant:'unit',qty:q,label:p.name,total,unitPrice:p.price,stockUsed:q,deliveredQty:q,paidPortions:paid,commission:commissionFor(p,total,q,paid),commissionRate:null};
  }).filter(Boolean);
}

function renderCart(){
  const items=cartEntries();
  const total=items.reduce((s,i)=>s+i.total,0);
  $('#cart').innerHTML = items.length ? items.map(i=>{
    const meta = i.p.productType==='fractional_large'
      ? `${i.qty}× ${esc(i.label)} · ${money(i.total)} · uses ${qtyFmt(i.stockUsed)} stock · driver ${money(i.commission)}`
      : `${i.qty} unit${i.qty>1?'s':''} · ${money(i.total)} · uses ${qtyFmt(i.stockUsed)} stock · driver ${money(i.commission)}`;
    const controls=i.manual?`<div class="qty"><button onclick="changeQty('${i.key}',-1)">Remove</button></div>`:`<div class="qty"><button onclick="changeQty('${i.key}',-1)">−</button><b>${i.qty}</b><button onclick="changeQty('${i.key}',1)">+</button></div>`;
    return `<div class="cart-item"><div><b>${esc(i.p.name)}${i.p.productType==='fractional_large'?` · ${esc(i.label)}`:''}</b><div class="history-meta">${meta}</div></div>${controls}<strong>${money(i.total)}</strong></div>`;
  }).join('') : `<p class="muted">Tap a product option to add it.</p>`;
  $('#cartTotal').textContent=money(total);
}

async function recordSale(){
  if(isAdmin()) return toast('Admin accounts manage drivers; sign in as a driver to record a sale');
  const entries=cartEntries();
  if(!entries.length) return toast('Add a product first');
  for(const i of entries){
    if(i.stockUsed>0 && i.stockUsed > i.p.stock+0.0001) return toast(`Not enough ${i.p.name} stock`);
  }
  const supplementAmount = Number($('#supplementAmount')?.value || 0);
  const supplementNote = $('#supplementNote')?.value.trim() || '';
  if(!Number.isFinite(supplementAmount) || supplementAmount < 0) return toast('Enter a valid supplement amount');
  if(supplementAmount > 0 && !supplementNote) return toast('Supplement reason is required');

  const items=entries.map(i=>({
    id:i.p.id,
    name:i.p.name,
    variant:i.variant,
    variantLabel:i.label,
    qty:i.qty,
    deliveredQty:i.deliveredQty,
    unitPrice:i.unitPrice,
    total:i.total,
    stockUsed:i.stockUsed,
    paidPortions:i.paidPortions ?? i.qty,
    commission:i.commission ?? 0,
    commissionRate:i.commissionRate ?? null,
    customerSource: isOwnCustomer() ? 'driver_own' : 'company'
  }));
  if(items.length){
    items[0].supplementAmount = supplementAmount;
    items[0].supplementNote = supplementNote;
  }
  const sale={
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    date: new Date().toISOString(),
    items,
    total: items.reduce((a,b)=>a+b.total,0),
    note: $('#saleNote').value.trim(),
    customerSource: isOwnCustomer() ? 'driver_own' : 'company',
    supplementAmount,
    supplementNote,
    supplementStatus: supplementAmount > 0 ? 'pending' : 'none'
  };

  if(cloudMode){
    const {error}=await supabaseClient.rpc('record_sale_with_stock',{
      p_sale_id:sale.id,
      p_sold_at:sale.date,
      p_total:sale.total,
      p_note:sale.note,
      p_items:sale.items,
      p_supplement_amount:sale.supplementAmount,
      p_supplement_note:sale.supplementNote
    });
    if(error){ console.error(error); return toast(error.message?.includes('Insufficient stock') ? 'Not enough stock' : 'Cloud sale failed — nothing was recorded'); }
    cart={};
    $('#saleNote').value='';
    if($('#supplementAmount')) $('#supplementAmount').value='';
    if($('#supplementNote')) $('#supplementNote').value='';
    if($('#ownCustomer')) $('#ownCustomer').checked=false;
    // Wait for any in-flight refresh, then force one more pass if realtime fired mid-sale.
    syncQueued=true;
    await loadCloud();
    const recorded=state.sales.some(s=>s.id===sale.id);
    if(!recorded){
      await loadCloud({queueIfBusy:false});
    }
    if(state.sales.some(s=>s.id===sale.id)) toast('Sale recorded');
    else toast('Sale saved in cloud, but History has not refreshed yet');
    return;
  }

  entries.forEach(i=>{ if(i.stockUsed>0) i.p.stock=cleanFloat(i.p.stock-i.stockUsed); });
  state.sales.unshift(sale); cart={}; $('#saleNote').value='';
    if($('#supplementAmount')) $('#supplementAmount').value='';
    if($('#supplementNote')) $('#supplementNote').value='';
    if($('#ownCustomer')) $('#ownCustomer').checked=false; saveLocal(); renderAll(); toast('Sale recorded');
}

function itemCommission(i){
  if(i.commission!==undefined && i.commission!==null) return Number(i.commission||0);
  if(i.paidPortions!==undefined && i.paidPortions!==null) return Number(i.paidPortions||0)*10;
  const q=Number(i.qty||1);
  if(i.variant==='3plus1') return q*30;
  if(i.variant==='2plus1') return q*20;
  if(i.variant==='free') return 0;
  if(i.variant==='standard' || i.variant==='full') return q*10;
  return q*10;
}
function requestedSupplement(s){
  if(s?.supplementAmount !== undefined) return Number(s.supplementAmount || 0);
  return Number((s?.items || [])[0]?.supplementAmount || 0);
}
function supplementStatus(s){
  return s?.supplementStatus || (requestedSupplement(s)>0 ? 'pending' : 'none');
}
function saleSupplement(s){
  return supplementStatus(s)==='approved' ? requestedSupplement(s) : 0;
}

function supplementReason(s){
  return s?.supplementNote || (s?.items || [])[0]?.supplementNote || '';
}
function baseSaleCommission(s){
  return (s.items||[]).reduce((a,i)=>a+itemCommission(i),0);
}
function saleCommission(s){
  return baseSaleCommission(s) + saleSupplement(s);
}
function itemHistoryText(i){
  const commission=itemCommission(i);
  if(i.variantLabel) return `${i.qty}× ${esc(i.name)} · ${esc(i.variantLabel)}${Number(i.stockUsed)>0?` · −${qtyFmt(i.stockUsed)} stock`:''} · driver ${money(commission)}`;
  return `${i.qty}× ${esc(i.name)} · driver ${money(commission)}`;
}

function renderHistory(){
  $('#historyList').innerHTML = state.sales.length ? state.sales.map(sale=>{
    const requested = requestedSupplement(sale);
    const status = supplementStatus(sale);
    const approvedSupplement = saleSupplement(sale);
    const baseCommission = baseSaleCommission(sale);
    const totalOwed = baseCommission + approvedSupplement;
    const statusText = status==='approved' ? 'Approved' : status==='declined' ? 'Declined' : 'Pending admin approval';
    return `<div class="history-item">
      <div class="history-head"><b>${money(sale.total)}</b><span>${new Date(sale.date).toLocaleString()}</span></div>
      <div>${sale.items.map(itemHistoryText).join('<br>')}</div>
      <div class="commission-line">Driver earned ${money(totalOwed)} · ${sale.customerSource==='driver_own'?'Driver own customer':'Regular customer'}</div>
      ${requested>0?`<div class="history-meta"><b>Extra pay request:</b> ${money(requested)} · ${esc(supplementReason(sale))} · <b>${statusText}</b></div>`:''}
      ${sale.note?`<div class="history-meta">${esc(sale.note)}</div>`:''}
    </div>`;
  }).join('') : `<p class="muted">No sales yet.</p>`;
}
function renderStats(){
  const now=new Date();
  const today=state.sales.filter(s=>new Date(s.date).toDateString()===now.toDateString());
  const sum=a=>a.reduce((x,s)=>x+Number(s.total||0),0);
  $('#todayRevenue').textContent=money(sum(today));
  $('#allRevenue').textContent=money(sum(state.sales));
  $('#saleCount').textContent=state.sales.length;
  const delivered=state.sales.reduce((a,s)=>a+s.items.reduce((x,i)=>x+Number(i.deliveredQty ?? i.qty ?? 0),0),0);
  $('#unitCount').textContent=qtyFmt(delivered);
  const driverTotal=state.sales.reduce((a,s)=>a+saleCommission(s),0);
  if($('#driverEarnings')) $('#driverEarnings').textContent=money(driverTotal);
  $('#productStats').innerHTML=state.products.map(p=>{
    let q=0,r=0,stockUsed=0,commission=0;
    state.sales.forEach(s=>s.items.filter(i=>Number(i.id)===Number(p.id)).forEach(i=>{q+=Number(i.deliveredQty ?? i.qty ?? 0);r+=Number(i.total||0);stockUsed+=Number(i.stockUsed||0);commission+=itemCommission(i);}));
    const extra=` · ${qtyFmt(stockUsed)} stock used · ${qtyFmt(p.stock)} left`;
    return `<div class="row stat-row"><span>${esc(p.name)}<small class="muted stat-small">${qtyFmt(q)} delivered${extra} · driver ${money(commission)}</small></span><b>${money(r)}</b></div>`;
  }).join('');
}

function renderSettings(){
  $('#settingsProducts').innerHTML=state.products.map((p,idx)=>{
    if(p.productType==='fractional_large'){
      return `<div class="setting-product special-setting" data-i="${idx}"><div class="setting-title"><b>Product 1 · Fractional large product</b><span class="stock-pill">${qtyFmt(p.stock)} stock</span></div>
        <div class="deal-summary"><span>Driver stock on hand: <b>${qtyFmt(p.stock)}</b></span><span>0.7 = ${money(p.price)} · full = ${money(p.fullPrice)}</span></div>
        <div class="deal-summary"><b>Built-in deal buttons</b><span>3 + 1 = ${money(p.price*3)} · stock ${qtyFmt(p.standardAmount*4)}</span><span>2 + 1 = ${money(p.price*2)} · stock ${qtyFmt(p.standardAmount*3)}</span><span>Free = ${qtyFmt(p.standardAmount)} stock · €0 driver commission</span><span>Misc = manual price / stock / paid portions</span></div>
      </div>`;
    }
    return `<div class="setting-product" data-i="${idx}"><div class="setting-title"><b>${esc(p.name)}</b><span class="stock-pill">${qtyFmt(p.stock)} stock</span></div><div class="deal-summary"><span>Driver stock on hand: <b>${qtyFmt(p.stock)}</b></span><span>Unit price: ${money(p.price)}</span></div><div class="deal-summary"><span>${idx===1||idx===2?`Commission: regular €10 / own €15 per €50 sold`:idx===3?`Commission: regular €12.50 / own €15 per €50 sold`:`Commission: regular €10 / own €15 per unit`}</span><span>Misc sales use the same commission rule automatically.</span></div></div>`;
  }).join('');
}

async function saveSettings(){
  toast('Product setup is locked for the driver');
}

function exportCsv(){
  const rows=[['Date','Total','Driver commission','Items','Stock used','Note'],...state.sales.map(s=>[new Date(s.date).toLocaleString(),s.total,saleCommission(s),s.items.map(i=>`${i.qty}x ${i.name}${i.variantLabel?` (${i.variantLabel})`:''}`).join('; '),s.items.reduce((a,i)=>a+Number(i.stockUsed||0),0),s.note||''])];
  download('sales.csv',rows.map(r=>r.map(v=>`"${String(v).replaceAll('"','""')}"`).join(',')).join('\n'),'text/csv');
}
function download(name,text,type){ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text],{type})); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),500); }

function mapCloudProduct(p,idx){
  const catalog=defaultProducts[idx];
  // Product identity and selling price come from the fixed catalog.
  // Only the stock quantity is carried over from Supabase because that is
  // the physical inventory currently in the driver's possession.
  return normalizeProduct({
    ...catalog,
    stock:Number(p?.stock ?? catalog.stock)
  },idx);
}

function productRowsForCloud(){
  return state.products.map((p,idx)=>({
    user_id:(isAdmin() && selectedDriverId ? selectedDriverId : session.user.id),
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

async function loadCloud({queueIfBusy=true}={}){
  if(!cloudMode) return;
  if(syncPromise){
    if(queueIfBusy) syncQueued=true;
    return syncPromise;
  }

  syncPromise=(async()=>{
    syncing=true;
    setSyncBadge('Syncing…','working');
    try{
      resolveRole();

      let products=[], sales=[];
      if(isAdmin()){
        if(!adminDrivers.length) await loadAdminDrivers();
        if(!selectedDriverId && adminDrivers.length){
          selectedDriverId = adminDrivers[0].user_id;
          selectedDriverEmail = adminDrivers[0].email || '';
          selectedDriverName = adminDrivers[0].display_name || '';
        }
        if(!selectedDriverId){
          state.products=defaultProducts.map((p,i)=>normalizeProduct({...p,stock:0},i));
          state.sales=[];
          renderAll();
          setSyncBadge('No drivers','ok');
          return;
        }

        const [{data:p,error:pe},{data:s,error:se}] = await Promise.all([
          supabaseClient.rpc('admin_get_driver_products',{p_driver_id:selectedDriverId}),
          supabaseClient.rpc('admin_get_driver_sales',{p_driver_id:selectedDriverId})
        ]);
        if(pe) throw pe;
        if(se) throw se;
        products=p||[];
        sales=s||[];
      }else{
        const [{data:p,error:pe},{data:s,error:se}] = await Promise.all([
          supabaseClient.from('products').select('*').order('slot'),
          supabaseClient.rpc('get_my_sales')
        ]);
        if(pe) throw pe;
        if(se) throw se;
        products=p||[];
        sales=s||[];
      }

      if(products.length){
        const bySlot=new Map(products.map(p=>[Number(p.slot),p]));
        state.products=defaultProducts.map((d,idx)=>bySlot.has(idx+1)?mapCloudProduct(bySlot.get(idx+1),idx):normalizeProduct({...d,stock:0},idx));
        if(!isAdmin()){
          const catalogStale = state.products.some((p,idx)=>{
            const d=defaultProducts[idx];
            const cloud=bySlot.get(idx+1);
            return !cloud || cloud.name!==d.name || Number(cloud.price)!==Number(d.price) ||
              (cloud.product_type||'standard')!==d.productType;
          });
          if(products.length<5 || catalogStale) await pushProducts();
        }
      }else{
        state.products=defaultProducts.map((p,i)=>normalizeProduct({...p,stock:0},i));
        if(!isAdmin()) await pushProducts();
      }

      state.sales=(sales||[]).map(s=>({
        id:s.id,
        date:s.sold_at,
        items:Array.isArray(s.items)?s.items:[],
        total:Number(s.total),
        note:s.note||'',
        customerSource:(Array.isArray(s.items) && s.items[0]?.customerSource) || 'company',
        supplementAmount:Number(s.supplement_amount ?? ((Array.isArray(s.items) && s.items[0]?.supplementAmount)||0)),
        supplementNote:s.supplement_note ?? ((Array.isArray(s.items) && s.items[0]?.supplementNote)||''),
        supplementStatus:s.supplement_status || (Number(s.supplement_amount||0)>0?'pending':'none'),
        supplementReviewedAt:s.supplement_reviewed_at || null
      }));

      saveLocal();
      renderAll();
      setSyncBadge(`Synced · ${state.sales.length}`,'ok');
    } catch(e){
      console.error('Cloud sync failed:',e);
      setSyncBadge('Sync issue','error');
      toast(`Cloud sync failed${e?.message?': '+e.message:''}`);
    } finally {
      syncing=false;
    }
  })();

  try { await syncPromise; }
  finally {
    syncPromise=null;
    if(syncQueued){
      syncQueued=false;
      return loadCloud({queueIfBusy:false});
    }
  }
}
function scheduleRealtimeReload(){
  if(realtimeReloadTimer) clearTimeout(realtimeReloadTimer);
  realtimeReloadTimer=setTimeout(()=>{
    realtimeReloadTimer=null;
    loadCloud();
  },180);
}

async function pushProducts(){
  if(isAdmin()) throw new Error('Admin stock changes must use admin_set_driver_stock');
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
  realtimeChannel=supabaseClient.channel(`saleslog-${session.user.id}`)
    .on('postgres_changes',{event:'*',schema:'public',table:'sales'},scheduleRealtimeReload)
    .on('postgres_changes',{event:'*',schema:'public',table:'products'},scheduleRealtimeReload)
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
  cloudMode=true; resolveRole(); showApp(); $('#accountStatus').textContent=session.user.email; setSyncBadge('Syncing…','working');
  if(!isAdmin()) await pushLocalSalesIfCloudEmpty(); await loadCloud(); setupRealtime();
}

function enterLocalMode(){ cloudMode=false; session=null; currentRole='driver'; showApp(); $('#accountStatus').textContent='Local mode'; setSyncBadge('Local'); }

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


async function loadAdminDrivers(){
  if(!cloudMode || !isAdmin()) return;
  const {data,error}=await supabaseClient.rpc('admin_list_drivers');
  if(error) throw error;
  adminDrivers=(data||[]).map(d=>({
    user_id:d.user_id,
    email:d.email||'',
    display_name:d.display_name||''
  }));
  if(selectedDriverId && !adminDrivers.some(d=>d.user_id===selectedDriverId)) selectedDriverId=null;
}

async function selectAdminDriver(driverId){
  selectedDriverId=driverId;
  const d=adminDrivers.find(x=>x.user_id===driverId);
  selectedDriverEmail=d?.email||'';
  selectedDriverName=d?.display_name||'';
  await loadCloud({queueIfBusy:false});
}

function renderAdmin(){
  if(!$('#adminStock')) return;
  if(!isAdmin()){
    $('#adminStock').innerHTML='';
    return;
  }

  const selector=$('#adminDriverSelect');
  if(selector){
    selector.innerHTML=adminDrivers.length
      ? adminDrivers.map(d=>`<option value="${attr(d.user_id)}" ${d.user_id===selectedDriverId?'selected':''}>${esc(d.display_name || d.email || d.user_id)}</option>`).join('')
      : '<option value="">No driver accounts yet</option>';
    selector.disabled=!adminDrivers.length;
  }
  if($('#adminDriverLabel')){
    $('#adminDriverLabel').textContent=selectedDriverId
      ? `Managing ${selectedDriverName || selectedDriverEmail || selectedDriverId}`
      : 'Create/sign in with a driver account first.';
  }

  const revenue=state.sales.reduce((a,x)=>a+Number(x.total||0),0);
  const owed=state.sales.reduce((a,x)=>a+saleCommission(x),0);
  const approved=state.sales.reduce((a,x)=>a+saleSupplement(x),0);
  const pending=state.sales.filter(x=>supplementStatus(x)==='pending').reduce((a,x)=>a+requestedSupplement(x),0);

  if($('#adminRevenue')) $('#adminRevenue').textContent=money(revenue);
  if($('#adminDriverOwed')) $('#adminDriverOwed').textContent=money(owed);
  if($('#adminSupplements')) $('#adminSupplements').textContent=money(approved);
  if($('#adminPendingSupplements')) $('#adminPendingSupplements').textContent=money(pending);
  if($('#adminSalesCount')) $('#adminSalesCount').textContent=state.sales.length;

  $('#adminStock').innerHTML = selectedDriverId ? state.products.map((p,index)=>`
    <div class="admin-stock-row">
      <div><b>${esc(p.name)}</b><small>Current stock assigned to this driver: ${qtyFmt(p.stock)}</small></div>
      <input class="admin-stock-input" data-index="${index}" type="number" min="0"
        step="${p.productType==='fractional_large'?'0.1':'1'}" value="${Number(p.stock||0)}">
    </div>
  `).join('') : '<p class="muted">Select a driver first.</p>';

  const requests=state.sales.filter(s=>requestedSupplement(s)>0);
  if($('#adminSupplementRequests')){
    $('#adminSupplementRequests').innerHTML=requests.length ? requests.map(s=>{
      const status=supplementStatus(s);
      return `<div class="approval-row">
        <div>
          <b>${money(requestedSupplement(s))}</b>
          <span class="status-pill ${status}">${status}</span>
          <small>${new Date(s.date).toLocaleString()} · ${esc(supplementReason(s))}</small>
          ${s.note?`<small>Sale note: ${esc(s.note)}</small>`:''}
        </div>
        ${status==='pending'?`<div class="approval-actions">
          <button class="approve-btn" onclick="reviewSupplement('${attr(s.id)}','approved')">Approve</button>
          <button class="decline-btn" onclick="reviewSupplement('${attr(s.id)}','declined')">Decline</button>
        </div>`:''}
      </div>`;
    }).join('') : '<p class="muted">No extra-pay requests for this driver.</p>';
  }
}

async function reviewSupplement(saleId,status){
  if(!isAdmin() || !selectedDriverId) return toast('Select a driver first');
  const {error}=await supabaseClient.rpc('admin_review_supplement',{
    p_driver_id:selectedDriverId,
    p_sale_id:saleId,
    p_status:status
  });
  if(error){ console.error(error); return toast('Could not update extra pay request'); }
  await loadCloud({queueIfBusy:false});
  toast(status==='approved'?'Extra pay approved':'Extra pay declined');
}
window.reviewSupplement=reviewSupplement;

async function adminSaveStock(){
  if(!isAdmin()) return toast('Admin access required');
  if(!selectedDriverId) return toast('Select a driver first');

  const reason=$('#stockReason')?.value.trim()||'';
  if(!reason) return toast('Stock adjustment reason is required');

  const quantities={};
  for(const input of document.querySelectorAll('.admin-stock-input')){
    const index=Number(input.dataset.index);
    const value=Number(input.value);
    if(!Number.isFinite(value)||value<0) return toast('Enter valid stock quantities');
    if(defaultProducts[index].productType!=='fractional_large'&&!Number.isInteger(value)){
      return toast(`${defaultProducts[index].name} stock must be a whole number`);
    }
    quantities[String(index+1)]=cleanFloat(value);
  }

  const {error}=await supabaseClient.rpc('admin_set_driver_stock',{
    p_driver_id:selectedDriverId,
    p_stock:quantities,
    p_reason:reason
  });
  if(error){ console.error(error); return toast('Stock update failed: '+(error.message||'')); }

  $('#stockReason').value='';
  await loadCloud({queueIfBusy:false});
  toast('Driver stock updated');
}
function renderAll(){ applyRoleUI(); renderProducts(); renderHistory(); renderStats(); renderSettings(); renderAdmin(); }

function wireUi(){
  document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{document.querySelectorAll('nav button,.tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');$('#'+b.dataset.tab).classList.add('active');});
  $('#recordSale').onclick=recordSale;
  $('#saveSettings').onclick=saveSettings;
  $('#exportCsv').onclick=exportCsv;
  if($('#adminSaveStock')) $('#adminSaveStock').onclick=adminSaveStock;
  if($('#adminDriverSelect')) $('#adminDriverSelect').onchange=e=>selectAdminDriver(e.target.value);
  if($('#adminExportCsv')) $('#adminExportCsv').onclick=exportCsv;
  if($('#adminExportJson')) $('#adminExportJson').onclick=()=>download('sales-backup.json',JSON.stringify(state,null,2),'application/json');
  $('#exportJson').onclick=()=>download('sales-backup.json',JSON.stringify(state,null,2),'application/json');
  $('#importJson').onchange=async e=>{try{const x=JSON.parse(await e.target.files[0].text());if(!x.products||!x.sales)throw 0;state={products:x.products.map((p,i)=>normalizeProduct(p,i)),sales:x.sales};saveLocal();renderAll();if(cloudMode){await pushProducts(); await pushLocalSalesIfCloudEmpty(); await loadCloud();}toast('Backup imported')}catch{toast('Invalid backup')}};
  $('#signInBtn').onclick=signIn; $('#signUpBtn').onclick=signUp; $('#localModeBtn').onclick=enterLocalMode; $('#signOutBtn').onclick=signOut; $('#syncNow').onclick=loadCloud;
  if($('#ownCustomer')) $('#ownCustomer').onchange=()=>{renderCart(); updateMiscHelp();};
  let deferred;
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferred=e;const b=$('#installBtn');b.hidden=false;b.onclick=async()=>{await deferred.prompt();deferred=null;b.hidden=true;}});
}

async function boot(){
  initSupabase(); wireUi();
  if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js?v=4.0', {updateViaCache:'none'});
  if(supabaseClient){
    const {data}=await supabaseClient.auth.getSession();
    if(data.session){ session=data.session; await enterCloudMode(); return; }
  }
  showAuth();
}

boot();