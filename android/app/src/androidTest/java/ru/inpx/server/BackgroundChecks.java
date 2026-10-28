package ru.inpx.server;

import android.app.ActivityManager;
import android.content.Context;
import android.os.SystemClock;
import java.io.File;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONArray;
import org.json.JSONObject;

/** Fault injection stays in the test APK; the production APK has no crash command. */
final class BackgroundChecks {
  interface Condition {
    boolean ready() throws Exception;
  }

  private static void await(Condition condition, long timeout, String label) throws Exception {
    long end = SystemClock.elapsedRealtime() + timeout;
    while (SystemClock.elapsedRealtime() < end) {
      if (condition.ready()) return;
      SystemClock.sleep(300);
    }
    throw new AssertionError(label);
  }

  private static int pid(Context context) {
    for (ActivityManager.RunningAppProcessInfo p :
        context.getSystemService(ActivityManager.class).getRunningAppProcesses())
      if (p.processName.equals(context.getPackageName() + ":server")) return p.pid;
    return 0;
  }

  private static boolean ready(int port) {
    HttpURLConnection connection = null;
    try {
      connection =
          (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/ready").openConnection();
      connection.setConnectTimeout(700);
      connection.setReadTimeout(700);
      return connection.getResponseCode() == 200
          && new JSONObject(Io.read(connection.getInputStream())).optBoolean("ready");
    } catch (Exception e) {
      return false;
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  static JSONObject run(Context context) throws Exception {
    JSONObject before = ServerControl.read(context), report = new JSONObject();
    JSONArray checks = new JSONArray();
    report.put("checks", checks);
    int port = 12380;
    try {
      ServerControl.stop(context);
      await(() -> pid(context) == 0, 15000, "Previous server must stop");
      File data = new File(context.getFilesDir(), "data");
      data.mkdirs();
      File converted = new File(data, "converter-checks.json");
      converted.delete();
      Io.write(new File(data, "converter-checks.request"), "test");
      ServerControl.start(context, true, port);
      ServerControl.requestService(context);
      await(() -> converted.exists(), 180000, "Converter preflight must finish");
      JSONObject conversions = new JSONObject(Io.read(converted));
      report.put("converters", conversions);
      if (!conversions.optBoolean("passed"))
        throw new AssertionError("Native conversion failed: " + conversions);
      await(() -> ready(port), 60000, "Demo server must become ready");
      checks.put("All seven native conversion formats pass");
      android.service.notification.StatusBarNotification[] notifications =
          context.getSystemService(android.app.NotificationManager.class).getActiveNotifications();
      if (notifications.length != 1) throw new AssertionError("Foreground notification missing");
      android.graphics.drawable.Drawable icon =
          notifications[0].getNotification().getSmallIcon().loadDrawable(context);
      if (icon instanceof android.graphics.drawable.Animatable)
        throw new AssertionError("Status icon is animated");
      checks.put("Foreground notification uses a static icon");
      int first = pid(context);
      if (first == 0) throw new AssertionError("Server PID missing");
      android.os.Process.killProcess(first);
      await(
          () -> pid(context) != 0 && pid(context) != first && ready(port),
          90000,
          "Sticky foreground service must recover after process death");
      report.put("originalPid", first).put("restartedPid", pid(context));
      checks.put("Unexpected process death restarts server and HTTP");
      ServerControl.stop(context);
      await(() -> pid(context) == 0, 20000, "Manual stop must terminate service");
      SystemClock.sleep(6000);
      if (pid(context) != 0 || ServerControl.read(context).optBoolean("requested"))
        throw new AssertionError("Manual stop unexpectedly restarted");
      checks.put("Manual stop remains stopped");
      JSONArray offlineSources =
          new JSONArray()
              .put(
                  new JSONObject()
                      .put("id", "demo")
                      .put("name", "Offline test")
                      .put("kind", "local")
                      .put(
                          "path",
                          new File(context.getFilesDir(), "missing-test-source")
                              .getAbsolutePath()));
      File cached = new File(context.getFilesDir(), "source-indexes/demo.inpx");
      byte[] previousIndex = java.nio.file.Files.readAllBytes(cached.toPath());
      StorageBridge offline = new StorageBridge(context, offlineSources);
      try {
        if (IndexCache.refresh(context, offline, offlineSources).length() != 1
            || !java.util.Arrays.equals(
                previousIndex, java.nio.file.Files.readAllBytes(cached.toPath())))
          throw new AssertionError("Offline source lost cached index");
      } finally {
        offline.close();
      }
      checks.put("Unavailable source keeps the last valid INPX");
      ServerControl.start(context, true, port);
      if (!ServerControl.recordAttempt(context)
          || !ServerControl.recordAttempt(context)
          || !ServerControl.recordAttempt(context)
          || ServerControl.recordAttempt(context))
        throw new AssertionError("Crash loop cap failed");
      checks.put("Fourth launch within ten minutes is blocked");
      ServerControl.stop(context);
      report.put("passed", true);
      return report;
    } catch (Throwable e) {
      report.put("passed", false).put("error", e.toString());
      return report;
    } finally {
      ServerControl.settings(
          context,
          before.optBoolean("keepAwake", true),
          before.optBoolean("autoBoot"),
          before.optBoolean("stopOnBattery"));
      // Restore the user's selected library after testing the isolated bundled demo.
      boolean hasSources = new JSONArray(Vault.read(context)).length() > 0;
      ServerControl.start(context, !hasSources, before.optInt("port", port));
      ServerControl.requestService(context);
      Io.write(
          new File(context.getExternalFilesDir(null), "background-checks.json"),
          report.toString(2));
    }
  }
}
