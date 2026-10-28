package ru.inpx.server;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONArray;
import org.json.JSONObject;

public final class ServerService extends Service {
  static final String STOP = "ru.inpx.server.STOP";
  private boolean launched;
  private PowerManager.WakeLock wakeLock;
  private volatile StorageBridge storage;
  private JSONArray sources;
  private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(2);
  private final AtomicBoolean refreshSources = new AtomicBoolean(true);
  private final AtomicBoolean checkingSources = new AtomicBoolean();
  private long handledSourceRequest;
  private volatile long lastSourceCheck;
  private volatile boolean sourcesReady;
  private final java.util.Set<String> activeSources = new java.util.HashSet<>();
  private boolean mediaReceiverRegistered;
  private final BroadcastReceiver mediaReceiver =
      new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
          requestSourceRefresh();
        }
      };
  private ConnectivityManager.NetworkCallback network;
  private boolean receiverRegistered;
  private final BroadcastReceiver powerReceiver =
      new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
          try {
            if (ServerControl.read(context).optBoolean("stopOnBattery")) {
              ServerControl.stop(context);
              state("Сервер остановлен: отключено питание");
            }
          } catch (Exception e) {
            Log.w("INPX", "Cannot apply power policy", e);
          }
        }
      };

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  private File data() {
    return new File(getFilesDir(), "data");
  }

  private void state(String message) {
    try {
      Io.write(new File(getFilesDir(), "status.txt"), message);
    } catch (Exception e) {
      Log.e("INPX", "Status write failed", e);
    }
  }

  private Notification notification(String text) {
    PendingIntent open =
        PendingIntent.getActivity(
            this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
    PendingIntent stop =
        PendingIntent.getService(
            this,
            1,
            new Intent(this, ServerService.class).setAction(STOP),
            PendingIntent.FLAG_IMMUTABLE);
    return new Notification.Builder(this, "server")
        .setContentTitle("INPX Server")
        .setContentText(text)
        .setSmallIcon(R.drawable.ic_library_status)
        .setContentIntent(open)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .addAction(new Notification.Action.Builder(null, "Остановить", stop).build())
        .build();
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    try {
      if (intent != null && STOP.equals(intent.getAction())) {
        ServerControl.stop(this);
        state("Остановка сервера…");
        if (!launched) stopSelf();
        return START_NOT_STICKY;
      }
      JSONObject request = ServerControl.read(this);
      if (!request.optBoolean("requested")
          || request.optBoolean("blocked")
          || ServerControl.userStopped(this)) {
        stopSelf();
        return START_NOT_STICKY;
      }
      if (request.optBoolean("stopOnBattery") && !ServerControl.charging(this)) {
        ServerControl.stop(this);
        state("Ошибка: для запуска подключите питание");
        stopSelf();
        return START_NOT_STICKY;
      }
      getSystemService(NotificationManager.class)
          .createNotificationChannel(
              new NotificationChannel(
                  "server", "Сервер библиотеки", NotificationManager.IMPORTANCE_LOW));
      if (Build.VERSION.SDK_INT >= 34)
        startForeground(
            1,
            notification("Подготовка библиотеки…"),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
      else startForeground(1, notification("Подготовка библиотеки…"));
      if (launched) return START_STICKY;
      if (!ServerControl.recordAttempt(this)) {
        state("Ошибка: три сбоя запуска за 10 минут. Проверьте журнал и запустите сервер вручную.");
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
        return START_NOT_STICKY;
      }
      launched = true;
      wakeLock =
          getSystemService(PowerManager.class)
              .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "inpx:server");
      wakeLock.setReferenceCounted(false);
      if (request.optBoolean("keepAwake", true)) wakeLock.acquire();
      IntentFilter powerFilter = new IntentFilter(Intent.ACTION_POWER_DISCONNECTED);
      if (Build.VERSION.SDK_INT >= 33)
        registerReceiver(powerReceiver, powerFilter, Context.RECEIVER_NOT_EXPORTED);
      else registerReceiver(powerReceiver, powerFilter);
      receiverRegistered = true;
      scheduler.scheduleWithFixedDelay(this::applyPolicy, 1, 2, TimeUnit.SECONDS);
      new Thread(() -> run(request), "inpx-node").start();
      return START_STICKY;
    } catch (Exception e) {
      state("Ошибка запуска: " + e.getMessage());
      Log.e("INPX", "Service start failed", e);
      stopSelf();
      return START_NOT_STICKY;
    }
  }

  private void applyPolicy() {
    try {
      JSONObject request = ServerControl.read(this);
      if (!request.optBoolean("requested")) {
        data().mkdirs();
        Io.write(new File(data(), "stop"), "stop");
        return;
      }
      boolean awake = request.optBoolean("keepAwake", true);
      if (awake && !wakeLock.isHeld()) wakeLock.acquire();
      else if (!awake && wakeLock.isHeld()) wakeLock.release();
      long check = request.optLong("sourceCheckRequest");
      if (check != handledSourceRequest && sourcesReady) {
        handledSourceRequest = check;
        requestSourceRefresh();
      }
    } catch (Exception e) {
      Log.w("INPX", "Power policy failed", e);
    }
  }

  private void requestSourceRefresh() {
    refreshSources.set(true);
    if (sourcesReady && !scheduler.isShutdown())
      try {
        scheduler.execute(this::refreshSourceIndexes);
      } catch (java.util.concurrent.RejectedExecutionException ignored) {
      }
  }

  private void refreshSourceIndexes() {
    if (!sourcesReady || !checkingSources.compareAndSet(false, true)) return;
    try {
      refreshSources.set(false);
      JSONArray libraries = IndexCache.refresh(this, storage, sources);
      for (int i = 0; i < libraries.length(); i++) {
        String id = libraries.getJSONObject(i).getString("id");
        SourceHealth.restartRequired(this, id, !activeSources.contains(id));
      }
    } catch (Exception e) {
      Log.w("INPX", "Source check failed: " + e.getClass().getSimpleName());
    } finally {
      lastSourceCheck = android.os.SystemClock.elapsedRealtime();
      checkingSources.set(false);
    }
  }

  private boolean sourceCheckDue() throws Exception {
    if (refreshSources.get()
        || android.os.SystemClock.elapsedRealtime() - lastSourceCheck > 15 * 60 * 1000L)
      return true;
    JSONArray status = SourceHealth.read(this);
    for (int i = 0; i < sources.length(); i++)
      if (!SourceHealth.find(status, sources.getJSONObject(i).getString("id")).optBoolean("online"))
        return true;
    return false;
  }

  private void run(JSONObject request) {
    try {
      state("Подготовка файлов приложения…");
      File runtime = prepareRuntime();
      data().mkdirs();
      if (!ServerControl.read(this).optBoolean("requested")) {
        stopSelf();
        return;
      }
      sources =
          request.optBoolean("demo")
              ? new JSONArray()
                  .put(
                      new JSONObject()
                          .put("id", "demo")
                          .put("name", "Демо-библиотека")
                          .put("kind", "local")
                          .put("path", new File(runtime, "demo").getAbsolutePath()))
              : new JSONArray(Vault.read(this));
      if (sources.length() == 0)
        throw new Exception("Сначала добавьте папку библиотеки или SMB-источник");
      storage = new StorageBridge(this, sources);
      JSONArray libraries = IndexCache.refresh(this, storage, sources);
      for (int i = 0; i < libraries.length(); i++)
        activeSources.add(libraries.getJSONObject(i).getString("id"));
      for (int i = 0; i < sources.length(); i++)
        SourceHealth.restartRequired(this, sources.getJSONObject(i).getString("id"), false);
      lastSourceCheck = android.os.SystemClock.elapsedRealtime();
      refreshSources.set(false);
      if (!ServerControl.read(this).optBoolean("requested")) {
        stopSelf();
        return;
      }
      int port = request.optInt("port", 12380);
      File configFile = new File(data(), "config.json");
      JSONObject config =
          configFile.exists() ? new JSONObject(Io.read(configFile)) : new JSONObject();
      config
          .put("dataDir", data().getAbsolutePath())
          .put("librarySources", libraries)
          .put("server", new JSONObject().put("host", "0.0.0.0").put("port", port).put("root", ""))
          .put("lowMemoryMode", true)
          .put("dbCacheSize", 32)
          .put("bookCacheSize", 268435456)
          .put("coverCacheSize", 67108864)
          .put("queryCacheMemSize", 8388608)
          .put("installMode", "android")
          .put("authExemptHealth", true)
          .put("conversionConcurrency", 1)
          .put("conversionQueueLimit", 4)
          .put("conversionTimeoutMs", 180000);
      Io.write(configFile, config.toString(2));
      sourcesReady = true;
      ConnectivityManager manager = getSystemService(ConnectivityManager.class);
      network =
          new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network n) {
              requestSourceRefresh();
            }

            @Override
            public void onLost(Network n) {
              requestSourceRefresh();
            }
          };
      manager.registerDefaultNetworkCallback(network);
      IntentFilter mediaFilter = new IntentFilter();
      for (String action :
          new String[] {
            Intent.ACTION_MEDIA_MOUNTED,
            Intent.ACTION_MEDIA_UNMOUNTED,
            Intent.ACTION_MEDIA_EJECT,
            Intent.ACTION_MEDIA_REMOVED,
            Intent.ACTION_MEDIA_BAD_REMOVAL
          }) mediaFilter.addAction(action);
      mediaFilter.addDataScheme("file");
      if (Build.VERSION.SDK_INT >= 33)
        registerReceiver(mediaReceiver, mediaFilter, Context.RECEIVER_EXPORTED);
      else registerReceiver(mediaReceiver, mediaFilter);
      mediaReceiverRegistered = true;
      scheduler.scheduleWithFixedDelay(
          () -> {
            try {
              if (sourceCheckDue()) refreshSourceIndexes();
            } catch (Exception e) {
              refreshSources.set(true);
              Log.w("INPX", "Source remains unavailable: " + e.getMessage());
            }
          },
          60,
          60,
          TimeUnit.SECONDS);
      state("Сервер запускается на порту " + port);
      getSystemService(NotificationManager.class)
          .notify(1, notification("Библиотека в домашней сети · порт " + port));
      NativeRuntime.start(
          new String[] {
            "node",
            "--expose-gc",
            android.os.Process.is64Bit() ? "--max-old-space-size=512" : "--max-old-space-size=256",
            new File(runtime, "bootstrap.js").getAbsolutePath()
          },
          storage,
          getApplicationInfo().nativeLibraryDir,
          data().getAbsolutePath());
    } catch (Throwable e) {
      state("Ошибка: " + e.getMessage());
      Log.e("INPX", "Server failed", e);
    } finally {
      if (storage != null) storage.close();
      try {
        if (!ServerControl.read(this).optBoolean("requested")) stopSelf();
      } catch (Exception ignored) {
        stopSelf();
      }
      android.os.Process.killProcess(android.os.Process.myPid());
    }
  }

  @Override
  public void onDestroy() {
    scheduler.shutdownNow();
    if (receiverRegistered) unregisterReceiver(powerReceiver);
    if (mediaReceiverRegistered) unregisterReceiver(mediaReceiver);
    if (network != null)
      getSystemService(ConnectivityManager.class).unregisterNetworkCallback(network);
    if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    super.onDestroy();
  }

  private File prepareRuntime() throws Exception {
    String hash;
    try (InputStream input = getAssets().open("runtime.sha256")) {
      hash = Io.read(input).trim();
    }
    if (!hash.matches("[a-f0-9]{64}")) throw new Exception("Invalid runtime manifest");
    File root = new File(getFilesDir(), "runtime/" + hash);
    if (new File(root, ".ready").exists()) return root;
    root.mkdirs();
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    try (InputStream input = getAssets().open("runtime.zip")) {
      byte[] buffer = new byte[65536];
      int n;
      while ((n = input.read(buffer)) != -1) digest.update(buffer, 0, n);
    }
    StringBuilder actual = new StringBuilder();
    for (byte b : digest.digest()) actual.append(String.format("%02x", b & 255));
    if (!actual.toString().equals(hash)) throw new Exception("Runtime checksum mismatch");
    try (ZipInputStream zip = new ZipInputStream(getAssets().open("runtime.zip"))) {
      ZipEntry entry;
      byte[] buffer = new byte[65536];
      while ((entry = zip.getNextEntry()) != null) {
        File file = new File(root, entry.getName()).getCanonicalFile();
        if (!file.getPath().startsWith(root.getCanonicalPath() + "/"))
          throw new Exception("Invalid asset path");
        if (entry.isDirectory()) {
          file.mkdirs();
          continue;
        }
        file.getParentFile().mkdirs();
        try (FileOutputStream out = new FileOutputStream(file)) {
          int n;
          while ((n = zip.read(buffer)) != -1) out.write(buffer, 0, n);
        }
      }
    }
    Io.write(new File(root, ".ready"), "ready");
    return root;
  }
}
