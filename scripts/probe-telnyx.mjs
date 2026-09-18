// OPTIONAL read-only API contract probe, never invoked by tests or install.
// This is one message-list request, NOT a paginated ingestion implementation.
import {mkdir,writeFile} from 'node:fs/promises';
const key=process.env.TELNYX_API_KEY;
const inbox=process.env.TELNYX_INBOX_ID;
if (!key || !inbox) {
  console.error('BLOCKED: configure TELNYX_API_KEY and TELNYX_INBOX_ID in local .env. Do not paste them into chat.');
  process.exitCode=2;
} else if (!/^[A-Za-z0-9._@+-]{1,256}$/.test(inbox)) {
  console.error('BLOCKED: verify the exact inbox identifier from Telnyx.'); process.exitCode=2;
} else {
  try {
    const response=await fetch(`https://api.telnyx.com/v2/email_inboxes/${encodeURIComponent(inbox)}/messages`,{
      headers:{Authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const reader=response.body?.getReader();
    if (!reader) throw new Error('EMPTY_BODY');
    const chunks=[]; let size=0;
    while (true) {
      const part=await reader.read(); if (part.done) break;
      size+=part.value.byteLength;
      if(size>1_000_000){await reader.cancel();throw new Error('RESPONSE_LIMIT');}
      chunks.push(part.value);
    }
    const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    function shape(x,depth=0) {
      if (depth>8) return 'depth_limit';
      if (x===null) return 'null';
      if(Array.isArray(x))return {type:'array',length:x.length,sampleShapes:x.slice(0,3).map(v=>shape(v,depth+1))};
      if(typeof x==='object')return Object.fromEntries(Object.entries(x).slice(0,100).map(([k,v],i)=>[
        /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)?k:`redacted_key_${i}`,shape(v,depth+1)]));
      return typeof x;
    }
    await mkdir('.private',{recursive:true});
    await writeFile('.private/telnyx-message-shape.json',JSON.stringify({httpStatus:response.status,capturedAt:new Date().toISOString(),shape:shape(data),
      note:'Types only; no message content, identifiers, email addresses, credentials or URL values retained. One page only.'},null,2),{mode:0o600});
    console.log('Probe succeeded. Type-only response shape saved to .private/telnyx-message-shape.json. Attachment download is NOT yet verified.');
  } catch(error) {
    const message=error instanceof Error && /^HTTP_\d{3}$|^EMPTY_BODY$|^RESPONSE_LIMIT$/.test(error.message)?error.message:'NETWORK_TIMEOUT_OR_UNEXPECTED_RESPONSE';
    console.error(`Probe failed: ${message}. No response contents logged. No automatic retry.`);process.exitCode=1;
  }
}
