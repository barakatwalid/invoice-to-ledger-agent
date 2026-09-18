import {spawnSync} from 'node:child_process';
import {accessSync,constants} from 'node:fs';
import {dirname,resolve} from 'node:path';
const [major, minor] = process.versions.node.split('.').map(Number);
const supported = (major === 22 && minor >= 16) || major === 24;
const tsc=spawnSync('tsc',['--version'],{encoding:'utf8',shell:process.platform==='win32'});
const rendererCandidates=[process.env.PDFTOPPM_PATH?.trim(),
  resolve(dirname(process.execPath),'..','..','bin','override','pdftoppm'),
  '/opt/homebrew/bin/pdftoppm','/usr/local/bin/pdftoppm','/usr/bin/pdftoppm'].filter(Boolean);
let visualPdfRendererAvailable=false;
for(const candidate of rendererCandidates){try{accessSync(candidate,constants.X_OK);visualPdfRendererAvailable=true;break;}catch{}}
if(!visualPdfRendererAvailable){visualPdfRendererAvailable=spawnSync('pdftoppm',['-v'],{encoding:'utf8'}).status===0;}
console.log(JSON.stringify({node:process.versions.node,platform:process.platform,architecture:process.arch,
  nodeSupported:supported,typescriptAvailable:tsc.status===0,visualPdfRendererAvailable,
  configurationPresenceOnly:{TELNYX_API_KEY:!!process.env.TELNYX_API_KEY,TELNYX_INBOX_ID:!!process.env.TELNYX_INBOX_ID},
  note:'No secrets printed. Presence does not establish valid credentials or product access. The PDF renderer is needed only for scanned PDFs; no network requests made.'
},null,2));
if (!supported) { console.error('Use an up-to-date Node 22 or Node 24 LTS installation.'); process.exitCode=2; }
