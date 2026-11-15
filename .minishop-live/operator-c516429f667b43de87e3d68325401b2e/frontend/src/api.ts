export type Product = {id: string; name: string; description: string; category: string; price_cents: number; currency: string; stock: number; image_url: string};
export type Cart = {items: {product: Product; quantity: number; line_total_cents: number}[]; total_cents: number; currency: string};
export type Order = {id: string; total_cents: number; created_at: string; status: string; payment_reference: string; basket_cleared?: boolean; items: {name: string; quantity: number; unit_price_cents: number}[]};
export const money = (cents: number) => new Intl.NumberFormat('en-GB', {style:'currency', currency:'GBP'}).format(cents / 100);
const stored = localStorage.getItem('minishop-session');
export const session = stored && /^[0-9a-f-]{36}$/i.test(stored) ? stored : crypto.randomUUID();
localStorage.setItem('minishop-session', session);
export const checkoutStorage = `minishop-checkout:${session}`;

export class ApiError extends Error {
  constructor(message: string, public requestId: string) {super(message);}
}

export async function api<T>(path: string, init: RequestInit = {}, explicitRequestId?: string): Promise<{data:T; requestId:string}> {
  const requestId = explicitRequestId ?? crypto.randomUUID();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);
  try {
    const response = await fetch(`/api${path}`, {...init, signal: controller.signal,
      headers: {'Content-Type':'application/json', 'X-Request-ID':requestId, ...init.headers}});
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(typeof body?.detail === 'string' ? body.detail : 'The shop is temporarily unavailable. Please try again.', response.headers.get('X-Request-ID') || requestId);
    return {data: body as T, requestId: response.headers.get('X-Request-ID') || requestId};
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('We could not reach the shop. Your checkout key is saved; retry to check the result safely.', requestId);
  } finally {clearTimeout(timeout);}
}
