'use strict';
module.exports.main=async ctx=>{
  const fs=require('node:fs'),path=require('node:path');
  const {out,runtimeEpoch,previousEpoch,sinceMs,operationId}=ctx.inputs;
  const result={runtimeEpoch,previousEpoch,sinceMs,afterOperationId:operationId};
  const started=Date.now();
  result.logs=await ctx.call('logs',{runtimeEpoch,sinceMs,limit:500});result.logReadMs=Date.now()-started;
  if(!result.logs.ok||result.logs.evidence.coverage.status!=='complete')throw Error('current_logs_window_incomplete');
  result.events=await ctx.call('events',{runtimeEpoch,sinceMs,limit:500});
  result.currentProof=await ctx.assert({name:'epoch-current',scope:'device',condition:result.events.evidence.capture.runtimeEpoch===runtimeEpoch
    &&result.events.result.items.length>0,evidence:result.events.evidence,requiredEvidence:['events'],requireCoverage:'complete'});
  if(previousEpoch){
    result.old=await ctx.call('logs',{runtimeEpoch:previousEpoch,sinceMs:0,limit:1});
    result.oldProof=await ctx.assert({name:'epoch-old-rejected',scope:'device',condition:true,evidence:result.old.evidence,requiredEvidence:['logs'],requireCoverage:'complete'});
  }
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));
  if(result.currentProof.verdict!=='passed'||(previousEpoch&&(result.old.ok!==false||result.old.error!=='runtime_epoch_changed'||result.oldProof.verdict!=='inconclusive')))
    throw Error('runtime_epoch_evidence_contract_failed');
  return {ok:true};
};
