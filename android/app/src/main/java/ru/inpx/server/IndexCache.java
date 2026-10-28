package ru.inpx.server;

import android.content.Context;
import android.os.ParcelFileDescriptor;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.zip.ZipFile;
import org.json.JSONArray;
import org.json.JSONObject;

/** Cache INPX only. Archives remain on SAF/SMB; an absent source never erases a usable index. */
final class IndexCache {
  private static Object call(StorageBridge bridge, String op, String path) throws Exception {
    JSONObject result = new JSONObject(bridge.call(op, path));
    if (result.has("error"))
      throw new StorageBridge.Failure(result.optString("error"), result.optString("message"));
    return result.get("value");
  }

  static synchronized JSONArray refresh(Context context, StorageBridge bridge, JSONArray sources)
      throws Exception {
    try (java.io.RandomAccessFile guard =
            new java.io.RandomAccessFile(
                new File(context.getFilesDir(), "source-indexes.lock"), "rw");
        java.nio.channels.FileLock lock = guard.getChannel().lock()) {
      return refreshLocked(context, bridge, sources);
    }
  }

  private static JSONArray refreshLocked(Context context, StorageBridge bridge, JSONArray sources)
      throws Exception {
    File cache = new File(context.getFilesDir(), "source-indexes");
    cache.mkdirs();
    JSONArray libraries = new JSONArray();
    for (int i = 0; i < sources.length(); i++) {
      JSONObject source = sources.getJSONObject(i);
      String id = source.getString("id"), root = StorageBridge.PREFIX + id;
      if (!id.matches("[a-zA-Z0-9_-]+")) throw new java.io.IOException("Invalid source id");
      File index = new File(cache, id + ".inpx"),
          metaFile = new File(cache, id + ".json"),
          temp = new File(cache, id + ".pending");
      JSONObject meta = new JSONObject();
      try {
        if (metaFile.exists())
          try {
            meta = new JSONObject(Io.read(metaFile));
          } catch (Exception ignored) {
          }
        SourceHealth.record(context, source, "checking", "", "");
        bridge.clearDocumentCache(id);
        String name = source.optString("inpx");
        if (name.isEmpty()) {
          JSONArray entries = (JSONArray) call(bridge, "list", root);
          int found = 0;
          for (int j = 0; j < entries.length(); j++) {
            JSONObject entry = entries.getJSONObject(j);
            if (!entry.optBoolean("directory")
                && entry.getString("name").toLowerCase(java.util.Locale.ROOT).endsWith(".inpx")) {
              name = entry.getString("name");
              found++;
            }
          }
          if (found != 1)
            throw new StorageBridge.Failure(
                "EINDEX", "В папке должен быть один INPX; найдено: " + found);
        }
        JSONObject stat = (JSONObject) call(bridge, "stat", root + "/" + name);
        boolean changed =
            !index.exists()
                || !name.equals(meta.optString("name"))
                || stat.optLong("size") != meta.optLong("size")
                || stat.optLong("modified") != meta.optLong("modified");
        if (changed) {
          int fd = ((Number) call(bridge, "open", root + "/" + name)).intValue();
          try (InputStream input =
                  new ParcelFileDescriptor.AutoCloseInputStream(ParcelFileDescriptor.adoptFd(fd));
              FileOutputStream output = new FileOutputStream(temp)) {
            byte[] buffer = new byte[65536];
            int n;
            long bytes = 0;
            while ((n = input.read(buffer)) != -1) {
              bytes += n;
              if (bytes > 1024L * 1024 * 1024)
                throw new StorageBridge.Failure("EINDEX", "INPX превышает 1 ГиБ");
              output.write(buffer, 0, n);
            }
            output.getFD().sync();
          }
          try (ZipFile zip = new ZipFile(temp)) {
            boolean hasIndex = false;
            long expanded = 0;
            byte[] buffer = new byte[65536];
            java.util.Enumeration<? extends java.util.zip.ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
              java.util.zip.ZipEntry entry = entries.nextElement();
              if (entry.isDirectory()) continue;
              hasIndex |= entry.getName().toLowerCase(java.util.Locale.ROOT).endsWith(".inp");
              java.util.zip.CRC32 crc = new java.util.zip.CRC32();
              long size = 0;
              try (InputStream input = zip.getInputStream(entry)) {
                int n;
                while ((n = input.read(buffer)) != -1) {
                  if (Thread.currentThread().isInterrupted())
                    throw new java.io.InterruptedIOException();
                  expanded += n;
                  size += n;
                  if (expanded > 8L * 1024 * 1024 * 1024)
                    throw new StorageBridge.Failure("EINDEX", "Распакованный INPX превышает 8 ГиБ");
                  crc.update(buffer, 0, n);
                }
              }
              if (size != entry.getSize() || crc.getValue() != entry.getCrc())
                throw new StorageBridge.Failure(
                    "EINDEX", "Содержимое INPX повреждено. Сохранённый индекс оставлен.");
            }
            if (!hasIndex) throw new StorageBridge.Failure("EINDEX", "В INPX нет файлов .inp");
          }
          Files.move(
              temp.toPath(),
              index.toPath(),
              StandardCopyOption.REPLACE_EXISTING,
              StandardCopyOption.ATOMIC_MOVE);
          meta.put("name", name)
              .put("size", stat.optLong("size"))
              .put("modified", stat.optLong("modified"));
          Io.write(metaFile, meta.toString());
        }
        SourceHealth.record(context, source, "online", "", "");
      } catch (Exception e) {
        StorageBridge.Failure failure = StorageBridge.failure(source, e);
        SourceHealth.record(context, source, "unavailable", failure.code, failure.getMessage());
      } finally {
        temp.delete();
      }
      if (index.exists())
        libraries.put(
            new JSONObject()
                .put("id", id)
                .put("name", source.getString("name"))
                .put("libDir", root)
                .put("inpx", index.getAbsolutePath()));
    }
    if (libraries.length() == 0)
      throw new java.io.IOException(
          "Нет доступного или сохранённого INPX. Откройте диагностику источников.");
    return libraries;
  }
}
