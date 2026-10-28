package ru.inpx.server;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.content.Intent;
import android.os.BatteryManager;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * Durable intent to run, shared safely by the UI, receiver, Node and service processes. No
 * credentials.
 */
final class ServerControl {
  private interface Change {
    void apply(JSONObject state) throws Exception;
  }

  private static synchronized JSONObject transaction(Context context, Change change)
      throws Exception {
    File root = context.getFilesDir();
    root.mkdirs();
    try (RandomAccessFile guard =
            new RandomAccessFile(new File(root, "server-control.lock"), "rw");
        FileLock lock = guard.getChannel().lock()) {
      AtomicFile file = new AtomicFile(new File(root, "server-control.json"));
      JSONObject state;
      try {
        state = new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8));
      } catch (java.io.FileNotFoundException e) {
        state = new JSONObject();
      }
      if (change != null) {
        change.apply(state);
        FileOutputStream output = null;
        try {
          output = file.startWrite();
          output.write(state.toString(2).getBytes(StandardCharsets.UTF_8));
          file.finishWrite(output);
        } catch (Exception e) {
          if (output != null) file.failWrite(output);
          throw e;
        }
      }
      return state;
    }
  }

  static JSONObject read(Context context) throws Exception {
    return transaction(context, null);
  }

  static void checkSources(Context context) throws Exception {
    transaction(context, state -> state.put("sourceCheckRequest", System.currentTimeMillis()));
  }

  static void start(Context context, boolean demo, int port) throws Exception {
    transaction(
        context,
        s -> {
          s.put("requested", true)
              .put("demo", demo)
              .put("port", port)
              .put("explicitStart", System.currentTimeMillis())
              .put("attempts", 0)
              .put("attemptWindow", 0)
              .put("blocked", false);
        });
    File data = new File(context.getFilesDir(), "data");
    data.mkdirs();
    new File(data, "stop").delete();
  }

  static void stop(Context context) throws Exception {
    transaction(context, s -> s.put("requested", false).put("blocked", false));
    File data = new File(context.getFilesDir(), "data");
    data.mkdirs();
    Io.write(new File(data, "stop"), "stop");
  }

  static void settings(Context context, boolean awake, boolean boot, boolean stopOnBattery)
      throws Exception {
    transaction(
        context,
        s -> s.put("keepAwake", awake).put("autoBoot", boot).put("stopOnBattery", stopOnBattery));
  }

  static boolean recordAttempt(Context context) throws Exception {
    JSONObject state =
        transaction(
            context,
            s -> {
              long now = System.currentTimeMillis(), window = s.optLong("attemptWindow");
              int attempts = now - window > 10 * 60 * 1000L ? 0 : s.optInt("attempts");
              if (attempts == 0) s.put("attemptWindow", now);
              s.put("attempts", attempts + 1);
              if (attempts >= 3) s.put("blocked", true);
            });
    return !state.optBoolean("blocked");
  }

  static boolean charging(Context context) {
    BatteryManager b = context.getSystemService(BatteryManager.class);
    return b != null && b.isCharging();
  }

  static boolean userStopped(Context context) throws Exception {
    if (android.os.Build.VERSION.SDK_INT < 30) return false;
    JSONObject state = read(context);
    ActivityManager manager = context.getSystemService(ActivityManager.class);
    if (manager != null)
      for (ApplicationExitInfo exit :
          manager.getHistoricalProcessExitReasons(context.getPackageName(), 0, 16)) {
        if (exit.getProcessName().equals(context.getPackageName() + ":server")
            && exit.getTimestamp() > state.optLong("explicitStart")
            && exit.getReason() == ApplicationExitInfo.REASON_USER_REQUESTED) {
          transaction(context, s -> s.put("requested", false));
          return true;
        }
      }
    return false;
  }

  static void requestService(Context context) {
    context.startForegroundService(new Intent(context, ServerService.class));
  }
}
