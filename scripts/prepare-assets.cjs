const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
let sharp;
try{sharp=require('sharp');}catch{sharp=require('/Users/itawjh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');}
const project=path.resolve(__dirname,'..');
const vm=require('node:vm');
const context={window:{}};
vm.runInNewContext(fs.readFileSync(path.join(project,'data/employees.js'),'utf8'),context);
const employees=context.window.TEAM_EMPLOYEES;
const sources={};
for(const filename of ['portraits-root.json','portraits-r02-r08.json','portraits-r09-r16.json','portraits-g03-g05.json']){
  const file=path.join('/tmp',filename);
  if(fs.existsSync(file))Object.assign(sources,JSON.parse(fs.readFileSync(file,'utf8')));
}
const revisionSourcesPath=path.join(project,'docs/portrait-revision-sources.json');
if(fs.existsSync(revisionSourcesPath)){
  const revisions=JSON.parse(fs.readFileSync(revisionSourcesPath,'utf8'));
  for(const [id,source] of Object.entries(revisions)){
    if(typeof source!=='string')throw Error(`Invalid revision source for ${id}`);
    sources[id]=path.resolve(project,source);
  }
}
(async()=>{
  const assets=[];
  for(const employee of employees){
    const destination=path.join(project,employee.portrait),thumbnail=path.join(project,employee.thumb);
    const candidate=sources[employee.id];
    const source=candidate&&fs.existsSync(candidate)?candidate:null;
    if(source&&path.resolve(source)!==path.resolve(destination)){fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(source,destination);}
    if(!fs.existsSync(destination))continue;
    fs.mkdirSync(path.dirname(thumbnail),{recursive:true});
    const metadata=await sharp(destination).metadata();
    await sharp(destination).resize({width:320,height:320,fit:'inside',withoutEnlargement:true}).webp({quality:72,effort:4}).toFile(thumbnail);
    const bytes=fs.readFileSync(destination);
    assets.push({id:employee.id,name:employee.name,role:employee.title,portrait:employee.portrait,thumbnail:employee.thumb,source:source||null,width:metadata.width,height:metadata.height,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),thumbnailBytes:fs.statSync(thumbnail).size});
  }
  const missing=employees.filter(employee=>!assets.some(asset=>asset.id===employee.id)).map(employee=>employee.id);
  const unique=new Set(assets.map(asset=>asset.sha256)).size;
  if(unique!==assets.length)throw Error('Duplicated employee image content');
  fs.writeFileSync(path.join(project,'docs/assets-manifest.json'),JSON.stringify({generatedWith:'built-in image_gen',expected:21,count:assets.length,unique,missing,assets},null,2));
  const promptPath=path.join(project,'docs/portrait-prompts.json');
  const prompts=JSON.parse(fs.readFileSync(promptPath,'utf8'));
  for(const character of prompts.characters){character.generation_status=assets.some(asset=>asset.id===character.id)?'已生成并保存独立PNG':'待生成';}
  fs.writeFileSync(promptPath,JSON.stringify(prompts,null,2));
  console.log(JSON.stringify({count:assets.length,unique,missing,thumbnailBytes:assets.reduce((total,asset)=>total+asset.thumbnailBytes,0)}));
})().catch(error=>{console.error(error);process.exit(1);});
