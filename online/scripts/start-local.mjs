import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import './sites-env.mjs';
const envFile=fileURLToPath(new URL('../.dev.vars',import.meta.url));
const args=['--import','./scripts/sites-env.mjs','./node_modules/wrangler/bin/wrangler.js','dev','--config','dist/server/wrangler.json','--local','--persist-to','.wrangler/state','--ip','127.0.0.1','--inspector-port','0'];
if(existsSync(envFile))args.push('--env-file',envFile);
const child=spawn(process.execPath,[...args,...process.argv.slice(2)],{stdio:'inherit'});
child.on('exit',code=>process.exit(code??1));
