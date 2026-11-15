import {useCallback, useEffect, useRef, useState} from 'react';
import {ArrowLeft, ArrowRight, Bag, MagnifyingGlass, Plus} from '@phosphor-icons/react';
import {api, ApiError, Cart, checkoutStorage, money, Order, Product, session} from './api';
import {Basket, Checkout, Confirmation, Orders, ProductCard} from './components';

const emptyCart:Cart = {items:[],total_cents:0,currency:'GBP'};

export default function App() {
  const [route,setRoute] = useState(location.hash.startsWith('#/') ? location.hash.slice(1) : '/');
  const [products,setProducts] = useState<Product[]>([]);
  const [cart,setCart] = useState<Cart>(emptyCart);
  const [orders,setOrders] = useState<Order[]>([]);
  const [order,setOrder] = useState<Order>();
  const [lastRequest,setLastRequest] = useState('');
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<ApiError>();
  const [notice,setNotice] = useState('');
  const [category,setCategory] = useState('All goods');
  const [query,setQuery] = useState('');
  const mainRef = useRef<HTMLElement>(null);
  const actionLock = useRef(false);

  useEffect(()=>{const navigate=()=>{const path=location.hash.slice(1);if(path&&!path.startsWith('/')){document.getElementById(path)?.scrollIntoView();return;}setRoute(path||'/');setError(undefined);window.scrollTo(0,0);mainRef.current?.focus();};window.addEventListener('hashchange',navigate);return()=>window.removeEventListener('hashchange',navigate);},[]);
  const refresh = useCallback(async()=> {
    const [{data:catalog},{data:basket}] = await Promise.all([api<Product[]>('/products'),api<Cart>(`/carts/${session}`)]);
    setProducts(catalog);setCart(basket);
  },[]);
  const load = useCallback(async()=>{setLoading(true);setError(undefined);try{await refresh();}catch(e){setError(e as ApiError);}finally{setLoading(false);}},[refresh]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{if(route==='/orders'){setLoading(true);api<Order[]>(`/orders/${session}`).then(r=>setOrders(r.data)).catch(e=>setError(e)).finally(()=>setLoading(false));}},[route]);
  useEffect(()=>{if(notice){const timer=setTimeout(()=>setNotice(''),4000);return()=>clearTimeout(timer);}},[notice]);

  async function action(work:()=>Promise<void>) {
    if(actionLock.current)return;
    actionLock.current=true;setBusy(true);setError(undefined);
    try{await work();}catch(e){setError(e as ApiError);}finally{actionLock.current=false;setBusy(false);}
  }
  const add = (p:Product)=>void action(async()=>{await api(`/carts/${session}/items`,{method:'POST',body:JSON.stringify({product_id:p.id,quantity:1})});setCart((await api<Cart>(`/carts/${session}`)).data);setNotice(`${p.name} added to your basket`);});
  const update = (p:Product,n:number)=>void action(async()=>{await api(`/carts/${session}/items/${p.id}`,{method:'PUT',body:JSON.stringify({quantity:n})});setCart((await api<Cart>(`/carts/${session}`)).data);});
  const remove = (p:Product)=>void action(async()=>{await api(`/carts/${session}/items/${p.id}`,{method:'DELETE'});setCart((await api<Cart>(`/carts/${session}`)).data);});
  const place = ()=>void action(async()=>{
    const key = localStorage.getItem(checkoutStorage)||crypto.randomUUID();localStorage.setItem(checkoutStorage,key);
    const result = await api<Order>(`/checkout/${session}`,{method:'POST',headers:{'Idempotency-Key':key}});
    setOrder(result.data);setLastRequest(result.requestId);
    if(result.data.basket_cleared){localStorage.removeItem(checkoutStorage);setCart(emptyCart);}
    // Confirmation must survive a subsequent basket-refresh failure.
    location.hash='/confirmation';
  });
  const count=cart.items.reduce((sum,i)=>sum+i.quantity,0);
  const selectedId=route.startsWith('/product/')?route.split('/')[2]:null;
  const selected=products.find(p=>p.id===selectedId);
  const visible=products.filter(p=>(category==='All goods'||p.category===category)&&`${p.name} ${p.description}`.toLowerCase().includes(query.toLowerCase()));
  const featured=products.find(p=>p.name==='Everyday headphones');

  return <><a className="skip" href="#main">Skip to content</a><div className="announcement">A little shop. A lot working together. <span>Part of KubeVerse at DurHack 2026</span></div>
    <header className="site-header"><a href="#/" className="brand" aria-label="MiniShop home"><Bag size={30} weight="duotone"/>mini<span>shop</span><span className="brand-dot">.</span></a><nav aria-label="Main navigation"><a href="#/" aria-current={route==='/'?'page':undefined}>The collection</a><a href="#/orders" aria-current={route==='/orders'?'page':undefined}>Your orders</a></nav><a className="basket-link" href="#/basket" aria-label={`Basket, ${count} items`}><Bag size={22}/><span>Basket</span><b>{count}</b></a></header>
    <main id="main" ref={mainRef} tabIndex={-1} className="shell">
    {error&&<div className="error" role="alert"><strong>Something needs a moment.</strong><p>{error.message}</p><details><summary>Request reference</summary><code>{error.requestId}</code></details>{loading===false&&products.length===0&&<button onClick={()=>void load()} className="text-button">Try again</button>}</div>}
    {loading?<div aria-busy="true" aria-label="Loading the shop" className="skeleton-grid">{[1,2,3,4].map(i=><div className="skeleton" key={i}/>)}</div>:<>
    {route==='/'&&<><section className="hero"><div className="hero-copy"><p className="eyebrow">Made for the everyday</p><h1>Good things.<br/>Small pleasures.</h1><p>Thoughtful essentials for your desk, your home, and everywhere in between.</p><a className="primary" href="#collection">Find your everyday <ArrowRight size={18}/></a></div><a className="hero-image" href={featured?`#/product/${featured.id}`:'#collection'}><img src="/images/headphones.jpg" alt="Everyday wireless headphones" width="800" height="800"/>{featured&&<div className="hero-caption"><div><span>Meet your new daily companion</span><strong>{featured.name} · {money(featured.price_cents)}</strong></div><ArrowRight size={24}/></div>}</a></section>
    <section id="collection" aria-labelledby="collection-heading"><div className="collection-heading"><div><p className="muted text-sm">Thoughtfully picked. Simply useful.</p><h2 id="collection-heading">The collection<span> / {products.length}</span></h2></div><label className="search"><MagnifyingGlass size={18}/><input aria-label="Search products" type="search" placeholder="Find something good" value={query} onChange={e=>setQuery(e.target.value)}/></label></div><div className="filters" aria-label="Product categories">{['All goods','Home','Tech','Everyday'].map(c=><button key={c} className={category===c?'active':''} aria-pressed={category===c} onClick={()=>setCategory(c)}>{c}</button>)}</div><div className="product-grid">{visible.map(p=><ProductCard key={p.id} product={p} busy={busy} add={add}/>)}</div>{visible.length===0&&<div className="empty"><h3>No goods found</h3><p>Try another search or category.</p><button className="text-button" onClick={()=>{setQuery('');setCategory('All goods');}}>Show all goods</button></div>}</section></>}
    {selectedId&&(selected?<section className="detail"><a className="back" href="#/"><ArrowLeft size={18}/>Back to the collection</a><div className="detail-grid"><img src={selected.image_url} alt={selected.name} width="700" height="700"/><div><p className="muted">{selected.category}</p><h1>{selected.name}</h1><p className="detail-price">{money(selected.price_cents)}</p><p className="muted">{selected.description}</p><p className="availability">{selected.stock>0?`${selected.stock} available`:'Currently out of stock'}</p><button className="primary" disabled={busy||selected.stock<1} onClick={()=>add(selected)}><Plus size={18}/>Add to basket</button><p className="fine mt-6">Free demo delivery. All payments are simulated.</p></div></div></section>:<div className="empty"><h1>Product not found</h1><a href="#/">Back to the shop</a></div>)}
    {route==='/basket'&&<Basket cart={cart} busy={busy} update={update} remove={remove} checkout={()=>{location.hash='/checkout';}}/>}
    {route==='/checkout'&&<Checkout cart={cart} busy={busy} place={place}/>}
    {route==='/confirmation'&&(order?<Confirmation order={order} requestId={lastRequest} retry={place} busy={busy}/>:<div className="empty"><h1>Your orders are saved</h1><a href="#/orders" className="primary">View your orders</a></div>)}
    {route==='/orders'&&<Orders orders={orders}/>}
    {!['/','/basket','/checkout','/confirmation','/orders'].includes(route)&&!selectedId&&<div className="empty"><h1>Page not found</h1><a href="#/">Return to MiniShop</a></div>}
    </>}
    </main><footer className="site-footer"><div><a className="brand" href="#/">minishop.</a><p>Considered goods for your everyday.</p></div><p>A working little shop, composed of many parts.<br/><span>Demo store · Simulated payments · No real purchases</span></p></footer><div className={`toast ${notice?'visible':''}`} role="status" aria-live="polite">{notice}<a href="#/basket">View basket <ArrowRight size={16}/></a></div></>;
}
