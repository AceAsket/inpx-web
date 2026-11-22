package ru.inpx.server;

import android.content.Context;
import android.net.Uri;
import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONArray;
import org.json.JSONObject;

/** Runs the Android ELF from the package's executable native-library directory. */
final class RustRuntime {
  private final Context context;
  private final File data, runtime;
  private final int port;
  private volatile Process process;
  private volatile boolean stopping;
  private String previousProgress = "";

  RustRuntime(Context context, File data, File runtime, int port) {
    this.context = context;
    this.data = data;
    this.runtime = runtime;
    this.port = port;
  }

  static JSONArray libraries(JSONArray sources, JSONArray cached) throws Exception {
    for (int i = 0; i < cached.length(); i++) {
      JSONObject library = cached.getJSONObject(i);
      JSONObject source = null;
      for (int j = 0; j < sources.length(); j++)
        if (sources.getJSONObject(j).getString("id").equals(library.getString("id")))
          source = sources.getJSONObject(j);
      if (source == null) throw new Exception("Источник библиотеки изменился");
      String path = source.optString("path");
      if (source.optString("kind").equals("tree")) {
        Uri uri = Uri.parse(source.getString("uri"));
        if ("com.android.externalstorage.documents".equals(uri.getAuthority())) {
          String id = android.provider.DocumentsContract.getTreeDocumentId(uri);
          String[] parts = id.split(":", 2);
          File root = parts[0].equals("primary")
              ? android.os.Environment.getExternalStorageDirectory()
              : new File("/storage", parts[0]);
          path = new File(root, parts.length == 2 ? parts[1] : "").getCanonicalPath();
        }
      }
      if (path.isEmpty() || !new File(path).isDirectory() || !new File(path).canRead())
        throw new Exception("Rust preview требует прямой доступ к папке. Для проверки выберите демо-библиотеку.");
      library.put("libDir", path);
    }
    return cached;
  }

  void run() throws Exception {
    File executable = new File(context.getApplicationInfo().nativeLibraryDir, "libinpxserver.so");
    File log = new File(data, "node.log");
    ProcessBuilder builder = new ProcessBuilder(executable.getAbsolutePath(), "--standalone",
        "--data-dir=" + data.getAbsolutePath(), "--config=" + new File(data, "config.json"),
        "--web-bundle=" + new File(runtime, "public.json"));
    builder.directory(data).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(log));
    builder.environment().put("INPX_AUTH_EXEMPT_HEALTH", "true");
    builder.environment().put("INPX_LOW_MEMORY_MODE", "true");
    builder.environment().put("INPX_RESOURCE_MAX_PROCESSES", "2");
    synchronized (this) {
      if (stopping) return;
      process = builder.start();
    }
    int exit = process.waitFor();
    if (!stopping) throw new Exception("Rust-сервер завершился с кодом " + exit + ". Откройте журнал.");
  }

  synchronized void stop() {
    stopping = true;
    if (process != null) process.destroy();
  }

  synchronized void forceStop() {
    stopping = true;
    if (process != null) process.destroyForcibly();
  }

  void poll() {
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/ready").openConnection();
      connection.setConnectTimeout(700);
      connection.setReadTimeout(700);
      int code = connection.getResponseCode();
      if (code != 200 && code != 503) return;
      try (InputStream input = code == 200 ? connection.getInputStream() : connection.getErrorStream()) {
        if (input == null) return;
        JSONObject status = new JSONObject(Io.read(input));
        boolean ready = status.optBoolean("ready");
        String stage = ready ? "Rust-сервер в сети" : status.optString("jobMessage", "Индексация библиотеки");
        String detail = status.optString("sourceName");
        long records = status.optLong("recsLoaded");
        if (records > 0) detail += " · " + records + " записей";
        String signature = stage + "\n" + detail;
        if (!signature.equals(previousProgress)) {
          ServerStartupProgress.write(context, stage, detail, -1);
          previousProgress = signature;
        }
      }
    } catch (Exception ignored) {
    } finally {if (connection != null) connection.disconnect();}
  }
}
