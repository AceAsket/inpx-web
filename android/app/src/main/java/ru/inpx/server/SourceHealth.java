package ru.inpx.server;

import android.content.Context;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/** Small, credential-free status file shared by the service and native panel. */
final class SourceHealth {
  private interface Change {
    void apply(JSONArray status) throws Exception;
  }

  private static synchronized JSONArray transaction(Context context, Change change)
      throws Exception {
    File root = context.getFilesDir();
    try (RandomAccessFile guard = new RandomAccessFile(new File(root, "source-status.lock"), "rw");
        FileLock lock = guard.getChannel().lock()) {
      AtomicFile file = new AtomicFile(new File(root, "source-status.json"));
      JSONArray status;
      try {
        status = new JSONArray(new String(file.readFully(), StandardCharsets.UTF_8));
      } catch (java.io.FileNotFoundException | org.json.JSONException e) {
        status = new JSONArray();
      }
      if (change != null) {
        change.apply(status);
        FileOutputStream output = null;
        try {
          output = file.startWrite();
          output.write(status.toString(2).getBytes(StandardCharsets.UTF_8));
          file.finishWrite(output);
        } catch (Exception e) {
          if (output != null) file.failWrite(output);
          throw e;
        }
      }
      return status;
    }
  }

  static JSONArray read(Context context) throws Exception {
    return transaction(context, null);
  }

  static JSONObject find(JSONArray values, String id) {
    for (int i = 0; i < values.length(); i++) {
      JSONObject value = values.optJSONObject(i);
      if (value != null && id.equals(value.optString("id"))) return value;
    }
    return new JSONObject();
  }

  static void record(Context context, JSONObject source, String phase, String code, String message)
      throws Exception {
    transaction(
        context,
        values -> {
          String id = source.getString("id");
          JSONObject entry = find(values, id);
          if (!entry.has("id")) values.put(entry);
          File index = new File(context.getFilesDir(), "source-indexes/" + id + ".inpx");
          long now = System.currentTimeMillis();
          entry
              .put("id", id)
              .put("name", source.optString("name"))
              .put("kind", source.optString("kind"))
              .put("phase", phase)
              .put("online", phase.equals("online"))
              .put("checkedAt", now)
              .put("code", code)
              .put("message", message)
              .put("cachedIndex", index.exists())
              .put("indexBytes", index.length())
              .put("indexUpdatedAt", index.lastModified());
          if (phase.equals("online")) entry.put("lastSuccess", now);
        });
  }

  static void failed(Context context, JSONObject source, StorageBridge.Failure failure) {
    // A missing book is not evidence that the whole source disappeared.
    if (failure.code.equals("ENOENT") || failure.code.equals("ESTALE")) return;
    try {
      record(context, source, "unavailable", failure.code, failure.getMessage());
    } catch (Exception e) {
      android.util.Log.w("INPX", "Cannot save source status");
    }
  }

  static void restartRequired(Context context, String id, boolean required) throws Exception {
    transaction(context, values -> find(values, id).put("restartRequired", required));
  }

  static void forget(Context context, java.util.Set<String> ids) throws Exception {
    transaction(
        context,
        values -> {
          for (int i = values.length() - 1; i >= 0; i--)
            if (ids.contains(values.getJSONObject(i).optString("id"))) values.remove(i);
        });
  }

  static String label(JSONObject status) {
    String phase = status.optString("phase");
    if (phase.equals("checking")) return "Проверяем подключение…";
    if (phase.equals("online") || status.optBoolean("online")) return "Доступен";
    if (phase.isEmpty() && !status.has("online")) return "Ещё не проверен";
    return status.optBoolean("cachedIndex")
        ? "Недоступен · каталог сохранён"
        : "Недоступен · нет сохранённого каталога";
  }
}
