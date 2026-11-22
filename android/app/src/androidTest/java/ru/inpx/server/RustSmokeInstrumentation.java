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
  private interface Condition {boolean ready() throws Exception;}

  @Override public void onCreate(Bundle args) {super.onCreate(args); start();}

  @Override public void onStart() {
    context = getTargetContext();
    Bundle result = new Bundle();
    int code = Activity.RESULT_OK;
    try {
      if (!"ru.inpx.server.rust".equals(context.getPackageName())) throw new AssertionError("Wrong target");
      context.getSharedPreferences("MainActivity", 0).edit().putString("port", Integer.toString(PORT)).commit();
      startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      ServerControl.stop(context);
      await(() -> !serviceRunning(), 25000, "Previous server did not stop");
      ServerControl.start(context, true, PORT);
      ServerControl.requestService(context);
      await(() -> status("/ready").optBoolean("ready"), 120000, "Rust did not become ready");
      JSONObject state = status("/api/index-status");
      if (!"2.0.2".equals(state.optString("version"))) throw new AssertionError("Wrong Rust version");
      if (state.getJSONObject("stats").getInt("bookCountAll") != 2) throw new AssertionError("Missing books");
      if (!text("/").contains("html")) throw new AssertionError("Web UI failed");
      if (!text("/opds").contains("feed")) throw new AssertionError("OPDS failed");
      for (String title : new String[] {"Проверка ZIP на Rust", "Проверка 7z на Rust"}) {
        String html = text("/ebook?q=" + URLEncoder.encode(title, "UTF-8"));
        Matcher link = Pattern.compile("/ebook/book\\?[^\"]*uid=([^&\"]+)").matcher(html);
        if (!link.find()) throw new AssertionError("Book missing from search: " + title);
        String book = text("/ebook/download?uid=" + link.group(1) + "&format=fb2");
        if (!book.contains("Библиотека работает")) throw new AssertionError("FB2 extraction failed: " + title);
      }
      ServerControl.stop(context);
      await(() -> !serviceRunning(), 25000, "Rust did not stop");
      ServerControl.start(context, true, PORT);
      ServerControl.requestService(context);
      await(() -> status("/ready").optBoolean("ready"), 45000, "Rust did not restart");
      result.putString("stream", "PASS: Rust 2.0.2 on Android, indexing, Web UI, OPDS, ZIP/7z FB2 download, stop and restart");
    } catch (Throwable error) {
      code = Activity.RESULT_CANCELED;
      result.putString("stream", android.util.Log.getStackTraceString(error) + "\n" + ServerDiagnostics.journal(context));
    } finally {
      try {ServerControl.stop(context); await(() -> !serviceRunning(), 25000, "Cleanup failed");}
      catch (Exception ignored) {}
      context.getSharedPreferences("MainActivity", 0).edit().remove("port").commit();
      finish(code, result);
    }
  }

  private boolean serviceRunning() {
    for (ActivityManager.RunningServiceInfo service :
        context.getSystemService(ActivityManager.class).getRunningServices(20))
      if (ServerService.class.getName().equals(service.service.getClassName()) && service.pid > 0) return true;
    return false;
  }

  private static void await(Condition condition, long timeout, String message) throws Exception {
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
    HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + PORT + path).openConnection();
    connection.setConnectTimeout(700);
    connection.setReadTimeout(5000);
    try (java.io.InputStream input = connection.getInputStream()) {
      java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
      byte[] buffer = new byte[8192];
      int size;
      while ((size = input.read(buffer)) != -1) output.write(buffer, 0, size);
      return new String(output.toByteArray(), StandardCharsets.UTF_8);
    } finally {connection.disconnect();}
  }
}
