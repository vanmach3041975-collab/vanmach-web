// Upper-bound tariffs (micro-USD per token) from the official model pages as
// checked 2026-09-26. Review prices before enabling sales.
const tariff = Object.freeze({
  'gpt-6-luna':{input:0.1,output:0.5},
  'gpt-6-sol':{input:2,output:10},
  'gpt-6-astra':{input:10,output:50},
});
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const whole=n=>Number.isSafeInteger(n)&&n>=0;

export function paidModels(){return Object.keys(tariff);}

export async function runPaidAi({budget,userId,model,apiKey,fetchImpl,instructions,input,maxOutputTokens=2200,format}) {
  const price=tariff[model];
  if(!price)fail(400,'Model AI chưa được hỗ trợ trong gói.');
  if(!apiKey)fail(503,'AI trả phí chưa được cấu hình trên máy chủ.');
  if(!whole(maxOutputTokens)||maxOutputTokens<100||maxOutputTokens>2200)fail(400,'Giới hạn phản hồi không hợp lệ.');
  const payload={model,instructions,input,reasoning:{effort:'low'},max_output_tokens:maxOutputTokens,store:false,service_tier:'default',
    ...(format?{text:{format}}:{})};
  const bytes=Buffer.byteLength(JSON.stringify(payload),'utf8');
  if(bytes>40000)fail(413,'Nội dung quá dài cho ngân sách AI.');
  // For text-only requests, one UTF-8 byte cannot encode more than one input
  // token. Add 4k tokens for server/model framing; reserve before upstream I/O.
  const maximumMicros=Math.ceil(2*((bytes+4000)*price.input+maxOutputTokens*price.output));
  const reservation=budget.reserve(userId,{model,maximumMicros});
  let response;
  try {
    response=await fetchImpl('https://api.openai.com/v1/responses',{method:'POST',
      headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},
      body:JSON.stringify(payload),signal:AbortSignal.timeout(45000)});
  } catch {fail(504,'AI phản hồi chậm hoặc mất kết nối. Ngân sách tạm giữ sẽ được đối soát.');}
  if(!response.ok){
    if([400,401,403,404,429].includes(response.status))budget.cancelUncharged(reservation);
    fail(response.status===429?429:502,response.status===429?'Dịch vụ AI đã đến hạn mức. Thử lại sau.':'AI chưa xử lý được yêu cầu.');
  }
  let result;
  try {result=await response.json();}catch{fail(502,'AI trả dữ liệu không hợp lệ. Ngân sách tạm giữ sẽ được đối soát.');}
  const usage=result?.usage;
  if(!whole(usage?.input_tokens)||!whole(usage?.output_tokens))fail(502,'AI chưa trả số liệu sử dụng. Ngân sách tạm giữ sẽ được đối soát.');
  const tier=result.service_tier??'default';
  if(!['default','priority','fast'].includes(tier))fail(502,'AI dùng chế độ tính phí chưa được hỗ trợ. Ngân sách tạm giữ sẽ được đối soát.');
  const multiplier=tier==='default'?1:2;
  const actualMicros=Math.ceil(multiplier*(usage.input_tokens*price.input+usage.output_tokens*price.output));
  // An unexpectedly high provider bill stays reserved for manual reconciliation.
  budget.settle(reservation,actualMicros);
  return {result,actualMicros};
}
