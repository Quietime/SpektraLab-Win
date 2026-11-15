//! Signed, channel-pinned Windows updates. The webview cannot provide an update
//! URL or path; only a verified manifest can select a managed installer.
use serde_json::{json, Value};

pub const BUILD: u64 = 13304;
const CHANNEL: &str = "windows-x64";
const ASSET: &str = "SpektraLab-Windows-x64-Setup.exe";
const PREFIX: &str = "https://github.com/Quietime/SpektraLab-Win/releases/download/";
const RELEASE: &str = "https://api.github.com/repos/Quietime/SpektraLab-Win/releases/latest";
const MAX_PACKAGE: u64 = 512 * 1024 * 1024;
const RELEASE_NOT_FOUND: &str = "Update server returned HTTP 404";
const PUBLIC_KEY: &str = include_str!("../../../distribution/updater/public-key.json");

fn hex_bytes(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 || !s.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Malformed hex data".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

fn release_download_url(url: &str, expected_name: &str) -> Result<(), String> {
    let tail = url.strip_prefix(PREFIX).ok_or("Unexpected release asset URL")?;
    let (tag, name) = tail.split_once('/').ok_or("Unexpected release asset URL")?;
    if tag.is_empty() || tag == "." || tag == ".." || name != expected_name
        || !tag.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.')) {
        return Err("Unexpected release asset URL".into());
    }
    Ok(())
}

fn release_json(result: Result<Vec<u8>, String>) -> Result<Option<Value>, String> {
    match result {
        Err(e) if e == RELEASE_NOT_FOUND => Ok(None),
        Err(e) => Err(e),
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| e.to_string()),
    }
}

fn asset(manifest: &[u8], newer: bool) -> Result<Value, String> {
    let v: Value = serde_json::from_slice(manifest).map_err(|e| e.to_string())?;
    if v["schema"].as_u64() != Some(1) {
        return Err("Unsupported update schema".into());
    }
    let build = v["build"].as_u64().ok_or("Invalid update build")?;
    if build == 0 || build > i32::MAX as u64 {
        return Err("Update build is out of range".into());
    }
    if newer && build <= BUILD {
        return Err("Update is not newer than installed build".into());
    }
    if v["version"].as_str().filter(|s| !s.is_empty()).is_none() {
        return Err("Invalid update version".into());
    }
    for channel in ["windows-x64", "android-phone-arm64", "android-tablet-arm64"] {
        if v["channels"].get(channel).and_then(Value::as_object).is_none() {
            return Err(format!("Missing release channel {channel}"));
        }
    }
    let a = v["channels"].get(CHANNEL).ok_or("Missing Windows update channel")?;
    if a["name"].as_str() != Some(ASSET) {
        return Err("Unexpected Windows installer filename".into());
    }
    let url = a["url"].as_str().ok_or("Missing installer URL")?;
    release_download_url(url, ASSET)?;
    for field in ["sha256", "installed_sha256"] {
        let digest = a[field].as_str().ok_or_else(|| format!("Missing {field}"))?;
        if hex_bytes(digest)?.len() != 32 {
            return Err(format!("Invalid {field}"));
        }
    }
    let size = a["bytes"].as_u64().ok_or("Invalid installer size")?;
    if size == 0 || size > MAX_PACKAGE {
        return Err("Installer size is out of range".into());
    }
    Ok(v)
}

fn response(v: &Value, ready: bool) -> Value {
    let a = &v["channels"][CHANNEL];
    json!({"channel":CHANNEL,"current_build":BUILD,"available":v["build"].as_u64().unwrap_or(0)>BUILD,
        "version":v["version"],"build":v["build"],"bytes":a["bytes"],"notes":v["notes"],
        "url":a["url"],"ready":ready})
}
fn unavailable(error: impl Into<String>) -> Value {
    json!({"channel":CHANNEL,"current_build":BUILD,"available":false,"ready":false,"error":error.into()})
}
fn no_release() -> Value {
    json!({"channel":CHANNEL,"current_build":BUILD,"available":false,"ready":false})
}
fn up_to_date(v: &Value) -> Option<Value> {
    (v["build"].as_u64()? <= BUILD).then(|| response(v, false))
}
fn remote_failure(error: String, staged: Option<&Value>) -> Value {
    if let Some(v) = staged {
        let mut status = response(v, true);
        status["error"] = json!(error);
        status
    } else {
        unavailable(error)
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{ffi::c_void, fs::{self, File}, io::{Read, Write}, os::windows::ffi::OsStringExt,
        os::windows::process::CommandExt, path::{Path, PathBuf}, ptr, process::Command,
        sync::{Arc, Mutex}, time::Duration};
    use tauri::Manager;

    static STAGING_LOCK: Mutex<()> = Mutex::new(());
    type Handle = *mut c_void;
    #[link(name = "winhttp")]
    extern "system" {
        fn WinHttpOpen(agent:*const u16,access:u32,proxy:*const u16,bypass:*const u16,flags:u32)->Handle;
        fn WinHttpConnect(session:Handle,server:*const u16,port:u16,reserved:u32)->Handle;
        fn WinHttpOpenRequest(connection:Handle,verb:*const u16,path:*const u16,version:*const u16,referer:*const u16,accept:*const *const u16,flags:u32)->Handle;
        fn WinHttpSetTimeouts(handle:Handle,resolve:i32,connect:i32,send:i32,receive:i32)->i32;
        fn WinHttpSetOption(handle:Handle,option:u32,buffer:*const c_void,length:u32)->i32;
        fn WinHttpSendRequest(request:Handle,headers:*const u16,length:u32,body:*const c_void,body_bytes:u32,total:u32,context:usize)->i32;
        fn WinHttpReceiveResponse(request:Handle,reserved:*mut c_void)->i32;
        fn WinHttpQueryHeaders(request:Handle,level:u32,name:*const u16,buffer:*mut c_void,length:*mut u32,index:*mut u32)->i32;
        fn WinHttpReadData(request:Handle,buffer:*mut c_void,length:u32,read:*mut u32)->i32;
        fn WinHttpCloseHandle(handle:Handle)->i32;
    }
    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptOpenAlgorithmProvider(alg:*mut Handle,id:*const u16,implementation:*const u16,flags:u32)->i32;
        fn BCryptImportKeyPair(alg:Handle,import:Handle,kind:*const u16,key:*mut Handle,input:*const u8,len:u32,flags:u32)->i32;
        fn BCryptVerifySignature(key:Handle,padding:*const c_void,hash:*const u8,hash_len:u32,signature:*const u8,sig_len:u32,flags:u32)->i32;
        fn BCryptDestroyKey(key:Handle)->i32;
        fn BCryptCloseAlgorithmProvider(alg:Handle,flags:u32)->i32;
    }
    #[repr(C)]
    struct Pkcs1Info { algorithm: *const u16 }
    struct Http(Handle);
    impl Drop for Http { fn drop(&mut self) { unsafe { WinHttpCloseHandle(self.0); } } }
    fn wide(s:&str)->Vec<u16>{s.encode_utf16().chain(Some(0)).collect()}
    fn ok(v:i32)->Result<(),String>{if v==0 {Err(std::io::Error::last_os_error().to_string())}else{Ok(())}}
    fn owned(h:Handle)->Result<Http,String>{if h.is_null(){Err(std::io::Error::last_os_error().to_string())}else{Ok(Http(h))}}
    fn url_parts(url:&str)->Result<(&str,&str),String>{
        let rest=url.strip_prefix("https://").ok_or("Update URL must use HTTPS")?;
        let (host,path)=rest.split_once('/').ok_or("Invalid update URL")?;
        if host.is_empty() || host.chars().any(|c| matches!(c, ':' | '@' | '\\'))
            || path.chars().any(|c| matches!(c, '\\' | '#' | '?')) {
            return Err("Invalid update URL".into());
        }
        Ok((host,path))
    }
    fn download(url:&str,limit:u64,mut write:impl FnMut(&[u8])->Result<(),String>)->Result<u64,String>{
        let (host,path)=url_parts(url)?;
        let (host,path)=(wide(host),wide(&format!("/{path}")));
        let agent=wide("SpektraLab-Updater/1");let get=wide("GET");
        let headers=wide("Accept: application/vnd.github+json\r\nX-GitHub-Api-Version: 2022-11-28\r\n");
        unsafe {
            // Windows 10 automatic proxy resolution includes configured PAC.
            let session=owned(WinHttpOpen(agent.as_ptr(),4,ptr::null(),ptr::null(),0))?;
            ok(WinHttpSetTimeouts(session.0,8000,8000,15000,30000))?;
            let conn=owned(WinHttpConnect(session.0,host.as_ptr(),443,0))?;
            let req=owned(WinHttpOpenRequest(conn.0,get.as_ptr(),path.as_ptr(),ptr::null(),ptr::null(),ptr::null(),0x00800000))?;
            // Allow GitHub CDN redirects, but refuse an HTTPS to HTTP downgrade.
            let redirect_policy:u32=1;
            ok(WinHttpSetOption(req.0,88,(&redirect_policy as *const u32).cast(),4))?;
            // WINHTTP_OPTION_MAX_HTTP_AUTOMATIC_REDIRECTS (winhttp.h = 89).
            let max_redirects:u32=5;
            ok(WinHttpSetOption(req.0,89,(&max_redirects as *const u32).cast(),4))?;
            ok(WinHttpSendRequest(req.0,headers.as_ptr(),(headers.len()-1) as u32,ptr::null(),0,0,0))?;
            ok(WinHttpReceiveResponse(req.0,ptr::null_mut()))?;
            let mut status=0u32;let mut len=4u32;
            ok(WinHttpQueryHeaders(req.0,19|0x20000000,ptr::null(),(&mut status as *mut u32).cast(),&mut len,ptr::null_mut()))?;
            if status!=200 {return Err(format!("Update server returned HTTP {status}"));}
            let mut total=0u64;let mut buffer=[0u8;65536];
            loop {
                let mut read=0;
                ok(WinHttpReadData(req.0,buffer.as_mut_ptr().cast(),buffer.len() as u32,&mut read))?;
                if read==0 {break;}
                total+=read as u64;
                if total>limit {return Err("Update download exceeds size limit".into());}
                write(&buffer[..read as usize])?;
            }
            Ok(total)
        }
    }
    fn fetch(url:&str,limit:u64)->Result<Vec<u8>,String>{
        let mut v=Vec::new();download(url,limit,|chunk|{v.extend_from_slice(chunk);Ok(())})?;Ok(v)
    }
    pub(super) fn verify(manifest:&[u8],signature_hex:&[u8])->Result<(),String>{
        let s=std::str::from_utf8(signature_hex).map_err(|e|e.to_string())?.trim();
        let signature=hex_bytes(s)?;
        if signature.len()!=384 {return Err("Invalid update signature length".into());}
        let key:Value=serde_json::from_str(PUBLIC_KEY).map_err(|e|e.to_string())?;
        if key["algorithm"].as_str()!=Some("RSA-PKCS1-SHA256") {return Err("Invalid public key algorithm".into());}
        let modulus=hex_bytes(key["modulus"].as_str().ok_or("Missing public modulus")?)?;
        let exponent=hex_bytes(key["exponent"].as_str().ok_or("Missing public exponent")?)?;
        if modulus.len()!=384 || exponent.is_empty() {return Err("Invalid public key".into());}
        let mut blob=Vec::with_capacity(24+exponent.len()+modulus.len());
        for n in [0x31415352u32,3072,exponent.len() as u32,modulus.len() as u32,0,0] {
            blob.extend_from_slice(&n.to_le_bytes());
        }
        blob.extend_from_slice(&exponent);blob.extend_from_slice(&modulus);
        unsafe {
            let mut alg=ptr::null_mut();let mut imported=ptr::null_mut();
            let rsa=wide("RSA");let blob_kind=wide("RSAPUBLICBLOB");let sha=wide("SHA256");
            if BCryptOpenAlgorithmProvider(&mut alg,rsa.as_ptr(),ptr::null(),0)!=0 {
                return Err("Cannot open Windows RSA provider".into());
            }
            let result=(||{
                if BCryptImportKeyPair(alg,ptr::null_mut(),blob_kind.as_ptr(),&mut imported,blob.as_ptr(),blob.len() as u32,0)!=0 {
                    return Err("Cannot import update public key".into());
                }
                let info=Pkcs1Info{algorithm:sha.as_ptr()};let digest=Sha256::digest(manifest);
                if BCryptVerifySignature(imported,(&info as *const Pkcs1Info).cast(),digest.as_ptr(),32,signature.as_ptr(),384,2)!=0 {
                    return Err("Update signature verification failed".into());
                }
                Ok(())
            })();
            if !imported.is_null(){BCryptDestroyKey(imported);}
            BCryptCloseAlgorithmProvider(alg,0);
            result
        }
    }
    pub(super) fn release_asset(release:&Value,name:&str)->Result<String,String>{
        if release["draft"].as_bool()!=Some(false) || release["prerelease"].as_bool()!=Some(false) {
            return Err("No published stable update".into());
        }
        let list=release["assets"].as_array().ok_or("Release has no assets")?;
        let matches:Vec<_>=list.iter().filter(|a|a["name"].as_str()==Some(name)).collect();
        if matches.len()!=1 {return Err(format!("Release must contain one {name}"));}
        let url=matches[0]["browser_download_url"].as_str().ok_or("Missing asset URL")?;
        release_download_url(url,name)?;
        Ok(url.into())
    }
    fn remote()->Result<Option<(Vec<u8>,Vec<u8>,Value)>,String>{
        // Only the release endpoint's 404 means no publication. A missing
        // manifest or signature remains an error and cannot be trusted.
        let Some(r)=release_json(fetch(RELEASE,1024*1024))? else {return Ok(None);};
        let manifest=fetch(&release_asset(&r,"updates.json")?,65536)?;
        let signature=fetch(&release_asset(&r,"updates.json.sig")?,4096)?;
        verify(&manifest,&signature)?;
        let parsed=asset(&manifest,false)?;
        Ok(Some((manifest,signature,parsed)))
    }
    fn managed(app:&tauri::AppHandle)->Result<PathBuf,String>{
        Ok(app.path().app_cache_dir().map_err(|e|e.to_string())?.join("Updates"))
    }
    fn hash_file(path:&Path)->Result<[u8;32],String>{
        let mut f=File::open(path).map_err(|e|e.to_string())?;
        let mut h=Sha256::new();let mut b=[0u8;65536];
        loop {let n=f.read(&mut b).map_err(|e|e.to_string())?;if n==0{break;}h.update(&b[..n]);}
        Ok(h.finalize().into())
    }
    fn write_file(path:&Path,bytes:&[u8])->Result<(),String>{
        let mut f=File::create(path).map_err(|e|e.to_string())?;
        f.write_all(bytes).map_err(|e|e.to_string())?;
        f.sync_all().map_err(|e|e.to_string())
    }
    const MAX_LOADER_BYTES:u64=16*1024*1024;
    pub(super) fn stage_helper_loader(installed_dir:&Path,managed_dir:&Path)->Result<(),String>{
        let installed=installed_dir.join("WebView2Loader.dll");
        let metadata=fs::symlink_metadata(&installed)
            .map_err(|e|format!("Installed WebView2Loader.dll is missing: {e}"))?;
        if !metadata.file_type().is_file() || metadata.len()<2 || metadata.len()>MAX_LOADER_BYTES {
            return Err("Installed WebView2Loader.dll is not a bounded regular file".into());
        }
        let mut input=File::open(&installed).map_err(|e|format!("Cannot read installed WebView2Loader.dll: {e}"))?;
        let partial=managed_dir.join("WebView2Loader.dll.partial");
        let staged=managed_dir.join("WebView2Loader.dll");
        let _=fs::remove_file(&partial);
        let result=(||{
            let mut output=File::create(&partial).map_err(|e|format!("Cannot stage WebView2Loader.dll: {e}"))?;
            let mut magic=[0u8;2];input.read_exact(&mut magic).map_err(|e|e.to_string())?;
            if magic!=*b"MZ" {return Err("Installed WebView2Loader.dll is not a PE file".into());}
            output.write_all(&magic).map_err(|e|e.to_string())?;
            let mut total=2u64;let mut buffer=[0u8;65536];
            loop {
                let n=input.read(&mut buffer).map_err(|e|e.to_string())?;
                if n==0 {break;}
                total+=n as u64;
                if total>MAX_LOADER_BYTES {return Err("WebView2Loader.dll exceeds the staging limit".into());}
                output.write_all(&buffer[..n]).map_err(|e|e.to_string())?;
            }
            if total!=metadata.len(){return Err("WebView2Loader.dll changed during staging".into());}
            output.sync_all().map_err(|e|e.to_string())?;drop(output);
            if hash_file(&installed)?!=hash_file(&partial)? {
                return Err("WebView2Loader.dll changed during staging".into());
            }
            let _=fs::remove_file(&staged);
            fs::rename(&partial,&staged).map_err(|e|format!("Cannot finalize WebView2Loader.dll: {e}"))
        })();
        if result.is_err(){let _=fs::remove_file(&partial);}
        result
    }
    pub(super) fn load_ready(dir:&Path)->Result<(Value,PathBuf),String>{
        if !dir.join("ready").is_file(){return Err("No prepared update".into());}
        let manifest=fs::read(dir.join("updates.json")).map_err(|e|e.to_string())?;
        let signature=fs::read(dir.join("updates.json.sig")).map_err(|e|e.to_string())?;
        if manifest.len()>65536 || signature.len()>4096 {return Err("Staged metadata exceeds limit".into());}
        verify(&manifest,&signature)?;
        let v=asset(&manifest,true)?;
        let package=dir.join(ASSET);
        let size=v["channels"][CHANNEL]["bytes"].as_u64().unwrap();
        if fs::metadata(&package).map_err(|e|e.to_string())?.len()!=size {
            return Err("Staged installer size changed".into());
        }
        let digest=hash_file(&package)?;
        let expected=hex_bytes(v["channels"][CHANNEL]["sha256"].as_str().unwrap())?;
        if digest.as_slice()!=expected.as_slice(){return Err("Staged installer digest changed".into());}
        Ok((v,package))
    }
    pub fn check(app:tauri::AppHandle)->Value{
        let _lock=match STAGING_LOCK.lock(){Ok(lock)=>lock,Err(e)=>return unavailable(e.to_string())};
        match remote(){
            Ok(None)=>no_release(),
            Ok(Some((_,_,v)))=>{
                if v["build"].as_u64().unwrap()<=BUILD {return response(&v,false);}
                let mut result=response(&v,false);
                if let Ok(dir)=managed(&app){if let Ok((staged,_))=load_ready(&dir){
                    if staged["build"]==v["build"]{result["ready"]=json!(true);}
                }}
                result
            },
            Err(e)=>{
                let staged=managed(&app).ok().and_then(|dir|load_ready(&dir).ok().map(|(v,_)|v));
                remote_failure(e,staged.as_ref())
            }
        }
    }
    pub fn prepare(app:tauri::AppHandle)->Result<Value,String>{
        let _lock=STAGING_LOCK.lock().map_err(|e|e.to_string())?;
        let (manifest,signature,v)=remote()?.ok_or("No published update")?;
        if let Some(status)=up_to_date(&v){return Ok(status);}
        asset(&manifest,true)?;
        let dir=managed(&app)?;fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
        let _=fs::remove_file(dir.join("ready"));
        let partial=dir.join("installer.partial");let _=fs::remove_file(&partial);
        let result=(||{
            let mut f=File::create(&partial).map_err(|e|e.to_string())?;
            let mut h=Sha256::new();let a=&v["channels"][CHANNEL];
            let expected_size=a["bytes"].as_u64().unwrap();
            let count=download(a["url"].as_str().unwrap(),expected_size,|part|{
                h.update(part);f.write_all(part).map_err(|e|e.to_string())
            })?;
            f.sync_all().map_err(|e|e.to_string())?;drop(f);
            if count!=expected_size || h.finalize().as_slice()!=hex_bytes(a["sha256"].as_str().unwrap())?.as_slice(){
                return Err("Downloaded installer failed size or digest check".into());
            }
            let package=dir.join(ASSET);let _=fs::remove_file(&package);
            fs::rename(&partial,&package).map_err(|e|e.to_string())?;
            write_file(&dir.join("updates.json.tmp"),&manifest)?;
            write_file(&dir.join("updates.json.sig.tmp"),&signature)?;
            let _=fs::remove_file(dir.join("updates.json"));let _=fs::remove_file(dir.join("updates.json.sig"));
            fs::rename(dir.join("updates.json.tmp"),dir.join("updates.json")).map_err(|e|e.to_string())?;
            fs::rename(dir.join("updates.json.sig.tmp"),dir.join("updates.json.sig")).map_err(|e|e.to_string())?;
            write_file(&dir.join("ready.tmp"),b"ready")?;
            fs::rename(dir.join("ready.tmp"),dir.join("ready")).map_err(|e|e.to_string())?;
            Ok(response(&v,true))
        })();
        if result.is_err(){let _=fs::remove_file(&partial);let _=fs::remove_file(dir.join("ready"));}
        result
    }
    pub fn install(app:tauri::AppHandle,host:Arc<crate::host::HostManager>)->Result<Value,String>{
        let _lock=STAGING_LOCK.lock().map_err(|e|e.to_string())?;
        let dir=managed(&app)?;let (v,_)=load_ready(&dir)?;
        let exe=std::env::current_exe().map_err(|e|e.to_string())?;
        if exe.file_name().and_then(|s|s.to_str()).map(|s|s.eq_ignore_ascii_case("SpektraLab-Windows.exe"))!=Some(true){
            return Err("Cannot locate installed SpektraLab executable".into());
        }
        let installed_dir=exe.parent().ok_or("Invalid installation directory")?;
        stage_helper_loader(installed_dir,&dir)?;
        let helper=dir.join("SpektraLab-UpdateHelper.exe");let _=fs::remove_file(&helper);
        fs::copy(&exe,&helper).map_err(|e|e.to_string())?;
        let acknowledgement=dir.join("helper-ready");let _=fs::remove_file(&acknowledgement);
        let mut child=Command::new(&helper).current_dir(installed_dir).arg("--spektralab-update-helper")
            .arg(std::process::id().to_string()).spawn().map_err(|e|e.to_string())?;
        let expected=std::process::id().to_string();let mut acknowledged=false;
        for _ in 0..100 {
            if fs::read_to_string(&acknowledgement).ok().as_deref()==Some(expected.as_str()){
                acknowledged=true;break;
            }
            if let Some(status)=child.try_wait().map_err(|e|e.to_string())? {
                return Err(format!("Update helper exited before setup: {status}"));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if !acknowledged {let _=child.kill();let _=child.wait();return Err("Update helper did not initialize".into());}
        if let Some(status)=child.try_wait().map_err(|e|e.to_string())? {
            return Err(format!("Update helper exited before setup: {status}"));
        }
        tauri::async_runtime::block_on(async move{host.shutdown().await});
        app.exit(0);
        Ok(response(&v,true))
    }
    pub fn helper()->Option<i32>{
        let args:Vec<_>=std::env::args_os().collect();
        if args.get(1).map(|a|a.to_string_lossy()=="--spektralab-update-helper")!=Some(true){return None;}
        Some((||->Result<(),String>{
            if args.len()!=3{return Err("Invalid helper arguments".into());}
            let pid:u32=args[2].to_string_lossy().parse().map_err(|_|"Invalid parent PID")?;
            let (exe,parent)=process_image(pid)?;
            if exe.file_name().and_then(|s|s.to_str()).map(|s|s.eq_ignore_ascii_case("SpektraLab-Windows.exe"))!=Some(true){
                return Err("Invalid installed executable".into());
            }
            let helper=std::env::current_exe().map_err(|e|e.to_string())?;
            let dir=helper.parent().ok_or("Invalid helper location")?;
            if helper.file_name().and_then(|s|s.to_str())!=Some("SpektraLab-UpdateHelper.exe") {
                return Err("Invalid helper executable".into());
            }
            let _=load_ready(dir)?;
            write_file(&dir.join("helper-ready"),pid.to_string().as_bytes())?;
            wait_pid(&parent)?;
            // Revalidate after the old process exits, closing the staging race.
            let (v,package)=load_ready(dir)?;
            let install_dir=exe.parent().ok_or("Invalid installation directory")?;
            let mut destination=std::ffi::OsString::from("/D=");
            destination.push(install_dir.as_os_str());
            let status=Command::new(&package).current_dir(install_dir).arg("/S")
                .raw_arg(destination)
                .status().map_err(|e|e.to_string())?;
            if !status.success(){return Err(format!("Installer exited with {status}"));}
            if !exe.is_file(){return Err("Installed executable missing after update".into());}
            let expected=hex_bytes(v["channels"][CHANNEL]["installed_sha256"].as_str().unwrap())?;
            if hash_file(&exe)?.as_slice()!=expected.as_slice(){
                return Err("Installed executable digest does not match signed update".into());
            }
            let _=fs::remove_file(package);
            let _=fs::remove_file(dir.join("ready"));
            let _=fs::remove_file(dir.join("helper-ready"));
            Command::new(&exe).current_dir(install_dir).spawn().map_err(|e|e.to_string())?;
            Ok(())
        })().map(|_|0).unwrap_or_else(|e|{eprintln!("SpektraLab update failed: {e}");1}))
    }
    struct Parent(Handle);
    impl Drop for Parent { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
    #[link(name="kernel32")]
    extern "system" { fn CloseHandle(handle:Handle)->i32; }
    fn wait_pid(parent:&Parent)->Result<(),String>{
        #[link(name="kernel32")]
        extern "system" { fn WaitForSingleObject(handle:Handle,ms:u32)->u32; }
        unsafe {if WaitForSingleObject(parent.0,120000)!=0 {
            return Err("Application did not exit for update".into());
        }}
        Ok(())
    }
    fn process_image(pid:u32)->Result<(PathBuf,Parent),String>{
        #[link(name="kernel32")]
        extern "system" {
            fn OpenProcess(access:u32,inherit:i32,pid:u32)->Handle;
            fn QueryFullProcessImageNameW(handle:Handle,flags:u32,name:*mut u16,size:*mut u32)->i32;
        }
        unsafe {
            let h=OpenProcess(0x101000,0,pid);
            if h.is_null(){return Err("Cannot inspect application process".into());}
            let parent=Parent(h);let mut name=[0u16;32768];let mut size=name.len() as u32;
            if QueryFullProcessImageNameW(h,0,name.as_mut_ptr(),&mut size)==0 {
                return Err("Cannot locate application executable".into());
            }
            Ok((PathBuf::from(std::ffi::OsString::from_wide(&name[..size as usize])),parent))
        }
    }
}

#[cfg(windows)]
pub fn run_update_helper_if_requested()->Option<i32>{windows::helper()}
#[cfg(not(windows))]
pub fn run_update_helper_if_requested()->Option<i32>{None}

#[tauri::command]
pub async fn check_updates(app:tauri::AppHandle)->Result<Value,String>{
    #[cfg(windows)] {
        return tauri::async_runtime::spawn_blocking(move||windows::check(app)).await.map_err(|e|e.to_string());
    }
    #[cfg(not(windows))] {let _=app;Ok(unavailable("Windows updates are unavailable on this platform"))}
}
#[tauri::command]
pub async fn update_prepare(app:tauri::AppHandle)->Result<Value,String>{
    #[cfg(windows)] {
        return tauri::async_runtime::spawn_blocking(move||windows::prepare(app)).await.map_err(|e|e.to_string())?;
    }
    #[cfg(not(windows))] {let _=app;Err("Windows updates are unavailable on this platform".into())}
}
#[tauri::command]
pub(crate) async fn update_install(app:tauri::AppHandle,state:tauri::State<'_,crate::AppState>)->Result<Value,String>{
    #[cfg(windows)] {
        let host=std::sync::Arc::clone(&state.host);
        return tauri::async_runtime::spawn_blocking(move||windows::install(app,host)).await.map_err(|e|e.to_string())?;
    }
    #[cfg(not(windows))] {let _=(app,state);Err("Windows updates are unavailable on this platform".into())}
}

#[cfg(test)]
mod tests {
    use super::*;
    fn manifest(build:Value,url:&str)->Vec<u8>{
        serde_json::to_vec(&json!({"schema":1,"build":build,"version":"test","channels":{
            (CHANNEL):{"name":ASSET,"url":url,"sha256":"a".repeat(64),
                "installed_sha256":"b".repeat(64),"bytes":42},
            "android-phone-arm64":{},"android-tablet-arm64":{}}})).unwrap()
    }
    #[test]
    fn rejects_wrong_channel_url_hash_size_and_downgrade(){
        let valid=format!("{PREFIX}v1/{ASSET}");
        assert!(asset(&manifest(json!(BUILD+1),&valid),true).is_ok());
        assert!(asset(&manifest(json!(BUILD),&valid),true).is_err());
        assert!(asset(&manifest(json!("13305"),&valid),true).is_err());
        for build in [json!(0), json!(-1), json!(true), json!(13305.5), json!(2147483648_u64)] {
            assert!(asset(&manifest(build,&valid),false).is_err());
        }
        assert!(asset(&manifest(json!(2147483647_u64),&valid),true).is_ok());
        assert!(asset(&manifest(json!(BUILD+1),"https://evil.example/setup.exe"),true).is_err());
        let mut v:Value=serde_json::from_slice(&manifest(json!(BUILD+1),&valid)).unwrap();
        v["channels"]=json!({});assert!(asset(&serde_json::to_vec(&v).unwrap(),true).is_err());
        let mut v:Value=serde_json::from_slice(&manifest(json!(BUILD+1),&valid)).unwrap();
        v["channels"].as_object_mut().unwrap().remove("android-tablet-arm64");
        assert!(asset(&serde_json::to_vec(&v).unwrap(),true).is_err());
        let mut v:Value=serde_json::from_slice(&manifest(json!(BUILD+1),&valid)).unwrap();
        v["channels"][CHANNEL]["installed_sha256"]=json!("bad");
        assert!(asset(&serde_json::to_vec(&v).unwrap(),true).is_err());
        v["channels"][CHANNEL]["installed_sha256"]=json!("b".repeat(64));
        v["channels"][CHANNEL]["bytes"]=json!(MAX_PACKAGE+1);
        assert!(asset(&serde_json::to_vec(&v).unwrap(),true).is_err());
    }
    #[test]
    fn published_current_or_older_build_is_up_to_date(){
        let url=format!("{PREFIX}v1/{ASSET}");
        for build in [BUILD-1,BUILD] {
            let v=asset(&manifest(json!(build),&url),false).unwrap();
            let status=response(&v,false);
            assert_eq!(status["available"],false);
            assert_eq!(status["ready"],false);
            assert_eq!(status["build"],build);
            assert!(status.get("error").is_none());
            let prepare_status=up_to_date(&v).unwrap();
            assert_eq!(prepare_status["available"],false);
            assert!(prepare_status.get("error").is_none());
        }
        let v=asset(&manifest(json!(BUILD+1),&url),false).unwrap();
        assert_eq!(response(&v,false)["available"],true);
        assert!(up_to_date(&v).is_none());
    }
    #[test]
    fn release_404_is_normal_and_other_errors_are_not(){
        assert!(release_json(Err(RELEASE_NOT_FOUND.into())).unwrap().is_none());
        assert!(release_json(Err("Update server returned HTTP 403".into())).is_err());
        let result=no_release();
        assert_eq!(result["available"],false);
        assert_eq!(result["ready"],false);
        assert!(result.get("error").is_none());
    }
    #[test]
    fn offline_result_keeps_a_verified_ready_status(){
        let url=format!("{PREFIX}v1/{ASSET}");
        let v=asset(&manifest(json!(BUILD+1),&url),true).unwrap();
        let result=remote_failure("network offline".into(),Some(&v));
        assert_eq!(result["available"],true);
        assert_eq!(result["ready"],true);
        assert_eq!(result["build"],BUILD+1);
        assert_eq!(result["error"],"network offline");
        let unavailable=remote_failure("network offline".into(),None);
        assert_eq!(unavailable["available"],false);
        assert_eq!(unavailable["ready"],false);
    }
    #[test]
    fn release_asset_url_requires_one_safe_tag_and_exact_name(){
        for name in [ASSET,"updates.json","updates.json.sig"] {
            assert!(release_download_url(&format!("{PREFIX}v1.3.3-lighttable.3/{name}"),name).is_ok());
            for url in [
                format!("{PREFIX}/{name}"), format!("{PREFIX}../{name}"),
                format!("{PREFIX}v1%2fother/{name}"), format!("{PREFIX}v1/extra/{name}"),
                format!("{PREFIX}v1/{name}?download=1"),
                format!("https://github.com:443/Quietime/SpektraLab-Win/releases/download/v1/{name}"),
                format!("https://github.com/Other/SpektraLab-Win/releases/download/v1/{name}"),
            ] {
                assert!(release_download_url(&url,name).is_err(),"{url}");
            }
        }
    }
    #[cfg(windows)]
    #[test]
    fn release_asset_lookup_uses_the_structural_url_rule(){
        let good=format!("{PREFIX}v1/updates.json");
        let release=json!({"draft":false,"prerelease":false,
            "assets":[{"name":"updates.json","browser_download_url":good}]});
        assert!(windows::release_asset(&release,"updates.json").is_ok());
        let bad=json!({"draft":false,"prerelease":false,
            "assets":[{"name":"updates.json","browser_download_url":format!("{PREFIX}v1/extra/updates.json")}]});
        assert!(windows::release_asset(&bad,"updates.json").is_err());
    }
    #[cfg(windows)]
    #[test]
    fn signed_offline_fixtures_are_verified_before_parsing(){
        use std::fs;
        let dir=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../distribution/updater/tests");
        let fixture=|name:&str|{
            let manifest=fs::read(dir.join(format!("{name}.json"))).unwrap();
            let signature=fs::read(dir.join(format!("{name}.json.sig"))).unwrap();
            (manifest,signature)
        };
        let (valid,sig)=fixture("valid");
        windows::verify(&valid,&sig).unwrap();
        asset(&valid,true).unwrap();
        for name in ["tampered","bad-signature"] {
            let (manifest,sig)=fixture(name);
            assert!(windows::verify(&manifest,&sig).is_err(),"{name} must fail signature validation");
        }
        for name in ["downgrade","same","fractional-build","unknown-schema","wrong-url",
            "oversize","bad-hash","missing-channel","wrong-name","missing-installed-hash"] {
            let (manifest,sig)=fixture(name);
            windows::verify(&manifest,&sig).unwrap();
            assert!(asset(&manifest,true).is_err(),"{name} must fail manifest validation");
        }
    }
    #[cfg(windows)]
    #[test]
    fn forged_ready_marker_cannot_authorize_an_executable(){
        use std::fs;
        let fixtures=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../distribution/updater/tests");
        let dir=std::env::temp_dir().join(format!("spektralab-update-test-{}",std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("ready"),b"ready").unwrap();
        fs::copy(fixtures.join("valid.json"),dir.join("updates.json")).unwrap();
        fs::copy(fixtures.join("valid.json.sig"),dir.join("updates.json.sig")).unwrap();
        let unrelated=dir.join("unrelated.exe");fs::write(&unrelated,b"must remain").unwrap();
        assert!(windows::load_ready(&dir).is_err());
        assert_eq!(fs::read(&unrelated).unwrap(),b"must remain");
        fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn helper_loader_staging_requires_a_bounded_adjacent_dll(){
        use std::fs;
        let root=std::env::temp_dir().join(format!("spektralab-helper-loader-test-{}",std::process::id()));
        let installed=root.join("installed");let managed=root.join("managed");
        fs::create_dir_all(&installed).unwrap();fs::create_dir_all(&managed).unwrap();
        let unrelated=managed.join("unrelated.exe");fs::write(&unrelated,b"keep").unwrap();
        assert!(windows::stage_helper_loader(&installed,&managed).is_err());
        assert!(!managed.join("WebView2Loader.dll").exists());
        let source=installed.join("WebView2Loader.dll");
        fs::write(&source,b"MZtest-loader-bytes").unwrap();
        windows::stage_helper_loader(&installed,&managed).unwrap();
        assert_eq!(fs::read(managed.join("WebView2Loader.dll")).unwrap(),fs::read(&source).unwrap());
        assert_eq!(fs::read(&unrelated).unwrap(),b"keep");
        let staged_before=fs::read(managed.join("WebView2Loader.dll")).unwrap();
        fs::File::create(&source).unwrap().set_len(16*1024*1024+1).unwrap();
        assert!(windows::stage_helper_loader(&installed,&managed).is_err());
        assert_eq!(fs::read(managed.join("WebView2Loader.dll")).unwrap(),staged_before);
        fs::remove_file(&source).unwrap();
        assert!(windows::stage_helper_loader(&installed,&managed).is_err());
        assert_eq!(fs::read(managed.join("WebView2Loader.dll")).unwrap(),staged_before);
        assert_eq!(fs::read(&unrelated).unwrap(),b"keep");
        fs::remove_dir_all(root).unwrap();
    }
}
