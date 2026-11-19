package app.spektralab.android;

import android.app.*;
import android.os.*;
import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.webkit.*;
import android.util.Base64;
import android.view.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

/** Bundled app assets are the sole bridge principal. No remote pages or subframes. */
public final class MainActivity extends Activity {
 private WebView web;
 private final ExecutorService io=Executors.newSingleThreadExecutor();
 private final ExecutorService calls=Executors.newFixedThreadPool(4);
 private final ExecutorService hostLogs=Executors.newSingleThreadExecutor();
 private PowerManager.OnThermalStatusChangedListener thermalListener;
 private android.window.OnBackInvokedCallback systemBackCallback;
 private volatile int streamedPayloads=0;
 private volatile java.lang.Process host;
 private DataInputStream hostIn;
 private OutputStream hostOut;
 private final Map<String,File> binaries=new ConcurrentHashMap<>();
 private final Map<String,Integer> uploadOffsets=new ConcurrentHashMap<>();
 private final Map<Integer,Picker> pickers=new HashMap<>();
 private int requestCode=100;
 private long hostSequence=0;
 private File root,imports,exports,resources;
 private String error="";
 private static final int CHUNK=196608;
 private static final String ORIGIN="https://appassets.androidplatform.net";
 private static final String IMAGES="(?i).*\\.(nef|arw|cr2|cr3|raf|dng|orf|rw2|pef|srw|tif|tiff|jpg|jpeg|png|spektrapair)$";
 private static final class Picker { final int id;final String mode;Picker(int id,String mode){this.id=id;this.mode=mode;} }
 @Override public void onCreate(Bundle state){
  super.onCreate(state);try{root=getFilesDir().getCanonicalFile();resources=new File(root,"engine-"+getPackageManager().getPackageInfo(getPackageName(),0).getLongVersionCode());}catch(Exception failure){throw new IllegalStateException(failure);}imports=new File(root,"Imports");exports=new File(root,"Exports");imports.mkdirs();exports.mkdirs();
  web=new WebView(this);android.widget.FrameLayout container=new android.widget.FrameLayout(this);container.addView(web,new android.widget.FrameLayout.LayoutParams(-1,-1));setContentView(container);
  container.setOnApplyWindowInsetsListener((view,insets)->{view.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets.consumeSystemWindowInsets();});web.setBackgroundColor(0xff2d2d2c);
  WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setAllowFileAccess(false);s.setAllowContentAccess(false);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);s.setSupportMultipleWindows(false);s.setMediaPlaybackRequiresUserGesture(true);
  web.addJavascriptInterface(new Bridge(),"SpektraAndroid");
  web.setWebChromeClient(new WebChromeClient(){
   @Override public boolean onConsoleMessage(ConsoleMessage m){android.util.Log.d("SpektraLab",m.message());return true;}
  });
  web.setWebViewClient(new WebViewClient(){
   @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){
    Uri u=request.getUrl();String path=u.getPath();
    if(ORIGIN.equals(u.getScheme()+"://"+u.getHost())&&path!=null&&path.matches("/binary/[a-f0-9-]{36}")&&request.getMethod().equals("GET")){
     File payload=binaries.get(path.substring(8));if(payload==null)return new WebResourceResponse("text/plain","UTF-8",404,"Unknown payload",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));
     try{InputStream input=new BufferedInputStream(new FileInputStream(payload));Map<String,String> headers=new HashMap<>();headers.put("Content-Length",Long.toString(payload.length()));headers.put("Cache-Control","no-store");headers.put("X-Content-Type-Options","nosniff");streamedPayloads++;return new WebResourceResponse("application/octet-stream",null,200,"OK",headers,input);}catch(IOException failure){return new WebResourceResponse("text/plain","UTF-8",404,"Payload unavailable",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}
    }
    if(!ORIGIN.equals(u.getScheme()+"://"+u.getHost())||path==null||!path.startsWith("/assets/")||path.contains(".."))return new WebResourceResponse("text/plain","UTF-8",403,"Blocked",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));
    try {String asset=path.substring(8);String mime=asset.endsWith(".js")?"text/javascript":asset.endsWith(".css")?"text/css":asset.endsWith(".html")?"text/html":asset.endsWith(".json")?"application/json":asset.endsWith(".svg")?"image/svg+xml":asset.endsWith(".png")?"image/png":"application/octet-stream";return new WebResourceResponse(mime,"UTF-8",getAssets().open("web/"+asset));}
    catch(IOException e){return new WebResourceResponse("text/plain","UTF-8",404,"Not found",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}
   }
   @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){if(r.getUrl().toString().startsWith(ORIGIN+"/assets/"))return false;return true;}
  });
  PowerManager power=(PowerManager)getSystemService(POWER_SERVICE);thermalListener=status->web.evaluateJavascript("window.dispatchEvent(new CustomEvent(\"spektralab-thermal\",{detail:"+status+"}))",null);power.addThermalStatusListener(thermalListener);
  configureDisplay();if(Build.VERSION.SDK_INT>=33){systemBackCallback=this::onBackPressed;getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,systemBackCallback);}
  web.loadUrl(ORIGIN+"/assets/index.html");io.execute(()->{try{new ManagedUpdater(this).cleanupAfterInstalled();}catch(Exception e){android.util.Log.w("SpektraLab","Update cleanup unavailable",e);}});
 }
 public static int chooseDisplayMode(int[] widths,int[] heights,float[] rates){int best=-1;long pixels=-1;float rate=-1;for(int i=0;i<widths.length;i++){long p=(long)widths[i]*heights[i];if(widths[i]<=0||heights[i]<=0||!Float.isFinite(rates[i])||rates[i]<=0)continue;if(p>pixels||(p==pixels&&rates[i]>rate)){best=i;pixels=p;rate=rates[i];}}return best;}
 private void configureDisplay(){try{Display display=getWindowManager().getDefaultDisplay();Display.Mode[] modes=display.getSupportedModes();int[] w=new int[modes.length],h=new int[modes.length];float[] r=new float[modes.length];for(int i=0;i<modes.length;i++){w[i]=modes[i].getPhysicalWidth();h[i]=modes[i].getPhysicalHeight();r[i]=modes[i].getRefreshRate();}int best=chooseDisplayMode(w,h,r);if(best<0)return;WindowManager.LayoutParams p=getWindow().getAttributes();p.preferredDisplayModeId=modes[best].getModeId();p.preferredRefreshRate=r[best];getWindow().setAttributes(p);if(Build.VERSION.SDK_INT>=35)web.setRequestedFrameRate(r[best]);}catch(RuntimeException failure){android.util.Log.w("SpektraLab","Display preference unavailable",failure);}}
 @Override protected void onResume(){super.onResume();if(web!=null)configureDisplay();}
 @Override public void onConfigurationChanged(android.content.res.Configuration config){super.onConfigurationChanged(config);configureDisplay();}
 private JSONObject displayInfo()throws Exception{Display d=getWindowManager().getDefaultDisplay();Display.Mode m=d.getMode();WindowManager.LayoutParams p=getWindow().getAttributes();JSONArray modes=new JSONArray();for(Display.Mode mode:d.getSupportedModes())modes.put(new JSONObject().put("id",mode.getModeId()).put("width",mode.getPhysicalWidth()).put("height",mode.getPhysicalHeight()).put("hz",mode.getRefreshRate()));return new JSONObject().put("model",Build.MODEL).put("width",m.getPhysicalWidth()).put("height",m.getPhysicalHeight()).put("actual_hz",d.getRefreshRate()).put("requested_hz",p.preferredRefreshRate).put("requested_mode",p.preferredDisplayModeId).put("density",getResources().getDisplayMetrics().density).put("modes",modes);}
 private JSONObject performanceInfo()throws Exception{ActivityManager.MemoryInfo info=new ActivityManager.MemoryInfo();((ActivityManager)getSystemService(ACTIVITY_SERVICE)).getMemoryInfo(info);PowerManager power=(PowerManager)getSystemService(POWER_SERVICE);return new JSONObject().put("cpu_cores",Runtime.getRuntime().availableProcessors()).put("cpu_workers",Math.max(1,Math.min(8,Runtime.getRuntime().availableProcessors()-1))).put("ram_mb",info.totalMem/(1024*1024)).put("available_mb",info.availMem/(1024*1024)).put("soc",Build.VERSION.SDK_INT>=31?Build.SOC_MODEL:Build.HARDWARE).put("thermal_status",power.getCurrentThermalStatus()).put("streamed_payloads",streamedPayloads).put("display",displayInfo());}
 private static void copy(InputStream in,OutputStream out)throws IOException {byte[] buffer=new byte[65536];int n;while((n=in.read(buffer))!=-1)out.write(buffer,0,n);}
 private static byte[] allBytes(InputStream in)throws IOException {ByteArrayOutputStream out=new ByteArrayOutputStream();copy(in,out);return out.toByteArray();}
 private static String jsonString(Object value){if(value==null||value==JSONObject.NULL)return "null";if(value instanceof String)return JSONObject.quote((String)value);return value.toString();}
 private void reply(int id,Object result,String err){runOnUiThread(()->web.evaluateJavascript("window.__spkAndroidReply&&window.__spkAndroidReply("+id+","+(result==null?"null":jsonString(result))+","+(err==null?"null":JSONObject.quote(err))+")",null));}
 public final class Bridge {
  @JavascriptInterface public void call(int id,String method,String text){
   if(text.length()>1024*1024){reply(id,null,"Bridge request exceeds limit");return;}
   calls.execute(()->{try{JSONObject p=new JSONObject(text);if(method.startsWith("pick_")||method.equals("message")||method.equals("confirm")){runOnUiThread(()->uiCall(id,method,p));return;}Object value=dispatch(method,p);reply(id,value,null);}catch(Exception e){android.util.Log.e("SpektraLab",method,e);reply(id,null,e.getMessage()==null?e.toString():e.getMessage());}});
  }
 }
 private File owned(String path)throws Exception {File f=new File(path).getCanonicalFile();String canonical=root.getCanonicalPath()+"/";if(!f.getPath().startsWith(canonical)&&!f.getPath().startsWith(getCacheDir().getCanonicalPath()+"/"))throw new IOException("Path is outside app storage");return f;}
 private File area(String kind,String name)throws Exception {if(!kind.matches("[A-Za-z0-9_-]+")||name.isEmpty()||name.equals(".")||name.equals("..")||name.indexOf('/')>=0||name.indexOf('\\')>=0||name.chars().anyMatch(c->c<32||c==127))throw new IOException("Invalid storage key");File dir=new File(root,kind);dir.mkdirs();return new File(dir,name.endsWith(".json")?name:name+".json");}
 private String read(File f)throws Exception {try(InputStream in=new FileInputStream(f)){return new String(allBytes(in),StandardCharsets.UTF_8);}}
 private void atomic(File file,String text)throws Exception {file.getParentFile().mkdirs();File tmp=File.createTempFile(".spk-",".tmp",file.getParentFile());try{try(FileOutputStream out=new FileOutputStream(tmp)){out.write(text.getBytes(StandardCharsets.UTF_8));out.getFD().sync();}if(!tmp.renameTo(file))throw new IOException("Atomic storage write failed");}finally{tmp.delete();}}
 private Object json(File f)throws Exception {return f.isFile()?new JSONTokener(read(f)).nextValue():JSONObject.NULL;}
 private String digest(String text)throws Exception {byte[] bytes=MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));StringBuilder out=new StringBuilder();for(byte b:bytes)out.append(String.format(Locale.ROOT,"%02x",b));return out.toString();}
 private File sidecar(String image)throws Exception {return area("Sidecars",new File(image).getName()+"-"+digest(image).substring(0,16)+".spektra");}
 private JSONObject entry(File f)throws Exception {return new JSONObject().put("path",f.getAbsolutePath()).put("name",f.getName()).put("size",f.length()).put("mtime_ms",f.lastModified());}
 private JSONArray entries(File dir)throws Exception {JSONArray out=new JSONArray();File[] files=dir.listFiles();if(files!=null){Arrays.sort(files,Comparator.comparing(File::getName,String.CASE_INSENSITIVE_ORDER));for(File f:files)if(f.isFile()&&f.getName().matches(IMAGES))out.put(entry(f));}return out;}
 private JSONArray importedPhotoPaths()throws IOException {
  JSONArray paths=new JSONArray();
  File[] folders=imports.listFiles(File::isDirectory);
  if(folders==null)return paths;
  Arrays.sort(folders,Comparator.comparing(File::getName));
  String prefix=imports.getCanonicalPath()+File.separator;
  for(File folder:folders){
   if(!folder.getName().matches("(?:Files|Folder)-[0-9a-f]{16}"))continue;
   File[] files=folder.listFiles(File::isFile);
   if(files==null)continue;
   Arrays.sort(files,Comparator.comparing(File::getName,String.CASE_INSENSITIVE_ORDER));
   for(File file:files){
    if(!file.getName().matches(IMAGES))continue;
    String path=file.getCanonicalPath();
    if(path.startsWith(prefix))paths.put(path);
   }
  }
  return paths;
 }
 private Object dispatch(String method,JSONObject p)throws Exception {
  switch(method){
   case "display_info":return displayInfo();
   case "performance_info":return performanceInfo();
   case "diagnostics_export":{File file=owned(p.getString("path"));byte[] report=p.getJSONObject("report").toString(2).getBytes(StandardCharsets.UTF_8);if(report.length>1024*1024)throw new IOException("Report exceeds 1 MiB");try(java.util.zip.ZipOutputStream out=new java.util.zip.ZipOutputStream(new FileOutputStream(file))){out.putNextEntry(new java.util.zip.ZipEntry("diagnostics.json"));out.write(report);out.closeEntry();out.putNextEntry(new java.util.zip.ZipEntry("host-last-message.txt"));out.write(error.getBytes(StandardCharsets.UTF_8));out.closeEntry();}publish(file);return file.getPath();}
   case "check_updates":return new ManagedUpdater(this).check();
   case "update_prepare":return new ManagedUpdater(this).prepare();
   case "update_install":return new ManagedUpdater(this).install(this);
   case "host_request": synchronized(this){return hostRequest(p);}
   case "host_restart": {java.lang.Process old=host;if(old!=null)old.destroy();host=null;return true;}
   case "host_diagnostics":return new JSONObject().put("platform","Android").put("error",error).put("host_running",host!=null&&host.isAlive());
   case "upload_open":{int bytes=p.getInt("bytes");if(bytes<0||bytes>512*1024*1024)throw new IOException("Upload exceeds 512 MiB");String id=UUID.randomUUID().toString();File f=File.createTempFile("upload-",".bin",getCacheDir());binaries.put(id,f);uploadOffsets.put(id,0);return id;}
   case "upload_chunk":{String id=p.getString("id");File f=binaries.get(id);if(f==null||!uploadOffsets.containsKey(id))throw new IOException("Unknown upload");synchronized(f){if(p.getInt("offset")!=uploadOffsets.get(id))throw new IOException("Upload out of order");byte[] bytes=Base64.decode(p.getString("data"),Base64.DEFAULT);if(bytes.length>CHUNK)throw new IOException("Oversize chunk");try(OutputStream out=new FileOutputStream(f,true)){out.write(bytes);}uploadOffsets.put(id,uploadOffsets.get(id)+bytes.length);}return true;}
   case "binary_read":{File f=binaries.get(p.getString("id"));if(f==null)throw new IOException("Unknown payload");long offset=p.getLong("offset");if(offset<0||offset>f.length())throw new IOException("Invalid offset");try(RandomAccessFile in=new RandomAccessFile(f,"r")){in.seek(offset);byte[] bytes=new byte[(int)Math.min(CHUNK,f.length()-offset)];in.readFully(bytes);return Base64.encodeToString(bytes,Base64.NO_WRAP);}}
   case "binary_drop":{String id=p.getString("id");File f=binaries.remove(id);uploadOffsets.remove(id);if(f!=null)f.delete();return true;}
   case "app_paths":return new JSONObject().put("appData",root.getPath()).put("sidecars",new File(root,"Sidecars").getPath()).put("logs",new File(root,"Logs").getPath()).put("home",root.getPath()).put("pictures",imports.getPath()).put("os","android").put("version",getPackageManager().getPackageInfo(getPackageName(),0).versionName);
   case "store_read":return json(area(p.getString("area"),p.getString("name")));
   case "store_write":atomic(area(p.getString("area"),p.getString("name")),p.get("value").toString());return true;
   case "store_delete":{String area=p.getString("area"),name=p.getString("name");if(!"LightTable".equals(area)||!name.matches("tray-[A-Za-z0-9_-]{1,40}-(photos|cards)-[A-Za-z0-9_-]+-[0-9]+\\.json"))throw new IOException("Refusing to delete an unmanaged store value");File f=area(area,name);if(f.exists()&&!f.delete())throw new IOException("Cannot delete stored item");return true;}
   case "sidecar_path":return sidecar(p.getString("image")).getPath();
   case "sidecar_load":return json(sidecar(p.getString("image")));
   case "sidecar_save":{File f=sidecar(p.getString("image"));atomic(f,p.get("sidecar").toString());return f.getPath();}
   case "pair_load":return json(owned(p.getString("path")));
   case "pair_save":atomic(owned(p.getString("path")),p.get("value").toString());return true;
   case "pair_create":{File f=new File(owned(p.getString("folder")),"Pair-"+UUID.randomUUID()+".spektrapair");atomic(f,p.get("value").toString());return entry(f);}
   case "path_exists":{File f=owned(p.getString("path"));return f.exists()||treeFile(f)!=null;}
   case "ensure_dir":{File f=owned(p.getString("path"));if(!f.isDirectory()&&!f.mkdirs())throw new IOException("Cannot create folder");return true;}
   case "list_imports":return importedPhotoPaths();
   case "list_images":{File dir=owned(p.getString("dir"));String uri=getPreferences(0).getString("tree:"+dir.getPath(),null);if(uri!=null)importTree(Uri.parse(uri),dir);return entries(dir);}
   case "expand_paths":{JSONArray out=new JSONArray(),paths=p.getJSONArray("paths");for(int i=0;i<paths.length();i++){File f=owned(paths.getString(i));if(f.isDirectory()){JSONArray children=entries(f);for(int j=0;j<children.length();j++)out.put(children.get(j));}else if(f.isFile()&&f.getName().matches(IMAGES))out.put(entry(f));}return out;}
   case "take_launch_paths":return new JSONArray();
   case "reveal":case "open_file":{File file=owned(p.getString("path"));Uri target=published(file);if(target==null)throw new IOException("Export to a selected Android folder before opening in another app");runOnUiThread(()->{try{Intent view=new Intent(Intent.ACTION_VIEW).setDataAndType(target,getContentResolver().getType(target)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);startActivity(p.optBoolean("chooseApplication")?Intent.createChooser(view,"Open with"):view);}catch(Exception e){android.widget.Toast.makeText(this,e.getMessage(),1).show();}});return true;}
   case "open_url":{Uri uri=Uri.parse(p.getString("url"));if(!"https".equals(uri.getScheme()))throw new IOException("Only HTTPS links are allowed");runOnUiThread(()->startActivity(new Intent(Intent.ACTION_VIEW,uri)));return true;}
   case "finish":runOnUiThread(()->finish());return true;
   case "fullscreen":runOnUiThread(()->getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN|View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY));return true;
   default:throw new IOException("Unsupported Android operation: "+method);
  }
 }
 private void copyAssets(String asset,File target)throws IOException {String[] files=getAssets().list(asset);if(files!=null&&files.length>0){target.mkdirs();for(String name:files)copyAssets(asset+"/"+name,new File(target,name));}else{target.getParentFile().mkdirs();try(InputStream in=getAssets().open(asset);OutputStream out=new FileOutputStream(target)){copy(in,out);}}}
 private void startHost()throws Exception {
  if(host!=null&&host.isAlive())return;
  if(!new File(resources,".complete").exists()){copyAssets("engine",resources);atomic(new File(resources,".complete"),Long.toString(getPackageManager().getPackageInfo(getPackageName(),0).getLongVersionCode()));}
  File exe=new File(getApplicationInfo().nativeLibraryDir,"libspektralab_host.so");
  ProcessBuilder builder=new ProcessBuilder(exe.getPath(),"--resources",resources.getPath(),"--cache-dir",new File(getCacheDir(),"LinearDecode").getPath());
  builder.environment().put("SPEKTRALAB_CPU_WORKERS",Integer.toString(Math.max(1,Math.min(8,Runtime.getRuntime().availableProcessors()-1))));
  host=builder.start();hostIn=new DataInputStream(new BufferedInputStream(host.getInputStream()));hostOut=new BufferedOutputStream(host.getOutputStream());
  final InputStream stderr=host.getErrorStream();hostLogs.execute(()->{try(BufferedReader reader=new BufferedReader(new InputStreamReader(stderr))){String line;while((line=reader.readLine())!=null){error=line;android.util.Log.i("SpektraHost",line);}}catch(IOException ignored){}});
 }
 private static int little(DataInputStream in)throws IOException {return Integer.reverseBytes(in.readInt());}
 private static void little(OutputStream out,int value)throws IOException {out.write(new byte[]{(byte)value,(byte)(value>>8),(byte)(value>>16),(byte)(value>>24)});}
 private JSONObject hostRequest(JSONObject p)throws Exception {
  startHost();String method=p.getString("method");JSONObject args=p.optJSONObject("params");if(args==null)args=new JSONObject();
  // Host paths are app-owned copies; content URIs never enter C++ filesystem APIs.
  if((method.equals("write_image")||method.equals("write_working_image")||method.equals("export_cineon"))&&args.has("path")){
   File destination=owned(args.getString("path"));if(getPreferences(0).contains("source:"+destination.getPath()))throw new IOException("Refusing to overwrite an imported source copy");Uri existing=treeFile(destination);
   if(existing!=null){if(!args.optBoolean("overwrite"))throw new IOException("Destination exists in selected Android folder");
    for(Map.Entry<String,?> item:getPreferences(0).getAll().entrySet())if(item.getKey().startsWith("source:")&&existing.toString().equals(item.getValue()))throw new IOException("Refusing to overwrite an imported original");}
  }
  String requestId=Long.toString(++hostSequence);byte[] header=new JSONObject().put("id",Long.parseLong(requestId)).put("method",method).put("params",args).toString().getBytes(StandardCharsets.UTF_8);
  File upload=binaries.get(p.optString("upload",""));long length=upload==null?0:upload.length();
  little(hostOut,header.length);little(hostOut,(int)length);hostOut.write(header);if(upload!=null)try(InputStream in=new FileInputStream(upload)){copy(in,hostOut);}hostOut.flush();
  for(;;){int h=little(hostIn),b=little(hostIn);if(h<0||h>64*1024*1024||b<0||b>512*1024*1024)throw new IOException("Invalid host frame");byte[] raw=new byte[h];hostIn.readFully(raw);JSONObject answer=new JSONObject(new String(raw,StandardCharsets.UTF_8));File binary=File.createTempFile("reply-",".bin",getCacheDir());try(OutputStream out=new FileOutputStream(binary)){byte[] chunk=new byte[65536];for(int left=b;left>0;){int n=hostIn.read(chunk,0,Math.min(chunk.length,left));if(n<0)throw new EOFException("Host payload ended early");out.write(chunk,0,n);left-=n;}}
   if(!requestId.equals(answer.optString("id"))){binary.delete();continue;}
   String id=UUID.randomUUID().toString();binaries.put(id,binary);
   if(answer.optBoolean("ok")&&(method.equals("write_image")||method.equals("write_working_image")||method.equals("export_cineon"))){String path=args.optString("path");if(!path.isEmpty())publish(owned(path));JSONObject result=answer.optJSONObject("result");if(result!=null){JSONArray luts=result.optJSONArray("view_luts");if(luts!=null)for(int i=0;i<luts.length();i++)publish(owned(luts.getString(i)));}}
   return new JSONObject().put("header",answer).put("id",id).put("bytes",b);
  }
 }
 private void uiCall(int id,String method,JSONObject p){try{
  if(method.equals("message")||method.equals("confirm")){AlertDialog.Builder dialog=new AlertDialog.Builder(this).setTitle(p.optString("title")).setMessage(p.optString("text")).setPositiveButton(android.R.string.ok,(d,w)->reply(id,true,null));if(method.equals("confirm"))dialog.setNegativeButton(android.R.string.cancel,(d,w)->reply(id,false,null));dialog.setOnCancelListener(d->reply(id,false,null)).show();return;}
  Intent intent;if(method.equals("pick_folder")||method.equals("pick_export_folder")){intent=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);}
  else if(method.equals("pick_save")){intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/octet-stream").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE,new File(p.optString("defaultPath","Export."+p.optString("ext","tif"))).getName());}
  else{intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true);intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);}
  int code=++requestCode;pickers.put(code,new Picker(id,method));startActivityForResult(intent,code);
 }catch(Exception e){reply(id,null,e.toString());}}
 private String displayName(Uri uri){try(Cursor c=getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)){if(c!=null&&c.moveToFirst())return c.getString(0).replaceAll("[/\\\\\\x00-\\x1f]","_");}catch(Exception ignored){}return "Photo.dng";}
 private File importUri(Uri uri,File dir)throws Exception {String name=displayName(uri);if(!name.matches(IMAGES))return null;dir.mkdirs();File out=new File(dir,name);File tmp=File.createTempFile(".import-",".tmp",dir);try{try(InputStream in=getContentResolver().openInputStream(uri);OutputStream target=new FileOutputStream(tmp)){if(in==null)throw new IOException("Cannot read selected image");copy(in,target);}if(!tmp.renameTo(out))throw new IOException("Cannot save imported copy");getPreferences(0).edit().putString("source:"+out.getPath(),uri.toString()).apply();}finally{tmp.delete();}return out;}
 private void importTree(Uri tree,File dir)throws Exception {Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree));try(Cursor c=getContentResolver().query(children,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null)){if(c!=null)while(c.moveToNext())if(c.getString(1).matches(IMAGES)){File existing=new File(dir,c.getString(1));if(!existing.exists())importUri(DocumentsContract.buildDocumentUriUsingTree(tree,c.getString(0)),dir);}}}
 @Override protected void onActivityResult(int code,int result,Intent data){super.onActivityResult(code,result,data);Picker picker=pickers.remove(code);if(picker==null)return;if(result!=RESULT_OK||data==null){reply(picker.id,picker.mode.equals("pick_files")?new JSONArray():JSONObject.NULL,null);return;}
  io.execute(()->{try{
   if(picker.mode.equals("pick_folder")||picker.mode.equals("pick_export_folder")){Uri uri=data.getData();if(uri==null)throw new IOException("No folder returned");getContentResolver().takePersistableUriPermission(uri,data.getFlags()&(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION));File dir=new File(picker.mode.equals("pick_export_folder")?exports:imports,"Folder-"+digest(uri.toString()).substring(0,16));dir.mkdirs();getPreferences(0).edit().putString("tree:"+dir.getPath(),uri.toString()).apply();reply(picker.id,dir.getPath(),null);}
   else if(picker.mode.equals("pick_save")){Uri uri=data.getData();if(uri==null)throw new IOException("No output returned");File out=new File(exports,UUID.randomUUID()+"-"+displayName(uri));getPreferences(0).edit().putString("file:"+out.getPath(),uri.toString()).apply();reply(picker.id,out.getPath(),null);}
   else{JSONArray paths=new JSONArray();List<Uri> uris=new ArrayList<>();ClipData clips=data.getClipData();if(clips!=null){for(int i=0;i<clips.getItemCount();i++)uris.add(clips.getItemAt(i).getUri());}else if(data.getData()!=null)uris.add(data.getData());for(Uri uri:uris){File dir=new File(imports,"Files-"+digest(uri.toString()).substring(0,16));File file=importUri(uri,dir);if(file!=null)paths.put(file.getPath());}reply(picker.id,paths,null);}
  }catch(Exception e){reply(picker.id,null,e.toString());}});
 }
 private Uri treeFile(File file)throws Exception {String value=getPreferences(0).getString("tree:"+file.getParent(),null);if(value==null)return null;Uri tree=Uri.parse(value);Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree));try(Cursor c=getContentResolver().query(children,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null)){if(c!=null)while(c.moveToNext())if(file.getName().equals(c.getString(1)))return DocumentsContract.buildDocumentUriUsingTree(tree,c.getString(0));}return null;}
 private Uri published(File file){String value=getPreferences(0).getString("published:"+file.getPath(),null);return value==null?null:Uri.parse(value);}
 private void publish(File file)throws Exception {if(!file.isFile())return;String direct=getPreferences(0).getString("file:"+file.getPath(),null);Uri target=direct==null?null:Uri.parse(direct);
  if(target==null){String treeValue=getPreferences(0).getString("tree:"+file.getParent(),null);if(treeValue==null)return;Uri tree=Uri.parse(treeValue);Uri parent=DocumentsContract.buildDocumentUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree));Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree));try(Cursor c=getContentResolver().query(children,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null)){if(c!=null)while(c.moveToNext())if(file.getName().equals(c.getString(1))){target=DocumentsContract.buildDocumentUriUsingTree(tree,c.getString(0));break;}}
   if(target==null){String name=file.getName().toLowerCase(Locale.ROOT);String mime=name.endsWith(".png")?"image/png":name.endsWith(".tif")||name.endsWith(".tiff")?"image/tiff":name.endsWith(".jpg")||name.endsWith(".jpeg")?"image/jpeg":"application/octet-stream";target=DocumentsContract.createDocument(getContentResolver(),parent,mime,file.getName());}}
  if(target==null)throw new IOException("Android provider refused the output");
  for(Map.Entry<String,?> source:getPreferences(0).getAll().entrySet())if(source.getKey().startsWith("source:")){
   Uri original=Uri.parse(String.valueOf(source.getValue()));boolean same=target.equals(original);
   try{same|=Objects.equals(target.getAuthority(),original.getAuthority())&&DocumentsContract.getDocumentId(target).equals(DocumentsContract.getDocumentId(original));}catch(IllegalArgumentException ignored){}
   // Providers can expose the same photo through distinct authorities. Keep
   // a same-name original safe too; the export can use a different filename.
   if(same||file.getName().equals(new File(source.getKey().substring(7)).getName()))throw new IOException("Refusing to overwrite an imported original; choose a different export name");
  }
  try(InputStream in=new FileInputStream(file);OutputStream out=getContentResolver().openOutputStream(target,"wt")){if(out==null)throw new IOException("Cannot write Android output");copy(in,out);}getPreferences(0).edit().putString("published:"+file.getPath(),target.toString()).apply();
 }
 @Override public void onBackPressed(){web.evaluateJavascript("window.dispatchEvent(new Event('spektralab-close'))",null);}
 @Override protected void onPause(){web.evaluateJavascript("window.dispatchEvent(new Event('spektralab-pause'))",null);super.onPause();}
 @Override protected void onDestroy(){if(systemBackCallback!=null&&Build.VERSION.SDK_INT>=33)getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(systemBackCallback);if(host!=null)host.destroy();for(File f:binaries.values())f.delete();if(thermalListener!=null)((PowerManager)getSystemService(POWER_SERVICE)).removeThermalStatusListener(thermalListener);hostLogs.shutdownNow();calls.shutdownNow();io.shutdownNow();web.removeJavascriptInterface("SpektraAndroid");web.destroy();super.onDestroy();}
}
