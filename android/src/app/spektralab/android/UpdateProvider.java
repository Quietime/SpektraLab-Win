package app.spektralab.android;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.FileNotFoundException;

/** Exposes exactly one revalidated app-private APK to Android's installer. */
public final class UpdateProvider extends ContentProvider {
 @Override public boolean onCreate(){return true;}
 private boolean permitted(Uri uri){return "content".equals(uri.getScheme())&&(getContext().getPackageName()+".updates").equals(uri.getAuthority())&&"/package".equals(uri.getPath())&&uri.getQuery()==null;}
 @Override public String getType(Uri uri){return permitted(uri)?"application/vnd.android.package-archive":null;}
 @Override public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException{if(!permitted(uri)||!"r".equals(mode))throw new FileNotFoundException("Unknown update payload");try{return new ManagedUpdater(getContext()).openValidatedPackage();}catch(Exception e){FileNotFoundException failure=new FileNotFoundException("Update is no longer verified");failure.initCause(e);throw failure;}}
 @Override public Cursor query(Uri uri,String[] projection,String selection,String[] selectionArgs,String sortOrder){if(!permitted(uri))return null;try{long size=new ManagedUpdater(getContext()).validatedApk().length();String[] columns=projection==null?new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE}:projection;MatrixCursor cursor=new MatrixCursor(columns,1);Object[] row=new Object[columns.length];for(int i=0;i<columns.length;i++){if(OpenableColumns.DISPLAY_NAME.equals(columns[i]))row[i]="SpektraLab-Update.apk";else if(OpenableColumns.SIZE.equals(columns[i]))row[i]=size;}cursor.addRow(row);return cursor;}catch(Exception e){return null;}}
 @Override public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
 @Override public int update(Uri uri,ContentValues values,String selection,String[] selectionArgs){throw new UnsupportedOperationException();}
 @Override public int delete(Uri uri,String selection,String[] selectionArgs){throw new UnsupportedOperationException();}
}
