import {ArrowRight, CheckCircle, Package, Plus, ShoppingBag, Trash} from '@phosphor-icons/react';
import {Cart, money, Order, Product} from './api';

export function ProductCard({product:p, add, busy}:{product:Product; add:(p:Product)=>void; busy:boolean}) {
  return <article className="product-card">
    <a href={`#/product/${p.id}`} className="product-photo"><img src={p.image_url} alt={p.name} loading="lazy" width="600" height="600"/></a>
    <div className="product-info"><p className="muted text-xs">{p.category}</p><div className="flex justify-between gap-3"><h3><a href={`#/product/${p.id}`}>{p.name}</a></h3><span className="price">{money(p.price_cents)}</span></div>
    <p className="description">{p.description.split('. ')[0]}.</p><button className="text-button" disabled={busy || p.stock < 1} onClick={()=>add(p)}><Plus size={16}/>{p.stock ? 'Add to basket' : 'Out of stock'}</button></div>
  </article>;
}

export function Basket({cart, busy, update, remove, checkout}:{cart:Cart; busy:boolean; update:(p:Product,n:number)=>void; remove:(p:Product)=>void; checkout:()=>void}) {
  return <><div className="page-heading"><a href="#/">Shop all goods <ArrowRight/></a><h1>Your basket</h1><p className="muted">A few good things, ready to go.</p></div>
    {cart.items.length === 0 ? <Empty title="Room for something good" text="Your basket is empty. Find a little something for your everyday."/> : <div className="basket-layout">
    <div>{cart.items.map(({product:p,quantity,line_total_cents})=><article className="basket-item" key={p.id}>
      <a href={`#/product/${p.id}`}><img src={p.image_url} alt={p.name} width="120" height="120"/></a><div><h2><a href={`#/product/${p.id}`}>{p.name}</a></h2><p className="muted">{money(p.price_cents)} each</p><label className="quantity-label">Quantity <select aria-label={`Quantity for ${p.name}`} disabled={busy} value={quantity} onChange={e=>update(p,Number(e.target.value))}>{Array.from({length:Math.min(p.stock,99)},(_,i)=>i+1).map(n=><option key={n}>{n}</option>)}</select></label></div>
      <div className="item-end"><strong>{money(line_total_cents)}</strong><button className="text-button muted" disabled={busy} onClick={()=>remove(p)} aria-label={`Remove ${p.name}`}><Trash size={16}/>Remove</button></div>
    </article>)}</div><aside className="summary"><h2>Order summary</h2><div><span>Subtotal</span><span>{money(cart.total_cents)}</span></div><div><span>Demo delivery</span><span>Free</span></div><div className="total"><strong>Total</strong><strong>{money(cart.total_cents)}</strong></div><button className="primary w-full" disabled={busy} onClick={checkout}>Review checkout <ArrowRight size={18}/></button><p className="fine">This is a demo shop. Payment is simulated and no goods will be dispatched.</p></aside></div>}
  </>;
}

export function Empty({title,text}:{title:string;text:string}) {
  return <div className="empty"><ShoppingBag size={48} weight="light"/><h2>{title}</h2><p className="muted">{text}</p><a className="primary" href="#/">Explore the collection <ArrowRight size={18}/></a></div>;
}

export function Checkout({cart,busy,place}:{cart:Cart;busy:boolean;place:()=>void}) {
  return <div className="checkout"><a className="back" href="#/basket">Back to basket</a><h1>One last look.</h1><p className="muted">Good choices. Here’s what’s coming together.</p><div className="review">{cart.items.map(i=><div key={i.product.id}><span>{i.quantity} × {i.product.name}</span><strong>{money(i.line_total_cents)}</strong></div>)}<div className="total"><strong>Total</strong><strong>{money(cart.total_cents)}</strong></div></div><div className="payment-note"><CheckCircle size={24}/><div><h2>Simulated payment provider</h2><p>No card details, no real money. This test order demonstrates a real checkout across independent services.</p></div></div><button className="primary w-full" disabled={busy || !cart.items.length} onClick={place}>{busy?'Placing your order…':'Place demo order'}<ArrowRight size={18}/></button></div>;
}

export function Confirmation({order,requestId,retry,busy}:{order:Order;requestId:string;retry:()=>void;busy:boolean}) {
  return <div className="confirmation"><CheckCircle size={56} weight="light"/><h1>A good choice.</h1><p className="muted">Your demo order is confirmed and saved.</p><p className="order-number">Order {order.id}</p><div className="review">{order.items.map((i,n)=><div key={n}><span>{i.quantity} × {i.name}</span><strong>{money(i.quantity*i.unit_price_cents)}</strong></div>)}<div className="total"><strong>Total</strong><strong>{money(order.total_cents)}</strong></div></div><p className="fine">Payment simulated. No money was taken and no delivery will be made.</p>{order.basket_cleared === false && <div className="notice"><p>Your order is saved, but your basket could not be cleared yet.</p><button disabled={busy} onClick={retry} className="text-button">{busy?'Checking…':'Retry basket cleanup safely'}</button></div>}<div className="flex flex-wrap justify-center gap-3 mt-6"><a className="primary" href="#/">Continue shopping <ArrowRight size={18}/></a><a className="secondary" href="#/orders">View your orders</a></div><details className="trace"><summary>Request reference</summary><code>{requestId}</code></details></div>;
}

export function Orders({orders}:{orders:Order[]}) {
  return <><div className="page-heading"><h1>Your orders</h1><p className="muted">The good things you’ve picked in this browser session.</p></div>{!orders.length?<Empty title="Your story starts here" text="Once you place a demo order, you’ll find it here."/>:<div className="orders">{orders.map(o=><article key={o.id}><div className="order-heading"><Package size={24}/><div><h2>Order {o.id.slice(0,8)}</h2><p className="muted">{new Date(o.created_at).toLocaleString('en-GB')}</p></div><strong>{money(o.total_cents)}</strong></div>{o.items.map((i,n)=><p key={n}>{i.quantity} × {i.name}</p>)}<p className="fine mt-4">Confirmed · Simulated payment · {o.id}</p></article>)}</div>}</>;
}
