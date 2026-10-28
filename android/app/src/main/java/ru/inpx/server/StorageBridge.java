package ru.inpx.server;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.ParcelFileDescriptor;
import android.os.ProxyFileDescriptorCallback;
import android.os.storage.StorageManager;
import android.provider.DocumentsContract;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import com.hierynomus.msdtyp.AccessMask;
import com.hierynomus.mserref.NtStatus;
import com.hierynomus.msfscc.FileAttributes;
import com.hierynomus.msfscc.fileinformation.FileAllInformation;
import com.hierynomus.msfscc.fileinformation.FileIdBothDirectoryInformation;
import com.hierynomus.mssmb2.SMB2CreateDisposition;
import com.hierynomus.mssmb2.SMB2CreateOptions;
import com.hierynomus.mssmb2.SMB2ShareAccess;
import com.hierynomus.mssmb2.SMBApiException;
import com.hierynomus.smbj.SMBClient;
import com.hierynomus.smbj.SmbConfig;
import com.hierynomus.smbj.auth.AuthenticationContext;
import com.hierynomus.smbj.connection.Connection;
import com.hierynomus.smbj.session.Session;
import com.hierynomus.smbj.share.DiskShare;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/** Read-only mounts. Node receives real seekable descriptors, including SMB proxy descriptors. */
public final class StorageBridge implements AutoCloseable {
  public static final String PREFIX = "/__android_library__/";
  private final Context context;
  private final Map<String, JSONObject> sources = new HashMap<>();
  private final Map<String, Object> locks = new HashMap<>();
  private final Map<String, Uri> documentUris = new ConcurrentHashMap<>();
  private final Map<String, SmbMount> smb = new ConcurrentHashMap<>();
  private volatile boolean closed;
  private final HandlerThread io = new HandlerThread("inpx-storage");
  private final Handler handler;

  StorageBridge(Context context, JSONArray config) throws Exception {
    this.context = context;
    for (int i = 0; i < config.length(); i++) {
      JSONObject s = config.getJSONObject(i);
      if (!s.getString("id").matches("[a-zA-Z0-9_-]+")) throw new IOException("Invalid source id");
      sources.put(s.getString("id"), s);
      locks.put(s.getString("id"), new Object());
    }
    io.start();
    handler = new Handler(io.getLooper());
  }

  private String[] resolve(String path) throws IOException {
    if (!path.startsWith(PREFIX)) throw new IOException("Path outside library mounts");
    String[] parts = path.substring(PREFIX.length()).split("/", 2);
    if (!sources.containsKey(parts[0])) throw new FileNotFoundException("Source unavailable");
    String relative = parts.length == 2 ? parts[1] : "";
    for (String p : relative.split("/", -1)) {
      if (p.equals("..") || p.equals(".") || p.indexOf('\\') >= 0 || p.indexOf('\0') >= 0)
        throw new IOException("Invalid library path");
    }
    return new String[] {parts[0], relative};
  }

  static final class Failure extends IOException {
    final String code;

    Failure(String code, String message) {
      super(message);
      this.code = code;
    }
  }

  static Failure failure(JSONObject source, Throwable error) {
    for (Throwable e = error; e != null; e = e.getCause())
      if (e instanceof ErrnoException && ((ErrnoException) e).errno == OsConstants.ENOSPC)
        return new Failure(
            "ENOSPC",
            "Недостаточно места для индекса или временных файлов. Освободите память приложения.");
    for (Throwable e = error; e != null; e = e.getCause()) {
      if (e instanceof Failure) return (Failure) e;
      if (e instanceof SecurityException)
        return new Failure("EACCES", "Нет доступа к папке. Выберите её заново и разрешите чтение.");
      if (e instanceof SMBApiException) {
        NtStatus status = ((SMBApiException) e).getStatus();
        if (status == NtStatus.STATUS_LOGON_FAILURE
            || status == NtStatus.STATUS_PASSWORD_EXPIRED
            || status == NtStatus.STATUS_ACCOUNT_DISABLED)
          return new Failure(
              "EAUTH", "Не удалось войти на SMB-сервер. Проверьте логин, пароль и домен.");
        if (status == NtStatus.STATUS_ACCESS_DENIED)
          return new Failure(
              "EACCES", "SMB-сервер отказал в чтении. Проверьте права на общую папку.");
        if (status == NtStatus.STATUS_OBJECT_NAME_NOT_FOUND
            || status == NtStatus.STATUS_OBJECT_PATH_NOT_FOUND
            || status == NtStatus.STATUS_NO_SUCH_FILE)
          return new Failure("ENOENT", "Файл или подпапка не найдены.");
        if (status == NtStatus.STATUS_BAD_NETWORK_NAME)
          return new Failure("ESHARE", "Общая папка SMB не найдена. Проверьте её имя.");
      }
      if (e instanceof FileNotFoundException)
        return new Failure("ENOENT", "Файл или папка не найдены.");
      if (e instanceof java.util.zip.ZipException)
        return new Failure(
            "EINDEX", "Не удалось прочитать INPX: повреждённый ZIP. Сохранённый индекс оставлен.");
    }
    if (source != null && source.optString("kind").equals("smb"))
      return new Failure("ENETUNREACH", "SMB-сервер недоступен. Проверьте сеть и питание NAS.");
    if (source != null && source.optString("kind").equals("tree"))
      return new Failure("ENODEV", "Накопитель недоступен. Подключите его и повторите проверку.");
    return new Failure(
        "EIO", "Не удалось прочитать источник. Проверьте доступ и свободное место приложения.");
  }

  void clearDocumentCache(String id) {
    documentUris.keySet().removeIf(key -> key.startsWith(id + "/"));
  }

  private void invalidate(String id) {
    clearDocumentCache(id);
    SmbMount previous = smb.remove(id);
    if (previous != null) previous.close();
  }

  private static boolean retryable(JSONObject source, Failure error) {
    return source.optString("kind").equals("smb") && error.code.equals("ENETUNREACH")
        || source.optString("kind").equals("tree")
            && (error.code.equals("ENOENT") || error.code.equals("ENODEV"));
  }

  public String call(String operation, String path) {
    JSONObject source = null;
    try {
      if (operation.equals("shutdown")) {
        context.stopService(new android.content.Intent(context, ServerService.class));
        return "{\"value\":true}";
      }
      String[] parts = resolve(path);
      source = sources.get(parts[0]);
      synchronized (locks.get(parts[0])) {
        if (closed) throw new Failure("ENODEV", "Источник закрыт");
        for (int attempt = 0; ; attempt++) {
          try {
            return new JSONObject().put("value", dispatch(operation, source, parts[1])).toString();
          } catch (Exception e) {
            Failure problem = failure(source, e);
            if (attempt == 0 && retryable(source, problem)) {
              invalidate(parts[0]);
              continue;
            }
            if (source.optString("kind").equals("smb") && !problem.code.equals("ENOENT"))
              invalidate(parts[0]);
            if (operation.equals("list") && parts[1].isEmpty() && problem.code.equals("ENOENT"))
              problem =
                  new Failure(
                      source.optString("kind").equals("smb") ? "ENOENT" : "ENODEV",
                      "Папка источника недоступна. Проверьте подключение и выбранную папку.");
            SourceHealth.failed(context, source, problem);
            throw problem;
          }
        }
      }
    } catch (Exception e) {
      Failure problem = failure(source, e);
      try {
        return new JSONObject()
            .put("error", problem.code)
            .put("message", problem.getMessage())
            .toString();
      } catch (Exception ignored) {
        return "{\"error\":\"EIO\",\"message\":\"Storage error\"}";
      }
    }
  }

  private Object dispatch(String operation, JSONObject source, String relative) throws Exception {
    switch (operation) {
      case "stat":
        return stat(source, relative);
      case "list":
        return list(source, relative);
      case "open":
        return open(source, relative);
      default:
        throw new Failure("EINVAL", "Неизвестная операция");
    }
  }

  private JSONObject info(String name, boolean directory, long size, long modified)
      throws Exception {
    return new JSONObject()
        .put("name", name)
        .put("directory", directory)
        .put("size", size)
        .put("modified", modified);
  }

  private File local(JSONObject s, String relative) throws Exception {
    File root = new File(s.getString("path")).getCanonicalFile();
    File target = new File(root, relative).getCanonicalFile();
    if (!target.equals(root) && !target.getPath().startsWith(root.getPath() + File.separator))
      throw new SecurityException("Path outside source");
    if (!target.exists()) throw new FileNotFoundException(relative);
    return target;
  }

  private Uri document(JSONObject s, String relative) throws Exception {
    String key = s.getString("id") + "/" + relative;
    Uri cached = documentUris.get(key);
    if (cached != null) return cached;
    Uri tree = Uri.parse(s.getString("uri"));
    String documentId = DocumentsContract.getTreeDocumentId(tree);
    if (!relative.isEmpty())
      for (String part : relative.split("/")) {
        if (part.isEmpty()) continue;
        String found = null;
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, documentId);
        try (Cursor c =
            context
                .getContentResolver()
                .query(
                    children,
                    new String[] {
                      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                      DocumentsContract.Document.COLUMN_DISPLAY_NAME
                    },
                    null,
                    null,
                    null)) {
          if (c == null) throw new IOException("Накопитель недоступен");
          while (c.moveToNext())
            if (part.equals(c.getString(1))) {
              found = c.getString(0);
              break;
            }
        }
        if (found == null) throw new FileNotFoundException(relative);
        documentId = found;
      }
    Uri result = DocumentsContract.buildDocumentUriUsingTree(tree, documentId);
    documentUris.put(key, result);
    return result;
  }

  private JSONObject cursorInfo(Cursor c) throws Exception {
    boolean dir = DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(1));
    if (!dir && c.isNull(2)) throw new IOException("Провайдер не сообщает размер файла");
    return info(c.getString(0), dir, c.getLong(2), c.getLong(3));
  }

  private final String[] columns = {
    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
    DocumentsContract.Document.COLUMN_MIME_TYPE,
    DocumentsContract.Document.COLUMN_SIZE,
    DocumentsContract.Document.COLUMN_LAST_MODIFIED
  };

  private JSONObject stat(JSONObject s, String relative) throws Exception {
    // A configured mount exists even when its removable/network storage is temporarily offline.
    if (relative.isEmpty()) return info(s.getString("name"), true, 0, 0);
    switch (s.getString("kind")) {
      case "local":
        {
          File f = local(s, relative);
          return info(f.getName(), f.isDirectory(), f.length(), f.lastModified());
        }
      case "tree":
        {
          try (Cursor c =
              context
                  .getContentResolver()
                  .query(document(s, relative), columns, null, null, null)) {
            if (c == null || !c.moveToFirst()) throw new FileNotFoundException(relative);
            return cursorInfo(c);
          }
        }
      case "smb":
        {
          SmbMount mount = mount(s);
          String p = mount.path(relative);
          if (p.isEmpty()) return info(s.getString("name"), true, 0, 0);
          FileAllInformation i = mount.share.getFileInformation(p);
          return info(
              new File(relative).getName(),
              i.getStandardInformation().isDirectory(),
              i.getStandardInformation().getEndOfFile(),
              i.getBasicInformation().getLastWriteTime().toEpochMillis());
        }
      default:
        throw new IOException("Unknown source type");
    }
  }

  private JSONArray list(JSONObject s, String relative) throws Exception {
    JSONArray entries = new JSONArray();
    switch (s.getString("kind")) {
      case "local":
        {
          File[] files = local(s, relative).listFiles();
          if (files == null) throw new IOException("Cannot list folder");
          for (File f : files)
            entries.put(info(f.getName(), f.isDirectory(), f.length(), f.lastModified()));
          break;
        }
      case "tree":
        {
          Uri doc = document(s, relative);
          Uri tree = Uri.parse(s.getString("uri"));
          Uri children =
              DocumentsContract.buildChildDocumentsUriUsingTree(
                  tree, DocumentsContract.getDocumentId(doc));
          try (Cursor c = context.getContentResolver().query(children, columns, null, null, null)) {
            if (c == null) throw new IOException("Накопитель недоступен");
            while (c.moveToNext()) entries.put(cursorInfo(c));
          }
          break;
        }
      case "smb":
        {
          SmbMount mount = mount(s);
          for (FileIdBothDirectoryInformation i : mount.share.list(mount.path(relative))) {
            if (i.getFileName().equals(".") || i.getFileName().equals("..")) continue;
            entries.put(
                info(
                    i.getFileName(),
                    (i.getFileAttributes() & 16) != 0,
                    i.getEndOfFile(),
                    i.getLastWriteTime().toEpochMillis()));
          }
          break;
        }
      default:
        throw new IOException("Unknown source type");
    }
    return entries;
  }

  private int open(JSONObject s, String relative) throws Exception {
    ParcelFileDescriptor descriptor;
    switch (s.getString("kind")) {
      case "local":
        descriptor =
            ParcelFileDescriptor.open(local(s, relative), ParcelFileDescriptor.MODE_READ_ONLY);
        break;
      case "tree":
        descriptor = context.getContentResolver().openFileDescriptor(document(s, relative), "r");
        break;
      case "smb":
        {
          com.hierynomus.smbj.share.File file = openRemote(s, relative);
          try {
            FileAllInformation original = file.getFileInformation();
            long size = original.getStandardInformation().getEndOfFile();
            long modified = original.getBasicInformation().getLastWriteTime().toEpochMillis();
            descriptor =
                context
                    .getSystemService(StorageManager.class)
                    .openProxyFileDescriptor(
                        ParcelFileDescriptor.MODE_READ_ONLY,
                        new ProxyFileDescriptorCallback() {
                          private com.hierynomus.smbj.share.File current = file;
                          private boolean stale;

                          @Override
                          public long onGetSize() {
                            return size;
                          }

                          @Override
                          public int onRead(long offset, int length, byte[] data)
                              throws ErrnoException {
                            synchronized (locks.get(s.optString("id"))) {
                              try {
                                if (closed) throw new Failure("ENODEV", "Источник закрыт");
                                if (stale)
                                  throw new Failure(
                                      "ESTALE", "Архив изменился. Повторите скачивание книги.");
                                try {
                                  return Math.max(current.read(data, offset, 0, length), 0);
                                } catch (Exception e) {
                                  Failure problem = failure(s, e);
                                  if (!retryable(s, problem)) throw problem;
                                  invalidate(s.optString("id"));
                                  // Resume the granted seekable descriptor at the requested offset.
                                  current = openRemote(s, relative);
                                  FileAllInformation replacement = current.getFileInformation();
                                  if (replacement.getStandardInformation().getEndOfFile() != size
                                      || replacement
                                              .getBasicInformation()
                                              .getLastWriteTime()
                                              .toEpochMillis()
                                          != modified) {
                                    stale = true;
                                    throw new Failure(
                                        "ESTALE", "Архив изменился. Повторите скачивание книги.");
                                  }
                                  return Math.max(current.read(data, offset, 0, length), 0);
                                }
                              } catch (Exception e) {
                                Failure problem = failure(s, e);
                                if (!problem.code.equals("ENOENT")
                                    && !problem.code.equals("ESTALE"))
                                  invalidate(s.optString("id"));
                                SourceHealth.failed(context, s, problem);
                                throw new ErrnoException(
                                    "SMB read",
                                    problem.code.equals("ESTALE")
                                        ? OsConstants.ESTALE
                                        : OsConstants.EIO);
                              }
                            }
                          }

                          @Override
                          public void onRelease() {
                            try {
                              current.close();
                            } catch (Exception ignored) {
                            }
                          }
                        },
                        handler);
          } catch (Exception e) {
            file.close();
            throw e;
          }
          break;
        }
      default:
        throw new IOException("Unknown source type");
    }
    if (descriptor == null) throw new IOException("Cannot open file");
    try {
      Os.lseek(descriptor.getFileDescriptor(), 0, OsConstants.SEEK_CUR);
      return descriptor.detachFd();
    } finally {
      descriptor.close();
    }
  }

  private com.hierynomus.smbj.share.File openRemote(JSONObject source, String relative)
      throws Exception {
    SmbMount mount = mount(source);
    return mount.share.openFile(
        mount.path(relative),
        EnumSet.of(AccessMask.GENERIC_READ),
        EnumSet.noneOf(FileAttributes.class),
        SMB2ShareAccess.ALL,
        SMB2CreateDisposition.FILE_OPEN,
        EnumSet.of(SMB2CreateOptions.FILE_NON_DIRECTORY_FILE));
  }

  private SmbMount mount(JSONObject s) throws Exception {
    String id = s.getString("id");
    SmbMount current = smb.get(id);
    if (current != null && current.connection.isConnected()) return current;
    if (current != null) {
      smb.remove(id);
      current.close();
    }
    current = new SmbMount(s);
    smb.put(id, current);
    return current;
  }

  private static class SmbMount implements AutoCloseable {
    final SMBClient client;
    Connection connection;
    Session session;
    DiskShare share;
    final String folder;

    SmbMount(JSONObject s) throws Exception {
      client =
          new SMBClient(
              SmbConfig.builder().withTimeout(15, TimeUnit.SECONDS).withSoTimeout(15000).build());
      try {
        java.net.URI address = new java.net.URI("smb://" + s.getString("host"));
        if (address.getHost() == null
            || address.getUserInfo() != null
            || (address.getPath() != null && !address.getPath().isEmpty()))
          throw new Failure("EINVAL", "Укажите имя сервера или адрес:порт");
        connection =
            client.connect(address.getHost(), address.getPort() == -1 ? 445 : address.getPort());
        session =
            connection.authenticate(
                new AuthenticationContext(
                    s.optString("user"),
                    s.optString("password").toCharArray(),
                    s.optString("domain")));
        try {
          share = (DiskShare) session.connectShare(s.getString("share"));
        } catch (SMBApiException e) {
          NtStatus status = e.getStatus();
          if (status == NtStatus.STATUS_OBJECT_PATH_NOT_FOUND
              || status == NtStatus.STATUS_OBJECT_NAME_NOT_FOUND
              || status == NtStatus.STATUS_BAD_NETWORK_NAME)
            throw new Failure("ESHARE", "Общая папка SMB не найдена. Проверьте её имя.");
          throw e;
        }
        folder = s.optString("folder").replace('/', '\\').replaceAll("^\\\\+|\\\\+$", "");
        for (String p : folder.split("\\\\"))
          if (p.equals("..") || p.equals("."))
            throw new Failure("EINVAL", "Некорректная подпапка SMB");
      } catch (Exception e) {
        close();
        throw e;
      }
    }

    String path(String relative) {
      return folder.isEmpty()
          ? relative.replace('/', '\\')
          : relative.isEmpty() ? folder : folder + "\\" + relative.replace('/', '\\');
    }

    @Override
    public void close() {
      // A broken transport must not wait for remote logoff before a new connection can be made.
      try {
        if (connection != null) connection.close(true);
      } catch (Exception ignored) {
      }
      try {
        client.close();
      } catch (Exception ignored) {
      }
    }
  }

  @Override
  public void close() {
    closed = true;
    for (String id : sources.keySet())
      synchronized (locks.get(id)) {
        invalidate(id);
      }
    io.quitSafely();
  }
}
