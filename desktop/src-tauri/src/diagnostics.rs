//! User-requested local diagnostic ZIPs and retention of this app's logs.
//! Photographs, sidecars and the agent endpoint/token are never collected.
use std::path::Path;
use std::io::Read;
use serde_json::Value;
use tauri::{AppHandle,Manager};

fn crc32(bytes:&[u8])->u32{
    let mut table=[0u32;256];for (i,item) in table.iter_mut().enumerate(){let mut c=i as u32;for _ in 0..8{c=if c&1!=0{0xedb88320^(c>>1)}else{c>>1};}*item=c;}
    let mut crc=!0u32;for byte in bytes{crc=table[((crc^u32::from(*byte))&255)as usize]^(crc>>8);}!crc
}
fn u16le(out:&mut Vec<u8>,value:u16){out.extend(value.to_le_bytes());}
fn u32le(out:&mut Vec<u8>,value:u32){out.extend(value.to_le_bytes());}
fn zip(entries:&[(String,Vec<u8>)])->Result<Vec<u8>,String>{
    let mut out=Vec::new();let mut central=Vec::new();
    for(name,bytes)in entries{
        if name.len()>u16::MAX as usize||bytes.len()>u32::MAX as usize||out.len()>u32::MAX as usize{return Err("Diagnostic ZIP exceeds format limits".into());}
        let offset=out.len()as u32;let crc=crc32(bytes);let length=bytes.len()as u32;
        u32le(&mut out,0x04034b50);for value in [20,0x800,0,0,33]{u16le(&mut out,value);}
        for value in [crc,length,length]{u32le(&mut out,value);}u16le(&mut out,name.len()as u16);u16le(&mut out,0);
        out.extend(name.as_bytes());out.extend(bytes);
        u32le(&mut central,0x02014b50);for value in [20,20,0x800,0,0,33]{u16le(&mut central,value);}
        for value in [crc,length,length]{u32le(&mut central,value);}u16le(&mut central,name.len()as u16);
        for _ in 0..4{u16le(&mut central,0);}u32le(&mut central,0);u32le(&mut central,offset);central.extend(name.as_bytes());
    }
    let start=out.len()as u32;let length=central.len()as u32;out.extend(central);
    u32le(&mut out,0x06054b50);u16le(&mut out,0);u16le(&mut out,0);
    u16le(&mut out,entries.len()as u16);u16le(&mut out,entries.len()as u16);u32le(&mut out,length);u32le(&mut out,start);u16le(&mut out,0);Ok(out)
}
fn app_log(path:&Path)->bool{
    path.file_name().and_then(|n|n.to_str()).is_some_and(|n|n.starts_with("spektralab")&&n.ends_with(".log"))
}
#[tauri::command]
pub fn diagnostics_export(app:AppHandle,path:String,report:Value)->Result<String,String>{
    let target=std::path::PathBuf::from(&path);
    if !target.is_absolute()||!target.extension().and_then(|s|s.to_str()).is_some_and(|s|s.eq_ignore_ascii_case("zip")){
        return Err("Diagnostics need an absolute .zip output path".into());
    }
    let report=serde_json::to_vec_pretty(&report).map_err(|e|e.to_string())?;
    if report.len()>1024*1024{return Err("Diagnostic report exceeds 1 MiB".into());}
    let mut entries=vec![("diagnostics.json".into(),report)];let mut total=0;
    if let Ok(logs)=app.path().app_log_dir().and_then(|p|std::fs::read_dir(p).map_err(Into::into)){
        for entry in logs.flatten(){let path=entry.path();if !app_log(&path)||!entry.file_type().is_ok_and(|t|t.is_file()){continue;}
            if let Ok(file)=std::fs::File::open(&path){let mut bytes=Vec::new();
                if file.take(4*1024*1024+1).read_to_end(&mut bytes).is_err()||bytes.len()>4*1024*1024||total+bytes.len()>24*1024*1024{continue;}total+=bytes.len();
                entries.push((format!("logs/{}",entry.file_name().to_string_lossy()),bytes));
            }
        }
    }
    crate::files::write_atomic(&target,&zip(&entries)?)?;Ok(path)
}
#[tauri::command]
pub fn logs_retention(app:AppHandle,days:u32)->Result<usize,String>{
    if days>365{return Err("Log retention must be from 0 to 365 days".into());}
    if days==0{return Ok(0);}
    let directory=app.path().app_log_dir().map_err(|e|e.to_string())?;let mut removed=0;
    let age=std::time::Duration::from_secs(u64::from(days)*24*3600);
    if let Ok(files)=std::fs::read_dir(directory){for entry in files.flatten(){
        if !app_log(&entry.path())||!entry.file_type().is_ok_and(|t|t.is_file()){continue;}
        if entry.metadata().and_then(|m|m.modified()).ok().and_then(|m|m.elapsed().ok()).is_some_and(|d|d>age)&&std::fs::remove_file(entry.path()).is_ok(){removed+=1;}
    }}Ok(removed)
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn crc_known_vector_and_unicode_zip(){
        assert_eq!(crc32(b"123456789"),0xcbf43926);
        let bytes=zip(&[("诊断.json".into(),b"{\"ok\":true}".to_vec()),("logs/spektralab.log".into(),b"line\n".to_vec())]).unwrap();
        assert_eq!(&bytes[..4],b"PK\x03\x04");assert_eq!(&bytes[bytes.len()-22..bytes.len()-18],b"PK\x05\x06");
        // Optional independent zipfile verification in the validation runner.
        if let Some(path)=std::env::var_os("SPEKTRALAB_ZIP_TEST_OUTPUT"){std::fs::write(path,bytes).unwrap();}
    }
    #[test]fn only_application_logs_are_collected_or_removed(){
        assert!(app_log(Path::new("spektralab.log")));assert!(app_log(Path::new("spektralab_2026-10-28.log")));
        for name in ["photo.ARW","agent-endpoint.json","another-app.log","photo.spektra.json"]{assert!(!app_log(Path::new(name)));}
    }
}
