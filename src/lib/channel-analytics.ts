import type { Channel,DemoOrder } from './demo-types';
import { madridClock } from './sync-policy';
export async function channelAnalytics(db:D1Database,now=new Date()) {
 const [totals,recent,daily]=await Promise.all([
  db.prepare(`SELECT channel,COUNT(*) AS orders,COALESCE(SUM(total_cents),0) AS total_cents,
    SUM(CASE WHEN status='paid' AND supplier_stock_committed=0 THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled FROM orders GROUP BY channel`).all<{channel:Channel;orders:number;total_cents:number;pending:number;cancelled:number}>(),
  db.prepare(`SELECT * FROM (SELECT id,order_number,channel,customer_name,total_cents,status,supplier_status,created_at,
    ROW_NUMBER() OVER (PARTITION BY CASE WHEN channel='WEB' THEN 'web' ELSE 'marketplaces' END ORDER BY id DESC) AS position
    FROM orders) WHERE position<=5 ORDER BY id DESC`).all<Pick<DemoOrder,'id'|'order_number'|'channel'|'customer_name'|'total_cents'|'status'|'supplier_status'|'created_at'>>(),
  db.prepare("SELECT channel,created_at FROM orders WHERE datetime(created_at)>=datetime(?,'-7 days')").bind(now.toISOString()).all<{channel:Channel;created_at:string}>(),
 ]);
 const today=Date.parse(`${madridClock(now).date}T12:00:00Z`);
 const days=Array.from({length:7},(_,i)=>{const date=new Date(today-(6-i)*86400000).toISOString().slice(0,10);return {date,web:0,marketplaces:0};});
 for(const order of daily.results){const date=madridClock(new Date(order.created_at.includes('T')?order.created_at:order.created_at.replace(' ','T')+'Z')).date;const day=days.find(d=>d.date===date);if(day)day[order.channel==='WEB'?'web':'marketplaces']++;}
 return {totals:totals.results,recent:recent.results,days};
}
export type ChannelAnalytics=Awaited<ReturnType<typeof channelAnalytics>>;
