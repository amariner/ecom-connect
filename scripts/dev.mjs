import {spawn} from 'node:child_process';
// The local timer keeps running independently of the browser. Production uses the Worker cron.
const server=spawn(process.execPath,['node_modules/astro/astro.js','dev','--port','4327',...process.argv.slice(2)],{stdio:'inherit'});
const origin='http://localhost:4327';let working=false,stopping=false;
async function tick(){
 if(working||stopping)return;working=true;
 try{const response=await fetch(`${origin}/api/demo/scheduler`,{method:'POST',headers:{origin},signal:AbortSignal.timeout(180000)});if(response.ok){const result=await response.json();if(result.executed)console.log(`[demo scheduler] ${result.executed} sincronizaciones completadas`);}}
 catch{}finally{working=false;}
}
const timer=setInterval(tick,15000);setTimeout(tick,3000);
function stop(signal='SIGTERM'){if(stopping)return;stopping=true;clearInterval(timer);server.kill(signal);}
process.on('SIGINT',()=>stop('SIGINT'));process.on('SIGTERM',()=>stop());
server.on('exit',code=>{clearInterval(timer);process.exit(code??0);});
