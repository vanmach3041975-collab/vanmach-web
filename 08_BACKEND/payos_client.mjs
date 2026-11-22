import {createHmac,timingSafeEqual} from 'node:crypto';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
// Match payOS's payment-request response canonicalization: sort top-level
// fields, preserve array order and sort keys in each array item.
// https://github.com/payOSHQ/payos-lib-node/blob/main/src/utils/convert-obj-to-query-str.ts
function responseCanonical(data){
 return Object.keys(data).sort().filter(key=>data[key]!==undefined).map(key=>{
  let value=data[key];
  if(Array.isArray(value))value=JSON.stringify(value.map(item=>item&&typeof item==='object'&&!Array.isArray(item)
   ?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item));
  if(value===null||value==='null'||value==='undefined')value='';
  return `${key}=${value}`;
 }).join('&');
}
export function verifyPayosResponse(result,checksumKey){
 if(result?.code!=='00')return result;
 if(!result.data||typeof result.data!=='object'||Array.isArray(result.data)||
  typeof result.signature!=='string'||!/^[a-fA-F0-9]{64}$/.test(result.signature)||
  typeof checksumKey!=='string'||!checksumKey)fail(502,'Không xác minh được phản hồi payOS.');
 const expected=createHmac('sha256',checksumKey).update(responseCanonical(result.data)).digest();
 if(!timingSafeEqual(expected,Buffer.from(result.signature,'hex')))fail(502,'Phản hồi payOS không khớp chữ ký.');
 return result;
}
export class PayosClient {
 constructor(settings,{fetchImpl=fetch}={}){this.settings=settings;this.fetch=fetchImpl;}
 async confirmWebhook(webhookUrl){
  let url;
  try{url=new URL(webhookUrl);}catch{fail(400,'Địa chỉ webhook không hợp lệ.');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||
   url.pathname!=='/api/billing/payos/webhook')fail(400,'Địa chỉ webhook không hợp lệ.');
  const keys=this.settings.read();if(!keys)fail(503,'Chưa lưu cấu hình payOS.');
  let response,result;
  try{
   response=await this.fetch('https://api-merchant.payos.vn/confirm-webhook',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
    headers:{'x-client-id':keys.clientId,'x-api-key':keys.apiKey,'Content-Type':'application/json'},
    body:JSON.stringify({webhookUrl:url.href}),
   });
   result=await response.json();
  }catch{fail(502,'Không xác nhận được webhook với payOS.');}
  if(response.status===401||response.status===403)fail(400,'payOS chưa chấp nhận Client ID/API Key đã lưu.');
  if(!response.ok||result?.code!=='00'||result?.data?.webhookUrl!==url.href)
   fail(502,'payOS chưa xác nhận webhook.');
  return {confirmed:true,webhookUrl:url.href};
 }
 async request(route,body){
  const keys=this.settings.read();if(!keys)fail(503,'Chưa lưu cấu hình payOS.');
  let response,json;
  try{
   response=await this.fetch('https://api-merchant.payos.vn/v2/payment-requests'+route,{
    method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{'x-client-id':keys.clientId,'x-api-key':keys.apiKey,'Content-Type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{})});
   json=await response.json();
  }catch{fail(502,'Không nhận được phản hồi payOS. Hãy kiểm tra lại sau, không thanh toán lại khi chưa rõ trạng thái.');}
  // Never forward provider error bodies or request headers to clients/logs.
  if(response.status===401||response.status===403)fail(400,'payOS chưa chấp nhận Client ID/API Key đã lưu.');
  if(!response.ok)fail(502,'payOS tạm thời chưa xử lý được yêu cầu.');
  return verifyPayosResponse(json,keys.checksumKey);
 }
 async inspect(orderCode){
  if(!Number.isSafeInteger(orderCode)||orderCode<=0)fail(400,'Mã đơn không hợp lệ.');
  return this.request('/'+orderCode);
 }
 async create({orderCode,amount,returnUrl,cancelUrl}){
  if(!Number.isSafeInteger(orderCode)||orderCode<=0||!Number.isSafeInteger(amount)||amount<=0)fail(400,'Đơn thanh toán không hợp lệ.');
  for(const value of [returnUrl,cancelUrl]){
   let url;try{url=new URL(value);}catch{fail(400,'Địa chỉ thanh toán không hợp lệ.');}
   if(url.protocol!=='https:'||url.username||url.password)fail(400,'Thanh toán cần địa chỉ HTTPS.');
  }
  const keys=this.settings.read();if(!keys)fail(503,'Chưa lưu cấu hình payOS.');
  const description='VanMach';
  const source=`amount=${amount}&cancelUrl=${cancelUrl}&description=${description}&orderCode=${orderCode}&returnUrl=${returnUrl}`;
  const result=await this.request('',{orderCode,amount,description,returnUrl,cancelUrl,
   signature:createHmac('sha256',keys.checksumKey).update(source).digest('hex'),expiredAt:Math.floor(Date.now()/1000)+1800});
  if(result.code!=='00'||!result.data)fail(502,'payOS chưa tạo được đơn. Cần kiểm tra trạng thái trước khi thử lại.');
  const data=result.data;let checkout;
  try{checkout=new URL(data.checkoutUrl);}catch{fail(502,'Đường dẫn thanh toán không hợp lệ.');}
  if(checkout.protocol!=='https:'||checkout.hostname!=='pay.payos.vn'||checkout.username||checkout.password||
   data.orderCode!==orderCode||data.amount!==amount||data.currency!=='VND'||
   typeof data.paymentLinkId!=='string'||!data.paymentLinkId||typeof data.accountNumber!=='string'||!data.accountNumber)fail(502,'Thông tin đơn payOS không khớp.');
  return {orderCode,amount,paymentLinkId:data.paymentLinkId,accountNumber:data.accountNumber,checkoutUrl:checkout.href};
 }
}
