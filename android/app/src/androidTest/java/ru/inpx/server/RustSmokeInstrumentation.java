package ru.inpx.server;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;

/** Exercises only the separately installed Rust preview and its bundled demo. */
public final class RustSmokeInstrumentation extends Instrumentation {
  private static final int PORT = 22382;
  private Context context;
  private boolean full;
  private boolean stopForUpgrade;
  private String lastUid;
  interface Condition {boolean ready() throws Exception;}

  @Override public void onCreate(Bundle args) {
    full = args != null && "true".equals(args.getString("full"));
    stopForUpgrade = args != null && "stop-for-upgrade".equals(args.getString("action"));
    super.onCreate(args); start();
  }

  @Override public void onStart() {
    context = getTargetContext();
    Bundle result = new Bundle();
    int code = Activity.RESULT_OK;
    if (stopForUpgrade) {
      try {
        if (!"ru.inpx.server".equals(context.getPackageName())) throw new AssertionError("Wrong upgrade target");
        stopServer();
        result.putString("stream", "PASS: stopped previous Android server without changing source preferences");
      } catch (Throwable error) {
        code = Activity.RESULT_CANCELED;
        result.putString("stream", android.util.Log.getStackTraceString(error));
      }
      finish(code, result);
      return;
    }
    if (!"ru.inpx.server.rust".equals(context.getPackageName())) {
      result.putString("stream", "Refusing fixture tests in the real server application");
      finish(Activity.RESULT_CANCELED, result);
      return;
    }
    try {
      context.getSharedPreferences("MainActivity", 0).edit().putString("port", Integer.toString(PORT)).commit();
      startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      ServerControl.stop(context);
      await(() -> !serviceRunning(), 25000, "Previous server did not stop");
      startServer(true);
      JSONObject state = status("/api/index-status");
      if (!"2.0.2".equals(state.optString("version"))) throw new AssertionError("Wrong Rust version");
      if (state.getJSONObject("stats").getInt("bookCountAll") != 2) throw new AssertionError("Missing books");
      if (!text("/").contains("html")) throw new AssertionError("Web UI failed");
      if (!text("/opds").contains("feed")) throw new AssertionError("OPDS failed");
      books(full);
      if (full) {
        RustFullChecks checks = new RustFullChecks(this);
        checks.reader();
        checks.sources();
        checks.cancellation();
        killedService();
      }
      stopServer();
      startServer(true);
      result.putString("stream", full
          ? "PASS: Rust 2.0.2, ZIP/7z, SAF disconnect/reconnect, SMB, 7 converters, native reader download and offline reading, stop/restart"
          : "PASS: Rust 2.0.2 on Android, indexing, Web UI, OPDS, ZIP/7z FB2 download, stop and restart");
    } catch (Throwable error) {
      code = Activity.RESULT_CANCELED;
      result.putString("stream", android.util.Log.getStackTraceString(error) + "\n" + ServerDiagnostics.journal(context));
    } finally {
      try {stopServer();}
      catch (Exception ignored) {}
      context.getSharedPreferences("MainActivity", 0).edit().remove("port").commit();
      finish(code, result);
    }
  }

  void books(boolean converters) throws Exception {
      for (String title : new String[] {"Проверка ZIP на Rust", "Проверка 7z на Rust"}) {
        String html = text("/ebook?q=" + URLEncoder.encode(title, "UTF-8"));
        Matcher link = Pattern.compile("/ebook/book\\?[^\"]*uid=([^&\"]+)").matcher(html);
        if (!link.find()) throw new AssertionError("Book missing from search: " + title);
        lastUid = link.group(1);
        String book = text("/ebook/download?uid=" + lastUid + "&format=fb2");
        if (!book.contains("Библиотека работает")) throw new AssertionError("FB2 extraction failed: " + title);
        if (converters && title.contains("ZIP")) {
          for (String format : new String[] {"epub", "epub3", "kepub", "kfx", "azw8", "mobi", "pdf"}) {
            byte[] converted = bytes("/ebook/download?uid=" + lastUid + "&format=" + format, 180000);
            if (converted.length < 100) throw new AssertionError("Empty conversion: " + format);
            String signature = new String(converted, 0, Math.min(converted.length, 100), StandardCharsets.ISO_8859_1);
            if (format.startsWith("epub") || format.equals("kepub")) {
              if (!signature.startsWith("PK")) throw new AssertionError("Invalid EPUB: " + format);
            } else if (format.equals("pdf")) {
              if (!signature.startsWith("%PDF-")) throw new AssertionError("Invalid PDF");
            } else if (format.equals("mobi") || format.equals("azw3")) {
              if (!signature.contains("BOOKMOBI")) throw new AssertionError("Invalid MOBI");
            }
            Bundle progress = new Bundle(); progress.putString("stream", "Converted " + format + ": " + converted.length + " bytes");
            sendStatus(0, progress);
          }
        }
      }
  }

  void expectMissingBook() throws Exception {
    if (!text("/ebook?q=Rust").contains("html")) throw new AssertionError("Catalog blocked by missing storage");
    try { bytes("/ebook/download?uid=" + lastUid + "&format=fb2", 10000); }
    catch (java.io.IOException expected) { return; }
    throw new AssertionError("Disconnected storage unexpectedly served a book");
  }

  void stopServer() throws Exception {
    ServerControl.stop(context);
    await(() -> !serviceRunning(), 25000, "Rust did not stop");
  }

  void startServer(boolean demo) throws Exception {
    ServerControl.start(context, demo, PORT);
    ServerControl.requestService(context);
    long[] stable = {0};
    await(() -> {
      JSONObject state = status("/api/index-status");
      JSONObject stats = state.optJSONObject("stats");
      if (state.optBoolean("ready") && !state.optBoolean("updating")
          && stats != null && stats.optInt("bookCountAll") == 2) {
        if (stable[0] == 0) stable[0] = SystemClock.elapsedRealtime();
        return SystemClock.elapsedRealtime() - stable[0] >= 600;
      }
      stable[0] = 0;
      return false;
    }, 120000, "Rust did not publish the requested two-book fixture");
  }

  boolean indexing() throws Exception {
    return status("/api/index-status").optBoolean("updating");
  }

  private boolean serviceRunning() {
    return servicePid() > 0;
  }

  private int servicePid() {
    for (ActivityManager.RunningServiceInfo service :
        context.getSystemService(ActivityManager.class).getRunningServices(20))
      if (context.getPackageName().equals(service.service.getPackageName())
          && ServerService.class.getName().equals(service.service.getClassName()) && service.pid > 0) return service.pid;
    return 0;
  }

  private void killedService() throws Exception {
    int pid = servicePid();
    if (pid <= 0) throw new AssertionError("Missing service for parent-death check");
    ServerControl.stop(context);
    android.os.Process.killProcess(pid);
    await(() -> !serviceRunning(), 25000, "Killed service stayed alive");
    await(() -> {
      try { text("/health"); return false; }
      catch (java.io.IOException expected) { return true; }
    }, 5000, "Rust survived its killed Android service");
    startServer(true);
  }

  static void await(Condition condition, long timeout, String message) throws Exception {
    long end = SystemClock.elapsedRealtime() + timeout;
    Throwable last = null;
    do {
      try {if (condition.ready()) return;}
      catch (Exception error) {last = error;}
      SystemClock.sleep(300);
    } while (SystemClock.elapsedRealtime() < end);
    throw new AssertionError(message, last);
  }

  private static JSONObject status(String path) throws Exception {return new JSONObject(text(path));}

  private static String text(String path) throws Exception {
    return new String(bytes(path, 5000), StandardCharsets.UTF_8);
  }

  private static byte[] bytes(String path, int timeout) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + PORT + path).openConnection();
    connection.setConnectTimeout(700);
    connection.setReadTimeout(timeout);
    try (java.io.InputStream input = connection.getInputStream()) {
      java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
      byte[] buffer = new byte[8192];
      int size;
      while ((size = input.read(buffer)) != -1) output.write(buffer, 0, size);
      return output.toByteArray();
    } finally {connection.disconnect();}
  }
}
