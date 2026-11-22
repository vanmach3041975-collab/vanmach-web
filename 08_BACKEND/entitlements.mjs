import {plans} from './plans.mjs';
// Only verified, current server-side periods can grant rights. Client plan IDs
// and profile roles are never inputs to this decision.
export function entitlementsFor(budget,userId){
 const period=budget.current(userId);
 const plan=plans.find(p=>p.id===period?.plan_id)??plans[0];
 const paid=plan.id!=='free';
 return Object.freeze({planId:plan.id,planName:plan.name,adFree:paid&&plan.adFree,
  unlimitedManualRooms:paid,teacherAi:paid&&plan.aiQuiz===true,
  paidAi:paid&&plan.aiBudgetUsd>0,endsAt:paid?period.ends:null,
  remainingAiMicros:paid?budget.remaining(period):0});
}
