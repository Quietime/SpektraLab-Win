package app.spektralab.checks;
import android.content.*;import android.net.Uri;import android.database.*;import android.os.*;import android.graphics.*;import java.io.*;
/** Read-only fixture provider in the separate test APK. */
public final class FixtureProvider extends ContentProvider {
 private File fixture;
 @Override public boolean onCreate(){try{fixture=new File(getContext().getFilesDir(),"测试照片.png");Bitmap b=Bitmap.createBitmap(96,64,Bitmap.Config.ARGB_8888);for(int y=0;y<64;y++)for(int x=0;x<96;x++)b.setPixel(x,y,Color.rgb(x*255/95,y*255/63,120));try(OutputStream out=new FileOutputStream(fixture)){b.compress(Bitmap.CompressFormat.PNG,100,out);}b.recycle();return true;}catch(Exception e){return false;}}
 @Override public Cursor query(Uri uri,String[] projection,String selection,String[] args,String order){String[] columns=projection==null?new String[]{"_display_name","_size"}:projection;MatrixCursor result=new MatrixCursor(columns);Object[] row=new Object[columns.length];for(int i=0;i<columns.length;i++)row[i]=columns[i].equals("_display_name")?"测试照片.png":columns[i].equals("_size")?fixture.length():null;result.addRow(row);return result;}
 @Override public String getType(Uri uri){return "image/png";}
 @Override public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException{if(!mode.equals("r"))throw new FileNotFoundException("Read-only fixture");return ParcelFileDescriptor.open(fixture,ParcelFileDescriptor.MODE_READ_ONLY);}
 @Override public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
 @Override public int update(Uri uri,ContentValues values,String where,String[] args){throw new UnsupportedOperationException();}
 @Override public int delete(Uri uri,String where,String[] args){throw new UnsupportedOperationException();}
}
