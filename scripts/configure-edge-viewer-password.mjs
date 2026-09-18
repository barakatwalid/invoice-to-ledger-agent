import {chmodSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {deriveEdgeViewerToken} from '../src/edge/config.ts';

try{
  const privateDirectory='.private';
  const controlTokenPath=`${privateDirectory}/edge-control-token`;
  const viewerTokenPath=`${privateDirectory}/edge-viewer-token`;
  const controlToken=readFileSync(controlTokenPath,'utf8').trim();
  const viewerToken=await deriveEdgeViewerToken(controlToken);
  mkdirSync(privateDirectory,{recursive:true,mode:0o700});
  writeFileSync(viewerTokenPath,`${viewerToken}\n`,{encoding:'utf8',mode:0o600});
  chmodSync(viewerTokenPath,0o600);
  console.log(JSON.stringify({status:'PASS',viewerTokenPath,valuesPrinted:false,remoteSecretWrites:0},null,2));
}catch{
  console.error('FAIL: edge_viewer_password_configuration_failed');
  process.exitCode=1;
}
