package ru.inpx.server;

import android.app.ActivityManager;
import android.content.Context;
import java.io.File;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import ru.inpx.server.presentation.ServerMemory;

/** Private diagnostics for the embedded process. No monitoring data is exposed over the LAN. */
final class ServerDiagnostics {
  static ServerMemory memory(Context context, JSONObject control, boolean running, boolean exhausted) {
    ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
    ActivityManager manager = context.getSystemService(ActivityManager.class);
    if (manager != null) manager.getMemoryInfo(info);
    int rss = 0, heap = 0;
    if (running) {
      try {
        File file = new File(context.getFilesDir(), "data/memory.json");
        JSONObject sample = new JSONObject(Io.read(file));
        long age = System.currentTimeMillis() - sample.optLong("at");
        if (age >= 0 && age < 12000 && file.lastModified() >= control.optLong("attemptStarted")) {
          rss = mib(sample.optLong("rss"));
          heap = mib(sample.optLong("heapUsed"));
        }
      } catch (Exception ignored) {
      }
    }
    int last = control.optInt("lastHeapMiB");
    return new ServerMemory(
        android.os.Process.is64Bit(), mib(info.totalMem), control.optInt("heapLimitMiB"),
        running ? last : 0, rss, heap, last, exhausted);
  }

  private static int mib(long bytes) {
    return (int) (bytes / 1048576);
  }

  static String journal(Context context) {
    try (RandomAccessFile log = new RandomAccessFile(journalFile(context), "r")) {
      long end = log.length();
      log.seek(Math.max(0, end - 14000));
      byte[] bytes = new byte[(int) (end - log.getFilePointer())];
      log.readFully(bytes);
      return new String(bytes, StandardCharsets.UTF_8);
    } catch (Exception ignored) {
      return "";
    }
  }

  private static File journalFile(Context context) {
    return new File(context.getFilesDir(), "data/node.log");
  }

  static boolean exhausted(Context context, JSONObject control, String journal) {
    if (control.optBoolean("heapExhausted")) return true;
    long started = control.optLong("attemptStarted");
    if (started == 0 || journalFile(context).lastModified() < started) return false;
    String latest = journal.substring(Math.max(0, journal.lastIndexOf("INFO: inpx-web v")));
    return (latest.contains("FATAL ERROR") && latest.contains("JavaScript heap out of memory"))
        || latest.contains("Поисковая база недоступна: поток завершился из-за нехватки памяти")
        || (latest.contains("GC in old space requested") && latest.contains("Native stack trace"));
  }

  private ServerDiagnostics() {}
}
