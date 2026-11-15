//! CLI and MCP are two spellings of the Mac tool catalog. Calls are relayed
//! to the UI session over the authenticated per-user loopback bridge.
use std::{io::{BufRead,BufReader,Read,Write},path::{Path,PathBuf},time::{Duration,Instant}};
use serde_json::{json,Value};
const CATALOG:&str=include_str!("../../src/agent/tools.json");
const USAGE:&str="SpektraLab <status|schema|stocks|recipes|info|get|edit|reset|process|latitude|place|preview|export|mcp> [file] [options]\nedit: --patch JSON|@file|- [--preview out.jpg]\nplace: --highlight S --shadow S\npreview: -o out.jpg [--long-edge N]\nexport: [--recipe NAME] [--to DIR]\nAccess is off until enabled in Settings > Agents.\n";
pub fn usage()->&'static str{USAGE}
fn data_directory(identifier:&str)->Result<PathBuf,String>{
    #[cfg(windows)] let base=std::env::var_os("APPDATA").map(PathBuf::from).ok_or("APPDATA is unavailable")?;
    #[cfg(target_os="linux")] let base=std::env::var_os("XDG_DATA_HOME").map(PathBuf::from)
        .or_else(||std::env::var_os("HOME").map(|p|PathBuf::from(p).join(".local/share"))).ok_or("User data directory is unavailable")?;
    #[cfg(target_os="macos")] let base=std::env::var_os("HOME").map(|p|PathBuf::from(p).join("Library/Application Support")).ok_or("User data directory is unavailable")?;
    Ok(base.join(identifier))
}
fn read_json(path:&Path)->Option<Value>{serde_json::from_slice(&std::fs::read(path).ok()?).ok()}
fn access(directory:&Path)->bool{read_json(&directory.join("agent-access.json")).is_some_and(|v|v["enabled"]==true)}
fn absolute(path:&str)->Result<String,String>{
    let path=if let Some(tail)=path.strip_prefix("~/"){std::env::var_os("USERPROFILE").or_else(||std::env::var_os("HOME")).map(|p|PathBuf::from(p).join(tail)).ok_or("Home directory is unavailable")?}else{PathBuf::from(path)};
    Ok(if path.is_absolute(){path}else{std::env::current_dir().map_err(|e|e.to_string())?.join(path)}.display().to_string())
}
fn exchange(directory:&Path,tool:&str,args:Value)->Result<Value,String>{
    if !access(directory){return Err("Access is off. Enable Settings > Agents.".into());}
    let end=Instant::now()+Duration::from_secs(90);let mut launched=false;
    let mut stream=loop {
        if let Some(endpoint)=read_json(&directory.join("agent-endpoint.json")){
            if let Some(address)=endpoint["address"].as_str().and_then(|s|s.parse::<std::net::SocketAddr>().ok()).filter(|a|a.ip().is_loopback()){
                if let Ok(mut socket)=std::net::TcpStream::connect_timeout(&address,Duration::from_millis(500)){
                    socket.set_read_timeout(Some(Duration::from_secs(1000))).map_err(|e|e.to_string())?;
                    socket.set_write_timeout(Some(Duration::from_secs(10))).map_err(|e|e.to_string())?;
                    let mut request=serde_json::to_vec(&json!({"token":endpoint["token"],"tool":tool,"args":args})).map_err(|e|e.to_string())?;
                    request.push(b'\n');socket.write_all(&request).map_err(|e|e.to_string())?;break socket;
                }
            }
        }
        if !launched{
            let current=std::env::current_exe().map_err(|e|e.to_string())?;
            let gui=if current.file_stem().is_some_and(|name|name.to_string_lossy().to_ascii_lowercase().contains("cli")){
                let directory=current.parent().ok_or("CLI has no executable directory")?;
                ["SpektraLab-Windows.exe","spektralab.exe"].iter().map(|name|directory.join(name)).find(|p|p.is_file())
                    .ok_or("The CLI must remain beside the SpektraLab Windows application")?
            }else{current};
            let mut child=std::process::Command::new(gui);
            child.arg("--agent-service").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            #[cfg(windows)] {use std::os::windows::process::CommandExt;child.creation_flags(0x0800_0000);}
            child.spawn().map_err(|e|format!("Cannot start agent session: {e}"))?;launched=true;
        }
        if Instant::now()>end{return Err("Timed out starting the agent session".into());}
        if !access(directory){return Err("Agent access was revoked".into());}
        std::thread::sleep(Duration::from_millis(100));
    };
    let mut bytes=Vec::new();BufReader::new(&mut stream).take(32*1024*1024+1).read_until(b'\n',&mut bytes).map_err(|e|e.to_string())?;
    if bytes.len()>32*1024*1024{return Err("Agent response exceeds size limit".into());}
    serde_json::from_slice(&bytes).map_err(|e|e.to_string())
}
fn emit(value:&Value){println!("{}",value);}
fn parse(argv:&[String])->Result<(String,Value,Option<String>),String>{
    let catalog:Vec<Value>=serde_json::from_str(CATALOG).map_err(|e|e.to_string())?;
    let tool=catalog.iter().find(|t|t["command"].as_str()==Some(&argv[0])).ok_or("Unknown command")?;
    let mut args=json!({});let mut i=1;let mut preview=None;
    if tool["inputSchema"]["properties"].get("path").is_some(){
        let file=argv.get(i).filter(|s|!s.starts_with('-')).ok_or("This command needs an image path")?;
        args["path"]=json!(absolute(file)?);i+=1;
    }
    while i<argv.len(){
        let flag=&argv[i];i+=1;let value=argv.get(i).ok_or_else(||format!("{flag} needs a value"))?;i+=1;
        match (argv[0].as_str(),flag.as_str()){
            ("edit","--patch")=>{
                let text=if value=="-"{let mut bytes=String::new();std::io::stdin().take(8*1024*1024).read_to_string(&mut bytes).map_err(|e|e.to_string())?;bytes}
                    else if let Some(file)=value.strip_prefix('@'){std::fs::read_to_string(file).map_err(|e|e.to_string())?}else{value.clone()};
                args["patch"]=serde_json::from_str(&text).map_err(|e|format!("Invalid patch JSON: {e}"))?;
            }
            ("edit"|"reset"|"process"|"place","--preview")=>preview=Some(absolute(value)?),
            ("preview","-o"|"--output")=>args["output"]=json!(absolute(value)?),
            ("preview","--long-edge")=>args["long_edge"]=json!(value.parse::<u32>().map_err(|e|e.to_string())?),
            ("place","--highlight"|"--shadow")=>args[flag.trim_start_matches('-')]=json!(value.parse::<f64>().map_err(|e|e.to_string())?),
            ("export","--recipe")=>args["recipe"]=json!(value),
            ("export","--to")=>args["folder"]=json!(absolute(value)?),
            _=>return Err(format!("{} takes no option {flag}",argv[0])),
        }
    }
    if tool["inputSchema"]["properties"].get("preview").is_some(){args["preview"]=json!(preview.is_some());}
    if argv[0]=="preview"&&args.get("output").is_none(){return Err("preview needs -o out.jpg".into());}
    Ok((tool["name"].as_str().unwrap().into(),args,preview))
}
fn base64(bytes:&[u8])->String{
    const ABC:&[u8;64]=b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out=String::with_capacity((bytes.len()+2)/3*4);
    for group in bytes.chunks(3){let a=u32::from(group[0]);let b=u32::from(*group.get(1).unwrap_or(&0));let c=u32::from(*group.get(2).unwrap_or(&0));
        for n in [(a>>2)as usize,((a&3)<<4|b>>4)as usize,((b&15)<<2|c>>6)as usize,(c&63)as usize].iter().enumerate(){
            out.push(if n.0>group.len(){'='}else{ABC[*n.1]as char});
        }
    }out
}
fn serve_mcp(directory:&Path)->i32{
    let input=std::io::stdin();let mut input=input.lock();
    loop {
        let mut bytes=Vec::new();match (&mut input).take(8*1024*1024+1).read_until(b'\n',&mut bytes){Ok(0)=>return 0,Err(_)=>return 1,_=>{}}
        if bytes.len()>8*1024*1024{emit(&json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Request too large"}}));return 2;}
        let request:Value=match serde_json::from_slice(&bytes){Ok(v)=>v,Err(_)=>{emit(&json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Invalid JSON"}}));continue;}};
        let Some(id)=request.get("id")else{continue;};
        let result=match request["method"].as_str().unwrap_or(""){
            "initialize"=>json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"SpektraLab","version":env!("CARGO_PKG_VERSION")}}),
            "ping"=>json!({}),
            "tools/list"=>{let mut tools:Value=serde_json::from_str(CATALOG).unwrap();
                for tool in tools.as_array_mut().unwrap(){tool.as_object_mut().unwrap().remove("command");}
                json!({"tools":tools})},
            "tools/call"=>{
                let reply=exchange(directory,request["params"]["name"].as_str().unwrap_or(""),request["params"].get("arguments").cloned().unwrap_or(json!({})))
                    .unwrap_or_else(|e|json!({"ok":false,"error":{"code":"refused","message":e}}));
                let mut content=vec![json!({"type":"text","text":reply.to_string()})];
                if reply["ok"]==true{if let Some(path)=reply["result"]["preview"].as_str(){
                    if let Ok(image)=std::fs::read(path){if image.len()<=16*1024*1024{content.push(json!({"type":"image","mimeType":"image/jpeg","data":base64(&image)}));}}
                }}
                json!({"content":content,"isError":reply["ok"]!=true})
            }
            _=>{emit(&json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}}));continue;}
        };
        emit(&json!({"jsonrpc":"2.0","id":id,"result":result}));
        let _=std::io::stdout().flush();
    }
}
pub fn run_if_cli(identifier:&str)->Option<i32>{
    let argv:Vec<String>=std::env::args().skip(1).collect();let command=argv.first()?.as_str();
    if !["help","-h","--help","status","schema","stocks","recipes","info","get","edit","reset","process","latitude","place","preview","export","mcp"].contains(&command){return None;}
    if ["help","-h","--help"].contains(&command){print!("{USAGE}");return Some(0);}
    let directory=match data_directory(identifier){Ok(d)=>d,Err(e)=>{emit(&json!({"ok":false,"error":{"code":"failed","message":e}}));return Some(1);}};
    if command=="status"{emit(&json!({"ok":true,"access":access(&directory),"version":env!("CARGO_PKG_VERSION"),"executable":std::env::current_exe().ok()}));return Some(0);}
    if command=="mcp"{return Some(serve_mcp(&directory));}
    let reply=match parse(&argv){
        Ok((tool,args,preview))=>exchange(&directory,&tool,args).and_then(|mut reply|{
            if reply["ok"]==true{if let Some(output)=preview{if let Some(source)=reply["result"]["preview"].as_str(){
                std::fs::copy(source,&output).map_err(|e|e.to_string())?;reply["result"]["preview"]=json!(output);
            }}}
            Ok(reply)
        }),Err(e)=>Err(e),
    }.unwrap_or_else(|e|json!({"ok":false,"error":{"code":"refused","message":e}}));
    let status=if reply["ok"]==true{0}else if reply["error"]["code"]=="refused"{2}else{1};emit(&reply);Some(status)
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn base64_padding(){for(input,expected)in [("",""),("f","Zg=="),("fo","Zm8="),("foo","Zm9v"),("foobar","Zm9vYmFy")]{assert_eq!(base64(input.as_bytes()),expected);}}
    #[test]fn cli_refuses_unknown_flags_and_missing_output(){
        assert!(parse(&["preview".into(),"photo.tif".into()]).is_err());
        assert!(parse(&["process".into(),"photo.tif".into(),"--force".into(),"yes".into()]).is_err());
        let(tool,args,_)=parse(&["edit".into(),"photo.tif".into(),"--patch".into(),"{\"adjustments\":{\"exposure\":0.3}}".into()]).unwrap();
        assert_eq!(tool,"edit_image");assert_eq!(args["patch"]["adjustments"]["exposure"],0.3);
    }
}
