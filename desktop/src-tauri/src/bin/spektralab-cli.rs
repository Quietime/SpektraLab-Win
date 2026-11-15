// Console-subsystem entry point: PowerShell, cmd and MCP always receive real
// UTF-8 stdio and a process exit code. The GUI remains a console-free binary.
fn main(){
    if std::env::args().len()==1{println!("{}",spektralab_lib::cli::usage());return;}
    let context:tauri::Context<tauri::Wry>=tauri::generate_context!();
    let status=spektralab_lib::cli::run_if_cli(&context.config().identifier).unwrap_or_else(||{
        eprintln!("Unknown SpektraLab command. Use --help.");2
    });
    std::process::exit(status);
}
