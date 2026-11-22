import crypto from 'node:crypto';
import {plans} from './plans.mjs';
import {verifyPayosWebhook,matchPayosOrder} from './payos_webhook.mjs';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
export function nextMonth(start){
 const date=new Date(start),day=date.getUTCDate();date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+1);
 const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();date.setUTCDate(Math.min(day,last));return date.getTime();
}
export class PaymentOrders {
 constructor(db,{budget,client,settings,now=Date.now,enabled=false,publicBase='',confirmationUntil=0}={}){
  Object.assign(this,{db,budget,client,settings,now,enabled,publicBase,confirmationUntil});
  db.exec(`CREATE TABLE IF NOT EXISTS payment_orders(
   code INTEGER PRIMARY KEY,user_id TEXT NOT NULL,plan_id TEXT NOT NULL,amount INTEGER NOT NULL,
   state TEXT NOT NULL,created INTEGER NOT NULL,link TEXT,account TEXT,checkout TEXT,reference TEXT UNIQUE,
   starts INTEGER,ends INTEGER);
   CREATE UNIQUE INDEX IF NOT EXISTS one_pending_checkout ON payment_orders(user_id) WHERE state IN ('creating','pending','uncertain');
   CREATE TABLE IF NOT EXISTS payment_webhook_early(code INTEGER PRIMARY KEY,reference TEXT NOT NULL,body TEXT NOT NULL);`);
 }
 list(userId){return this.db.prepare('SELECT code,plan_id AS planId,amount,state,created,starts,ends FROM payment_orders WHERE user_id=? ORDER BY created DESC LIMIT 50').all(userId);}
 async reconcile(userId,code){
  if(!Number.isSafeInteger(code)||code<=0)fail(400,'Mã đơn không hợp lệ.');
  const order=this.db.prepare('SELECT * FROM payment_orders WHERE code=? AND user_id=?').get(code,userId);
  if(!order)fail(404,'Không tìm thấy đơn của bạn.');
  if(!['pending','uncertain'].includes(order.state))return {state:order.state};
  const response=await this.client.inspect(code);
  // A missing order or failed lookup cannot prove a previous create request
  // was not accepted. Keep uncertain orders reserved for manual reconciliation.
  if(response.code!=='00'||!response.data)fail(409,'Chưa xác minh được đơn với payOS. Đơn được giữ để đối soát.');
  const remote=response.data;
  if(remote.orderCode!==order.code||remote.amount!==order.amount||
   typeof remote.id!=='string'||!remote.id||(order.link&&remote.id!==order.link))fail(409,'Thông tin payOS không khớp đơn cần đối soát.');
  if(['CANCELLED','EXPIRED'].includes(remote.status)&&remote.amountPaid===0){
   // Conditional update avoids overwriting a concurrent successful webhook.
   this.db.prepare("UPDATE payment_orders SET state=?,link=coalesce(link,?) WHERE code=? AND state IN ('pending','uncertain')")
    .run(remote.status==='CANCELLED'?'cancelled':'expired',remote.id,code);
  }
  const current=this.db.prepare('SELECT state FROM payment_orders WHERE code=?').get(code);
  return {...current,needsReview:!['cancelled','expired','paid'].includes(current.state),
   message:remote.status==='PAID'?'payOS báo đã thanh toán. Đang chờ xác nhận giao dịch để cấp gói; không thanh toán lại.':undefined};
 }
 async create(userId,planId){
  if(!this.enabled||!this.publicBase.startsWith('https://'))fail(503,'Thanh toán chưa mở bán.');
  const plan=plans.find(p=>p.id===planId&&p.priceVnd>0);if(!plan)fail(400,'Gói không hợp lệ.');
  if(this.budget.current(userId))fail(409,'Bạn đang có gói còn hiệu lực. Gia hạn khi gói hết hạn.');
  const pending=this.db.prepare("SELECT * FROM payment_orders WHERE user_id=? AND state IN ('creating','pending','uncertain')").get(userId);
  if(pending){if(pending.state==='pending'&&pending.plan_id===planId)return {orderCode:pending.code,checkoutUrl:pending.checkout};fail(409,'Bạn có đơn đang chờ xử lý. Cần đối soát trước khi tạo đơn mới.');}
  const code=crypto.randomInt(1,281474976710655);
  this.db.prepare("INSERT INTO payment_orders(code,user_id,plan_id,amount,state,created) VALUES(?,?,?,?,'creating',?)").run(code,userId,planId,plan.priceVnd,this.now());
  try{
   const result=await this.client.create({orderCode:code,amount:plan.priceVnd,returnUrl:this.publicBase+'/plans',cancelUrl:this.publicBase+'/plans'});
   this.db.prepare("UPDATE payment_orders SET state='pending',link=?,account=?,checkout=? WHERE code=? AND state='creating'").run(result.paymentLinkId,result.accountNumber,result.checkoutUrl,code);
   const early=this.db.prepare('SELECT body FROM payment_webhook_early WHERE code=?').get(code);
   if(early){
    // A signed payment can arrive before create() has persisted the provider's
    // link/account. Verify those fields against the create response before grant.
    this.accept(JSON.parse(early.body));
    this.db.prepare('DELETE FROM payment_webhook_early WHERE code=?').run(code);
   }
   return {orderCode:code,checkoutUrl:result.checkoutUrl};
  }catch(error){this.db.prepare("UPDATE payment_orders SET state='uncertain' WHERE code=? AND state IN ('creating','pending')").run(code);throw error;}
 }
 accept(body){
  const keys=this.settings.read();const data=verifyPayosWebhook(body,keys?.checksumKey);
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const order=this.db.prepare('SELECT * FROM payment_orders WHERE code=?').get(data.orderCode);
   if(!order){
    // payOS sends a signed sample while registering a webhook. A short,
    // explicitly enabled window acknowledges it without creating an order or
    // entitlement. Never use this path while checkout orders are outstanding.
    const outstanding=this.db.prepare("SELECT 1 FROM payment_orders WHERE state IN ('creating','pending','uncertain') LIMIT 1").get();
    if(this.confirmationUntil>this.now()&&!outstanding){
     this.db.exec('COMMIT');return {ok:true,confirmationSample:true};
    }
    fail(404,'Không tìm thấy đơn thanh toán.');
   }
   if(order.state==='creating'){
    if(data.orderCode!==order.code||data.amount!==order.amount)fail(409,'Thanh toán không khớp đơn hàng đã tạo.');
    const early=this.db.prepare('SELECT reference FROM payment_webhook_early WHERE code=?').get(order.code);
    if(early&&early.reference!==data.reference)fail(409,'Đơn có nhiều giao dịch; cần đối soát.');
    if(!early)this.db.prepare('INSERT INTO payment_webhook_early(code,reference,body) VALUES(?,?,?)')
     .run(order.code,data.reference,JSON.stringify(body));
    this.db.exec('COMMIT');return {ok:true,deferred:true};
   }
   matchPayosOrder(data,{orderCode:order.code,amount:order.amount,paymentLinkId:order.link,accountNumber:order.account});
   if(order.state==='paid'){
    if(order.reference!==data.reference)fail(409,'Đơn đã có giao dịch khác. Cần đối soát.');
    this.db.exec('COMMIT');return {ok:true,duplicate:true};
   }
   if(order.state!=='pending')fail(409,'Đơn cần đối soát trước khi cấp gói.');
   const starts=this.now(),ends=nextMonth(starts);
   this.budget.applyVerifiedPeriod({eventId:'payos:'+data.reference,periodId:'payos:'+order.code,userId:order.user_id,planId:order.plan_id,starts,ends});
   this.db.prepare("UPDATE payment_orders SET state='paid',reference=?,starts=?,ends=? WHERE code=?").run(data.reference,starts,ends,order.code);
   this.db.exec('COMMIT');return {ok:true,duplicate:false};
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
}
