// Check actual linked PE bytes, not just a successful Cargo exit status.
import {readFileSync,readdirSync,existsSync,writeFileSync} from 'node:fs';
import {brotliDecompressSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const target=resolve(root,'desktop/src-tauri/target/x86_64-pc-windows-gnu/release');
const exe=readFileSync(resolve(target,'spektralab.exe'));
if(!exe.includes(Buffer.from('SPEKTRALAB_EMBEDDED_UI_V1')))throw Error('Missing embedded UI release marker');
const dist=resolve(root,'desktop/dist');
const inputs=readdirSync(dist,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>({name:e.name,raw:readFileSync(resolve(e.parentPath,e.name))}));
let verified=0;
for(const dir of readdirSync(resolve(target,'build'))){
 if(!dir.startsWith('spektralab-'))continue;
 const assets=resolve(target,'build',dir,'out/tauri-codegen-assets');
 if(!existsSync(assets))continue;
 // Cargo retains old content-addressed blobs in this directory. Validate
 // the blobs linked into this PE, then require every current dist input.
 const compressed=readdirSync(assets).map(n=>readFileSync(resolve(assets,n))).filter(b=>exe.includes(b));
 if(!compressed.length)continue;
 const decoded=compressed.map(b=>brotliDecompressSync(b));
 const html=decoded.find(b=>b.includes(Buffer.from('id="root"')))?.toString();
 if(!html)continue;
 let count=0,complete=true;
 for(const input of inputs){
  if(input.name==='index.html'){
   const scripts=[...input.raw.toString().matchAll(/(?:src|href)="([^"]+)"/g)].map(m=>m[1]);
   if(!scripts.every(s=>html.includes(s))){complete=false;break;}
  }else if(!decoded.some(b=>b.equals(input.raw))){complete=false;break;}
  count++;
 }
 if(complete){verified=count;break;}
}
if(!verified)throw Error('No complete embedded frontend found in final EXE');
const receipt={embedded_files_verified:verified,sha256:createHash('sha256').update(exe).digest('hex'),custom_protocol:true,real_windows_gui_tested:false};
writeFileSync(resolve(root,'artifacts/WINDOWS133-EMBEDDED-UI-CHECK.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt,null,2));
