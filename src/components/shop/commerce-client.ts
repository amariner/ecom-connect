import type {CartLine} from '../../lib/cart-client';
export interface QuoteLine {slug:string;name:string;image:string;qty:number;unit_price_cents:number;line_total_cents:number;available_stock:number;status:'ok'|'not-found'|'out-of-stock'|'insufficient-stock'}
export interface CartQuote {lines:QuoteLine[];subtotal_cents:number;shipping_cents:number|null;total_cents:number|null;purchasable:boolean;shipping:{zone:string;label:string;free_over_cents:number|null}|null}
export const escapeHtml=(value:string)=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
export async function requestQuote(lines:CartLine[],postal_code:string):Promise<CartQuote>{
 let response:Response;
 try{response=await fetch('/api/cart/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lines,postal_code}),signal:AbortSignal.timeout(15000)});
 }catch{throw new Error('La consulta está tardando más de lo esperado. Comprueba tu conexión y vuelve a intentarlo.');}
 const data=await response.json() as CartQuote & {error?:string};
 if(!response.ok)throw new Error(data.error||'No hemos podido consultar precios y existencias. Inténtalo de nuevo.');
 return data;
}
