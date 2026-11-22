package ru.inpx.server;

import android.content.Context;
import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONObject;

/** Runs the Android ELF from the package's executable native-library directory. */
final class RustRuntime {
  private final Context context;
  private final File data, runtime;
  private final int port;
  private final StorageBridge storage;
  private volatile Process process;
  private volatile RustStorageBroker broker;
  private volatile boolean stopping;
  private String previousProgress = "";

  RustRuntime(Context context, File data, File runtime, int port, StorageBridge storage) {
    this.context = context;
    this.data = data;
    this.runtime = runtime;
    this.port = port;
    this.storage = storage;
  }

  void run() throws Exception {
    try (RustStorageBroker storageBroker = new RustStorageBroker(storage)) {
      broker = storageBroker;
      run(storageBroker.name);
    } finally {
      broker = null;
    }
  }

  private void run(String storageSocket) throws Exception {
    File executable = new File(context.getApplicationInfo().nativeLibraryDir, "libinpxserver.so");
    File log = new File(data, "node.log");
    ProcessBuilder builder = new ProcessBuilder(executable.getAbsolutePath(), "--standalone",
        "--data-dir=" + data.getAbsolutePath(), "--config=" + new File(data, "config.json"),
        "--web-bundle=" + new File(runtime, "public.json"));
    builder.directory(data).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(log));
    builder.environment().put("INPX_AUTH_EXEMPT_HEALTH", "true");
    builder.environment().put("INPX_ANDROID_STORAGE_SOCKET", storageSocket);
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
      RustStorageBroker current = broker;
      if (current != null && process != null && process.isAlive()) {
        long rss = current.rssBytes();
        if (rss > 0) Io.writeAtomic(new File(data, "memory.json"),
            new JSONObject().put("at", System.currentTimeMillis()).put("rss", rss).toString());
      }
      connection = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/ready").openConnection();
      connection.setConnectTimeout(700);
      connection.setReadTimeout(700);
      int code = connection.getResponseCode();
      if (code != 200 && code != 503) return;
      try (InputStream input = code == 200 ? connection.getInputStream() : connection.getErrorStream()) {
        if (input == null) return;
        JSONObject status = new JSONObject(Io.read(input));
        boolean ready = status.optBoolean("ready");
        boolean updating = status.optBoolean("updating");
        String stage = ready && !updating ? "Rust-сервер в сети"
            : status.optString("jobMessage", "Индексация библиотеки");
        String detail = status.optString("sourceName");
        long records = status.optLong("recsLoaded");
        if (records > 0) detail += " · " + records + " записей";
        double fraction = status.optDouble("progress", -1);
        int percent = fraction >= 0 && fraction <= 1 ? (int) Math.round(fraction * 100) : -1;
        String signature = stage + "\n" + detail + "\n" + percent;
        if (!signature.equals(previousProgress)) {
          ServerStartupProgress.write(context, stage, detail, percent, ready);
          previousProgress = signature;
        }
      }
    } catch (Exception ignored) {
    } finally {if (connection != null) connection.disconnect();}
  }
}
