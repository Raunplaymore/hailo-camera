const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname, '../server.js'),'utf8');
const functionStart=source.indexOf('async function deleteSessionArtifacts(jobId) {');
const functionEnd=source.indexOf('\nasync function createSessionTimelapse(',functionStart);
const routeStart=source.indexOf("app.delete('/api/session/:jobId'");
const routeEnd=source.indexOf("\n// 세션 목록 조회",routeStart);
assert.ok(functionStart>=0&&functionEnd>functionStart&&routeStart>=0&&routeEnd>routeStart);
let handler,attempts=0;
const fakeFs={readFile:async()=>JSON.stringify({videoFile:'test.mp4',metaPath:'/tmp/synthetic/test.meta.json'}),
 unlink:async()=>{attempts++;throw Object.assign(new Error('permission denied'),{code:'EACCES'});}};
const context={path,fsp:fakeFs,SESSION_STATE_DIR:'/tmp/synthetic/state',SESSION_META_DIR:'/tmp/synthetic/meta',UPLOAD_DIR:'/tmp/synthetic/videos',
 sessionManager:{isRunning:()=>false},app:{delete:(_route,fn)=>handler=fn}};
vm.runInNewContext(source.slice(functionStart,functionEnd)+'\n'+source.slice(routeStart,routeEnd),context);
const response={statusCode:200,status(code){this.statusCode=code;return this},json(value){this.body=value;return this}};
handler({params:{jobId:'session_test'}},response).then(()=>{
 assert.equal(attempts,1);assert.equal(response.statusCode,500);assert.equal(response.body.ok,false);
 console.log(JSON.stringify({scope:'camera handler with synthetic filesystem errors; no real files',unlinkErrors:attempts,httpStatus:response.statusCode,reportedSuccess:response.body.ok}));
}).catch(error=>{console.error(error);process.exitCode=1});
