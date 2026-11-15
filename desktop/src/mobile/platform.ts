import type {Platform} from '../platform';
import {androidCall} from './bridge';
export function androidPlatform():Platform {
 return {kind:'tauri',
  listImages:dir=>androidCall('list_images',{dir}),expandPaths:paths=>androidCall('expand_paths',{paths}),
  sidecarLoad:image=>androidCall('sidecar_load',{image}),sidecarSave:(image,sidecar)=>androidCall('sidecar_save',{image,sidecar}),sidecarPath:image=>androidCall('sidecar_path',{image}),
  pairLoad:path=>androidCall('pair_load',{path}),pairSave:(path,value)=>androidCall('pair_save',{path,value}),pairCreate:(folder,value)=>androidCall('pair_create',{folder,value}),
  storeRead:(area,name)=>androidCall('store_read',{area,name}),storeWrite:(area,name,value)=>androidCall('store_write',{area,name,value}),
  storeDelete:(area,name)=>{
   if(area!=='LightTable'||!/^tray-[A-Za-z0-9_-]{1,40}-(?:photos|cards)-[A-Za-z0-9_-]+-[0-9]+\.json$/.test(name))return Promise.reject(new Error('Refusing to delete an unmanaged store value'));
   return androidCall('store_delete',{area,name});
  },
  takeLaunchPaths:()=>androidCall('take_launch_paths'),pathExists:path=>androidCall('path_exists',{path}),ensureDir:path=>androidCall('ensure_dir',{path}),
  appPaths:()=>androidCall('app_paths'),pickFolder:title=>androidCall('pick_folder',{title}),pickFiles:title=>androidCall('pick_files',{title}),pickSave:(title,defaultPath,ext)=>androidCall('pick_save',{title,defaultPath,ext}),
  reveal:path=>androidCall('reveal',{path}),openFile:(path,chooseApplication=false)=>androidCall('open_file',{path,chooseApplication}),openUrl:url=>androidCall('open_url',{url}),
  async message(title,text){await androidCall('message',{title,text});},confirm:(title,text)=>androidCall('confirm',{title,text}),
  onOpenPaths(){return()=>{};},onDrop(){return()=>{};},async setTitle(){},log(level,message){console[level==='warn'?'warn':level==='error'?'error':'info'](message);},async toggleFullscreen(){await androidCall('fullscreen');}
 };
}
