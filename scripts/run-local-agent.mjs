import {randomBytes} from 'node:crypto';
import {chmodSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join,resolve} from 'node:path';
import Telnyx from 'telnyx';
import {parseAllowedAttachmentHosts} from '../src/attachment.ts';
import {validateBookkeepingPolicy} from '../src/bookkeeping.ts';
import {errorCode} from '../src/errors.ts';
import {JobStore} from '../src/job-store.ts';
import {createLocalAgentHandler,LocalBookkeepingAgent} from '../src/local-agent.ts';
import {validateSyntheticAnswerKey} from '../src/slice.ts';

const required=['TELNYX_API_KEY','TELNYX_INBOX_ID'];
const missing=required.filter(name=>!process.env[name]?.trim());
if(missing.length){
  console.error(`BLOCKED: configure ${missing.join(', ')} in local .env. Do not paste secret values into chat.`);
  process.exitCode=2;
}else{
  let store;
  try{
    const port=process.env.PORT===undefined?3000:Number(process.env.PORT);
    const host=process.env.LOCAL_AGENT_HOST?.trim()||'127.0.0.1';
    const pollIntervalSeconds=process.env.LOCAL_AGENT_POLL_INTERVAL_SECONDS===undefined?
      60:Number(process.env.LOCAL_AGENT_POLL_INTERVAL_SECONDS);
    const maxJobAttempts=process.env.LOCAL_AGENT_MAX_JOB_ATTEMPTS===undefined?
      1:Number(process.env.LOCAL_AGENT_MAX_JOB_ATTEMPTS);
    if(!Number.isSafeInteger(port)||port<1||port>65535||
      !['127.0.0.1','0.0.0.0','::1'].includes(host)||
      !Number.isSafeInteger(pollIntervalSeconds)||pollIntervalSeconds<15||pollIntervalSeconds>3600||
      !Number.isSafeInteger(maxJobAttempts)||maxJobAttempts<1||maxJobAttempts>5){
      throw new Error('invalid_local_agent_runtime_config');
    }
    const privateDirectory=resolve(process.env.BOOKKEEPING_DATA_DIR?.trim()||'.private');
    mkdirSync(privateDirectory,{recursive:true,mode:0o700});
    const tokenPath=join(privateDirectory,'local-agent-control-token');
    let controlToken=process.env.BOOKKEEPING_CONTROL_TOKEN?.trim();
    if(!controlToken){
      try{controlToken=readFileSync(tokenPath,'utf8').trim();}
      catch(error){
        if(error?.code!=='ENOENT')throw error;
        controlToken=randomBytes(48).toString('base64url');
        writeFileSync(tokenPath,`${controlToken}\n`,{encoding:'utf8',mode:0o600,flag:'wx'});
      }
    }
    if(controlToken.length<32||controlToken.length>512)throw new Error('invalid_local_control_token');
    if(!process.env.BOOKKEEPING_CONTROL_TOKEN)chmodSync(tokenPath,0o600);

    const [answerRaw,policyRaw,providerRaw]=await Promise.all([
      readFile('fixtures/synthetic-invoice-answer-key.json','utf8'),
      readFile('config/demo-policy.json','utf8'),
      readFile('config/local-agent-provider.json','utf8'),
    ]);
    const providerConfig=JSON.parse(providerRaw);
    if(providerConfig?.schemaVersion!=='local_agent_provider_v1'||
      typeof providerConfig.modelId!=='string'||!providerConfig.modelId||
      !Array.isArray(providerConfig.attachmentHosts)||providerConfig.attachmentHosts.length===0||
      !providerConfig.attachmentHosts.every(value=>typeof value==='string'&&value)||
      !['none','minimal','low','medium','high','xhigh','max'].includes(providerConfig.reasoningEffort)){
      throw new Error('invalid_local_agent_provider_config');
    }
    const modelId=process.env.EXTRACTION_MODEL_ID?.trim()||providerConfig.modelId;
    const attachmentHosts=process.env.TELNYX_ATTACHMENT_HOSTS?.trim()||
      providerConfig.attachmentHosts.join(',');
    const reasoningEffort=process.env.EXTRACTION_REASONING_EFFORT?.trim()||providerConfig.reasoningEffort;
    if(!['none','minimal','low','medium','high','xhigh','max'].includes(reasoningEffort)){
      throw new Error('invalid_local_agent_reasoning_effort');
    }
    const answerKey=validateSyntheticAnswerKey(JSON.parse(answerRaw));
    const policy=validateBookkeepingPolicy({
      ...JSON.parse(policyRaw),
      resultAccess:'authenticated_local_service_only',
    });
    const client=new Telnyx({
      apiKey:process.env.TELNYX_API_KEY,
      baseURL:'https://api.telnyx.com/v2',
      timeout:180_000,
      maxRetries:0,
    });
    store=new JobStore(join(privateDirectory,'live-slice.sqlite'));
    const agent=new LocalBookkeepingAgent({
      client,store,privateDirectory,
      inboxId:process.env.TELNYX_INBOX_ID,
      subjectFilter:process.env.LOCAL_AGENT_SUBJECT_FILTER?.trim()||null,
      modelId,
      reasoningEffort,
      allowedHosts:parseAllowedAttachmentHosts(attachmentHosts),
      policy,answerKey,maxNewJobsPerPoll:1,maxJobAttempts,
    });
    const handler=createLocalAgentHandler(agent,controlToken);
    const server=createServer((request,response)=>{
      void handler(request,response).catch(error=>{
        if(!response.headersSent)response.writeHead(500,{'content-type':'application/json','cache-control':'no-store'});
        response.end(`${JSON.stringify({error:errorCode(error)})}\n`);
      });
    });
    await new Promise((accept,reject)=>{
      server.once('error',reject);
      server.listen(port,host,accept);
    });
    console.log(JSON.stringify({
      status:'READY',
      url:`http://${host}:${port}`,
      inboxMode:process.env.LOCAL_AGENT_SUBJECT_FILTER?'exact_subject':'all_received_messages_with_one_supported_attachment',
      pollIntervalSeconds,
      authentication:'required',
      controlTokenSource:process.env.BOOKKEEPING_CONTROL_TOKEN?'environment_secret':tokenPath,
      note:'No secret value is printed. Press Ctrl-C to stop.',
    },null,2));

    const safePoll=async reason=>{
      const result=await agent.pollOnce();
      console.log(JSON.stringify({event:'inbox_poll',reason,status:result.status,
        inspectedMessages:result.inspectedMessages,claimedJobs:result.claimedJobs,
        completedJobs:result.completedJobIds.length,skippedUnsupportedMessages:result.skippedUnsupportedMessages,
        lastError:result.lastError}));
    };
    void safePoll('startup');
    const timer=setInterval(()=>{void safePoll('interval');},pollIntervalSeconds*1000);
    let stopping=false;
    const stop=async()=>{
      if(stopping)return;stopping=true;clearInterval(timer);
      await agent.stop();
      await new Promise(resolveClose=>server.close(resolveClose));
      store.close();store=undefined;
    };
    process.once('SIGINT',()=>{void stop().then(()=>process.exit(0));});
    process.once('SIGTERM',()=>{void stop().then(()=>process.exit(0));});
  }catch(error){
    store?.close();
    const code=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:errorCode(error);
    console.error(`FAIL: ${code}`);
    process.exitCode=1;
  }
}
