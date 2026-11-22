// Prices are VND before tax. AI allowances are monthly USD service budgets,
// never transferable balances in a customer's OpenAI account.
export const plans = Object.freeze([
 {id:'free',name:'Miễn phí',priceVnd:0,aiBudgetUsd:0,adFree:false,aiLifetime:3,roomsLifetime:2},
 {id:'plus',name:'Plus',priceVnd:49000,aiBudgetUsd:0,adFree:true,aiLifetime:3},
 {id:'pro',name:'Pro',priceVnd:69000,aiBudgetUsd:1,adFree:true,maxModel:'gpt-6-astra'},
 {id:'max',name:'Max',priceVnd:99000,aiBudgetUsd:2,adFree:true,maxModel:'gpt-6-astra'},
 {id:'pro_max',name:'Pro Max',priceVnd:179000,aiBudgetUsd:3.5,adFree:true,maxModel:'gpt-6-astra'},
 {id:'teacher',name:'Giáo viên',priceVnd:199000,aiBudgetUsd:3.5,adFree:true,maxModel:'gpt-6-astra',aiQuiz:true},
]);
export const catalog = () => ({plans,period:'month',taxIncluded:false,purchaseReady:false,adsReady:false,
 freePolicy:{period:'lifetime',ai:3,rooms:2,firstFree:1,rewardRequiredAfterFirst:true}});
