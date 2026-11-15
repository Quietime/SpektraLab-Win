//! Per-user loopback bridge to the very same webview session used by the UI.
//! Disabled by default, authenticated by an OS-random token, rechecked for
//! every call. There is no remote listener or separate rendering pipeline.
use std::{collections::HashMap,io::{BufRead,BufReader,Read,Write},net::{TcpListener,TcpStream},
    path::{Path,PathBuf},sync::{Arc,Mutex,atomic::{AtomicBool,AtomicU64,Ordering}},time::{Duration,Instant}};
use serde_json::{json,Value};
use tauri::{AppHandle,Emitter,Manager,State};

pub struct Bridge {
    app:AppHandle, directory:PathBuf, token:String, address:String,
    enabled:AtomicBool, ready:AtomicBool, next:AtomicU64,
    pending:Mutex<HashMap<u64,std::sync::mpsc::Sender<Value>>>,
}
fn private_write(path:&Path,value:&Value)->Result<(),String>{
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        let parent=path.parent().ok_or("Agent state has no parent directory")?;
        std::fs::create_dir_all(parent).map_err(|e|e.to_string())?;
        std::fs::set_permissions(parent,std::fs::Permissions::from_mode(0o700)).map_err(|e|e.to_string())?;
    }
    crate::files::write_atomic(path,&serde_json::to_vec(value).map_err(|e|e.to_string())?)?;
    #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(path,std::fs::Permissions::from_mode(0o600)).map_err(|e|e.to_string())?;}
    Ok(())
}
fn random_token()->Result<String,String>{
    let mut bytes=[0u8;32];
    #[cfg(windows)] {
        #[link(name="bcrypt")]
        extern "system" {fn BCryptGenRandom(algorithm:*mut std::ffi::c_void,bytes:*mut u8,length:u32,flags:u32)->i32;}
        // BCRYPT_USE_SYSTEM_PREFERRED_RNG, valid writable output buffer.
        if unsafe{BCryptGenRandom(std::ptr::null_mut(),bytes.as_mut_ptr(),32,2)}<0{return Err("System random generator failed".into());}
    }
    #[cfg(unix)] {std::fs::File::open("/dev/urandom").and_then(|mut f|f.read_exact(&mut bytes)).map_err(|e|e.to_string())?;}
    Ok(bytes.iter().map(|b|format!("{b:02x}")).collect())
}
fn refusal(message:&str)->Value{json!({"ok":false,"error":{"code":"refused","message":message}})}
impl Bridge {
    pub fn start(app:AppHandle)->Result<Arc<Self>,String>{
        let listener=TcpListener::bind((std::net::Ipv4Addr::LOCALHOST,0)).map_err(|e|e.to_string())?;
        let directory=app.path().app_data_dir().map_err(|e|e.to_string())?;
        let bridge=Arc::new(Self{address:listener.local_addr().map_err(|e|e.to_string())?.to_string(),
            app,directory,token:random_token()?,enabled:AtomicBool::new(false),ready:AtomicBool::new(false),
            next:AtomicU64::new(1),pending:Mutex::new(HashMap::new())});
        let server=Arc::clone(&bridge);
        let hidden=std::env::args().any(|a|a=="--agent-service");
        listener.set_nonblocking(true).map_err(|e|e.to_string())?;
        std::thread::spawn(move||{
            let mut last_call=Instant::now();
            loop {
                match listener.accept(){
                    Ok((mut stream,_))=>{
                        let _=stream.set_read_timeout(Some(Duration::from_secs(10)));
                        let _=stream.set_write_timeout(Some(Duration::from_secs(10)));
                        let reply=server.connection(&stream).unwrap_or_else(|e|refusal(&e));
                        if let Ok(mut bytes)=serde_json::to_vec(&reply){bytes.push(b'\n');let _=stream.write_all(&bytes);}
                        last_call=Instant::now();
                    }
                    Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>std::thread::sleep(Duration::from_millis(100)),
                    Err(_)=>break,
                }
                if hidden&&last_call.elapsed()>Duration::from_secs(120)&&
                    server.app.get_webview_window("main").is_some_and(|w|!w.is_visible().unwrap_or(true)){
                    server.app.exit(0);break;
                }
            }
        });
        Ok(bridge)
    }
    fn connection(&self,stream:&TcpStream)->Result<Value,String>{
        let mut bytes=Vec::new();
        BufReader::new(stream).take(8*1024*1024+1).read_until(b'\n',&mut bytes).map_err(|e|e.to_string())?;
        if bytes.len()>8*1024*1024{return Err("Agent request is too large".into());}
        let request:Value=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
        if request["token"].as_str()!=Some(&self.token){return Ok(refusal("Invalid agent token"));}
        if !self.ready.load(Ordering::SeqCst){return Ok(refusal("The session is starting"));}
        if !self.enabled.load(Ordering::SeqCst){return Ok(refusal("Access is off. Enable Settings > Agents."));}
        let id=self.next.fetch_add(1,Ordering::SeqCst);
        let (tx,rx)=std::sync::mpsc::channel();
        self.pending.lock().map_err(|e|e.to_string())?.insert(id,tx);
        if let Err(e)=self.app.emit("agent-request",json!({"id":id,"tool":request["tool"],"args":request["args"]})){
            self.pending.lock().map_err(|e|e.to_string())?.remove(&id);return Err(e.to_string());
        }
        let reply=rx.recv_timeout(Duration::from_secs(900)).map_err(|_|"Timed out waiting for the session".to_string());
        self.pending.lock().map_err(|e|e.to_string())?.remove(&id);reply
    }
    fn access(&self,enabled:bool)->Result<(),String>{
        // Revocation takes effect before persistence, even when disk is full.
        self.enabled.store(enabled,Ordering::SeqCst);
        if let Err(error)=private_write(&self.directory.join("agent-access.json"),&json!({"enabled":enabled})){
            self.enabled.store(false,Ordering::SeqCst);return Err(error);
        }
        Ok(())
    }
}
#[tauri::command]
pub fn agent_ready(bridge:State<'_,Arc<Bridge>>,enabled:bool)->Result<(),String>{
    bridge.access(enabled)?;
    bridge.ready.store(true,Ordering::SeqCst);
    if let Err(error)=private_write(&bridge.directory.join("agent-endpoint.json"),&json!({"address":bridge.address,"token":bridge.token})){
        bridge.ready.store(false,Ordering::SeqCst);return Err(error);
    }
    Ok(())
}
#[tauri::command]
pub fn agent_set_access(bridge:State<'_,Arc<Bridge>>,enabled:bool)->Result<(),String>{bridge.access(enabled)}
#[tauri::command]
pub fn agent_reply(bridge:State<'_,Arc<Bridge>>,id:u64,reply:Value){
    if let Ok(mut pending)=bridge.pending.lock(){if let Some(sender)=pending.remove(&id){let _=sender.send(reply);}}
}
