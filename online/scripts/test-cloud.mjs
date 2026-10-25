import {build} from 'esbuild';
import {mkdir,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
await mkdir('outputs',{recursive:true});
for(const name of ['core','auth'])await build({entryPoints:['cloud/'+name+'.ts'],bundle:true,platform:'node',format:'esm',outfile:'outputs/test-'+name+'.mjs'});
const tests=(await readdir('tests')).filter(f=>f.endsWith('.mjs')).map(f=>'tests/'+f);
const run=spawnSync(process.execPath,['--test',...tests],{stdio:'inherit'});
process.exit(run.status??1);
