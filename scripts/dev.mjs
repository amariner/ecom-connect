import {spawn} from 'node:child_process';
// Demo: only serve user requests. No scheduler, polling or background database work.
const server=spawn(process.execPath,['node_modules/astro/astro.js','dev','--port','4327',...process.argv.slice(2)],{stdio:'inherit'});
let stopping=false;
function stop(signal='SIGTERM'){if(stopping)return;stopping=true;server.kill(signal);}
process.on('SIGINT',()=>stop('SIGINT'));process.on('SIGTERM',()=>stop());
server.on('exit',code=>process.exit(code??0));
