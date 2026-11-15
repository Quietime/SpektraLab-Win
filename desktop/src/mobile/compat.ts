// Android 10 can ship an older system WebView. Keep JSON recipe operations
// usable there; native rendering and binary pixels never use these shims.
import {inAndroid} from './bridge';
if(inAndroid()){
 if(!Array.prototype.at)Object.defineProperty(Array.prototype,'at',{value:function(this:unknown[],index:number){const i=Math.trunc(index)||0;return this[i<0?this.length+i:i];},writable:true,configurable:true});
 if(!String.prototype.replaceAll)Object.defineProperty(String.prototype,'replaceAll',{value:function(this:string,search:string|RegExp,replacement:string){if(typeof search==='string')return String(this).split(search).join(replacement);if(!search.global)throw new TypeError('replaceAll needs a global expression');return String(this).replace(search,replacement);},writable:true,configurable:true});
 if(!Object.hasOwn)Object.hasOwn=(object:object,key:PropertyKey)=>Object.prototype.hasOwnProperty.call(object,key);
 if(!globalThis.structuredClone){const clone=(value:unknown):unknown=>Array.isArray(value)?value.map(clone):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clone(item)])):value;globalThis.structuredClone=clone as typeof structuredClone;}
}
