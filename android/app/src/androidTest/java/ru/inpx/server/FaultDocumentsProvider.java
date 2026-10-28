package ru.inpx.server;

import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract.Document;
import android.provider.DocumentsContract.Root;
import android.provider.DocumentsProvider;
import java.io.File;
import java.io.FileNotFoundException;
import java.nio.file.Files;

/** Deterministic removable-storage failures, isolated in the test APK. */
public final class FaultDocumentsProvider extends DocumentsProvider {
  private int generation = 1;
  private String mode = "online";
  private File root;

  @Override
  public boolean onCreate() {
    root = new File(getContext().getFilesDir(), "documents-fixture");
    root.mkdirs();
    return true;
  }

  @Override
  public synchronized Bundle call(String method, String arg, Bundle extras) {
    if (method.startsWith("fixture-"))
      try {
        int caller = android.os.Binder.getCallingUid();
        if (caller != android.os.Process.myUid()
            && caller != getContext().getPackageManager().getPackageUid("ru.inpx.server", 0))
          throw new SecurityException("Fixture access denied");
      } catch (android.content.pm.PackageManager.NameNotFoundException e) {
        throw new SecurityException(e);
      }
    if (method.equals("fixture-grant")) {
      getContext()
          .grantUriPermission(
              "ru.inpx.server",
              android.provider.DocumentsContract.buildTreeDocumentUri(
                  "ru.inpx.server.test.storage", "root"),
              android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
                  | android.content.Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
      return new Bundle();
    }
    if (method.equals("fixture-mode")) {
      mode = arg;
      if (mode.equals("online")) generation++;
      return new Bundle();
    }
    if (method.equals("fixture-put")) {
      try {
        File target = file(arg);
        Files.write(target.toPath(), extras.getByteArray("bytes"));
        target.setLastModified(System.currentTimeMillis());
        return new Bundle();
      } catch (Exception e) {
        throw new IllegalArgumentException(e);
      }
    }
    return super.call(method, arg, extras);
  }

  private File file(String name) throws Exception {
    File file = new File(root, name).getCanonicalFile();
    if (!file.getParentFile().equals(root.getCanonicalFile()))
      throw new SecurityException("Invalid fixture name");
    return file;
  }

  private void available() throws FileNotFoundException {
    if (mode.equals("denied")) throw new SecurityException("Fixture permission revoked");
    if (!mode.equals("online")) throw new FileNotFoundException("Fixture disconnected");
  }

  private void document(MatrixCursor cursor, String id, File file) {
    MatrixCursor.RowBuilder row = cursor.newRow();
    for (String column : cursor.getColumnNames()) {
      Object value = null;
      if (column.equals(Document.COLUMN_DOCUMENT_ID)) value = id;
      if (column.equals(Document.COLUMN_DISPLAY_NAME))
        value = file == null ? "Fixture" : file.getName();
      if (column.equals(Document.COLUMN_MIME_TYPE))
        value = file == null ? Document.MIME_TYPE_DIR : "application/octet-stream";
      if (column.equals(Document.COLUMN_SIZE)) value = file == null ? 0 : file.length();
      if (column.equals(Document.COLUMN_LAST_MODIFIED))
        value = file == null ? 0 : file.lastModified();
      if (column.equals(Document.COLUMN_FLAGS)) value = 0;
      row.add(value);
    }
  }

  private String[] columns(String[] requested) {
    return requested == null
        ? new String[] {
          Document.COLUMN_DOCUMENT_ID,
          Document.COLUMN_DISPLAY_NAME,
          Document.COLUMN_MIME_TYPE,
          Document.COLUMN_SIZE,
          Document.COLUMN_LAST_MODIFIED
        }
        : requested;
  }

  @Override
  public synchronized Cursor queryRoots(String[] projection) {
    MatrixCursor cursor =
        new MatrixCursor(
            new String[] {
              Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE, Root.COLUMN_FLAGS
            });
    cursor.addRow(new Object[] {"root", "root", "INPX test", Root.FLAG_SUPPORTS_IS_CHILD});
    return cursor;
  }

  @Override
  public synchronized Cursor queryDocument(String id, String[] projection)
      throws FileNotFoundException {
    available();
    MatrixCursor cursor = new MatrixCursor(columns(projection));
    if (id.equals("root")) {
      document(cursor, id, null);
      return cursor;
    }
    File file = resolve(id);
    document(cursor, id, file);
    return cursor;
  }

  @Override
  public synchronized Cursor queryChildDocuments(String id, String[] projection, String sort)
      throws FileNotFoundException {
    available();
    if (!id.equals("root")) throw new FileNotFoundException(id);
    MatrixCursor cursor = new MatrixCursor(columns(projection));
    for (File file : root.listFiles()) document(cursor, generation + "/" + file.getName(), file);
    return cursor;
  }

  private File resolve(String id) throws FileNotFoundException {
    if (!id.startsWith(generation + "/")) throw new FileNotFoundException("Stale document ID");
    try {
      File file = file(id.substring(id.indexOf('/') + 1));
      if (!file.exists()) throw new FileNotFoundException(id);
      return file;
    } catch (FileNotFoundException e) {
      throw e;
    } catch (Exception e) {
      throw new FileNotFoundException();
    }
  }

  @Override
  public boolean isChildDocument(String parent, String child) {
    return parent.equals("root") && (child.equals("root") || child.matches("[0-9]+/[^/]+"));
  }

  @Override
  public synchronized ParcelFileDescriptor openDocument(
      String id, String mode, CancellationSignal signal) throws FileNotFoundException {
    available();
    if (!mode.equals("r")) throw new SecurityException("Read-only fixture");
    return ParcelFileDescriptor.open(resolve(id), ParcelFileDescriptor.MODE_READ_ONLY);
  }
}
