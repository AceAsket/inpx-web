package ru.inpx.server;

import android.content.Context;
import android.os.Process;
import android.util.AtomicFile;
import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import org.json.JSONObject;

/** Last completed unit of work, shared by Java, Node and the dashboard. */
final class ServerStartupProgress {
  private static File file(Context context) {
    return new File(context.getFilesDir(), "data/startup-progress.json");
  }

  static void write(Context context, String stage, String detail, int percent) {
    AtomicFile file = new AtomicFile(file(context));
    FileOutputStream output = null;
    try {
      JSONObject progress = new JSONObject()
          .put("pid", Process.myPid())
          .put("stage", stage)
          .put("detail", detail)
          .put("percent", percent)
          .put("changedAt", System.currentTimeMillis());
      output = file.startWrite();
      output.write(progress.toString().getBytes(StandardCharsets.UTF_8));
      file.finishWrite(output);
    } catch (Exception error) {
      if (output != null) file.failWrite(output);
      Log.w("INPX", "Cannot save startup progress", error);
    }
  }

  static JSONObject read(Context context, int pid) {
    if (pid > 0) {
      try {
        JSONObject progress = new JSONObject(Io.read(file(context)));
        if (progress.optInt("pid") == pid) return progress;
      } catch (Exception ignored) {
      }
    }
    return new JSONObject();
  }

  static int percent(JSONObject progress) {
    int value = progress.optInt("percent", -1);
    return value >= 0 && value <= 100 ? value : -1;
  }

  static String title(JSONObject progress, String fallback) {
    String stage = progress.optString("stage", fallback);
    int step = progress.optInt("step"), steps = progress.optInt("steps");
    if (step > 0 && step <= steps) stage += " · этап " + step + " из " + steps;
    int percent = percent(progress);
    return percent >= 0 ? stage + " · " + percent + "%" : stage;
  }

  static String summary(JSONObject progress, String fallback, long requestedAt, boolean answering) {
    String result = title(progress, fallback);
    if (progress.optBoolean("ready") && !answering)
      result = "Сервер перестал отвечать · последний этап: " + result;
    String detail = progress.optString("detail");
    if (!detail.isEmpty()) result += "\n" + detail;
    long records = progress.optLong("records");
    if (records > 0)
      result += String.format(new Locale("ru"), "\nОбработано %,d записей", records);
    long changedAt = progress.optLong("changedAt", requestedAt);
    if (changedAt > 0) {
      long seconds = Math.max(0L, (System.currentTimeMillis() - changedAt) / 1000);
      result += seconds >= 60
          ? "\nБез нового прогресса " + seconds / 60 + " мин " + seconds % 60 + " с"
          : "\nПоследнее обновление " + seconds + " с назад";
    }
    return result;
  }

  private ServerStartupProgress() {}
}
