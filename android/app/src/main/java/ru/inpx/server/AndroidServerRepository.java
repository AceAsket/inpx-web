package ru.inpx.server;

import android.app.ActivityManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.PowerManager;
import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import ru.inpx.server.presentation.DashboardState;
import ru.inpx.server.presentation.PowerSettings;
import ru.inpx.server.presentation.ServerRepository;
import ru.inpx.server.presentation.ServerMemory;
import ru.inpx.server.presentation.SourceDraft;
import ru.inpx.server.presentation.SourceInfo;

/** Android adapter. Keeps the existing vault, service protocol and file formats compatible. */
final class AndroidServerRepository implements ServerRepository {
  private final Context context;
  private final SharedPreferences preferences;

  AndroidServerRepository(Context context) {
    this.context = context.getApplicationContext();
    preferences = this.context.getSharedPreferences("MainActivity", Context.MODE_PRIVATE);
  }

  private File file(String path) {
    return new File(context.getFilesDir(), path);
  }

  @Override
  public DashboardState load() throws Exception {
    String configured = Vault.read(context);
    JSONArray sources = new JSONArray(configured), health = SourceHealth.read(context);
    List<SourceInfo> items = new ArrayList<>();
    for (int i = 0; i < sources.length(); i++) {
      JSONObject source = sources.getJSONObject(i);
      JSONObject status = SourceHealth.find(health, source.optString("id"));
      items.add(
          new SourceInfo(
              source.optString("id"),
              source.optString("name", "Библиотека"),
              source.optString("kind"),
              source.optString("host"),
              SourceHealth.label(status),
              status.optString("message"),
              status.optBoolean("online"),
              status.optBoolean("cachedIndex"),
              status.optBoolean("restartRequired"),
              status.optLong("indexBytes"),
              status.optLong("indexUpdatedAt"),
              status.optLong("checkedAt"),
              status.optLong("lastSuccess")));
    }
    int preferred = DashboardState.port(preferences.getString("port", "12380"));
    int port = preferred;
    int pid = serverPid();
    boolean running = pid > 0;
    JSONObject control = ServerControl.read(context);
    if (running) {
      try {
        port =
            new JSONObject(Io.read(file("data/config.json")))
                .getJSONObject("server")
                .optInt("port", preferred);
      } catch (Exception ignored) {
      }
    }
    String message = "Запустите сервер, чтобы читать книги с любого устройства в вашей сети.";
    try {
      message = Io.read(file("status.txt"));
      if (control.optBoolean("requested")
          && file("status.txt").lastModified() < control.optLong("explicitStart"))
        message = "Подготавливаем библиотеку. Дождитесь готовности каталога.";
    } catch (Exception ignored) {
    }
    boolean requested = control.optBoolean("requested");
    JSONObject progress = ServerStartupProgress.read(context, pid);
    if (progress.optLong("changedAt") < control.optLong("explicitStart")) progress = new JSONObject();
    JSONObject readiness = running && requested ? readiness(port) : new JSONObject();
    boolean ready = readiness.optBoolean("ready");
    String journal = ServerDiagnostics.journal(context);
    boolean exhausted = control.optBoolean("requested") && !ready
        && (control.optBoolean("heapExhausted")
            || (!running && ServerDiagnostics.exhausted(context, control, journal)));
    ServerMemory memory = ServerDiagnostics.memory(context, control, running, exhausted);
    DashboardState.Phase phase;
    if (running && !requested) {
      phase = DashboardState.Phase.STOPPING;
      message = "Завершаем работу сервера…";
    } else if (ready) phase = DashboardState.Phase.RUNNING;
    else if (exhausted) {
      phase = DashboardState.Phase.ERROR;
      message = memory.suggestedMiB() > 0
          ? "Не хватает памяти для запуска каталога. Увеличьте лимит и запустите сервер снова."
          : "Не хватает памяти. Лимит уже максимальный для этого устройства. Попробуйте меньший каталог.";
    } else if (control.optBoolean("blocked") || message.startsWith("Ошибка"))
      phase = DashboardState.Phase.ERROR;
    else if (running
        || (control.optBoolean("requested")
            && System.currentTimeMillis() - control.optLong("explicitStart") < 30000))
      phase = DashboardState.Phase.STARTING;
    else phase = DashboardState.Phase.STOPPED;
    int percent = -1;
    if (phase == DashboardState.Phase.STARTING) {
      message = ServerStartupProgress.summary(
          progress, message, control.optLong("explicitStart"), readiness.length() > 0);
      percent = ServerStartupProgress.percent(progress);
    }
    boolean demo = control.optBoolean("demo");
    boolean changed =
        running
            && (port != preferred
                || (memory.activeMiB > 0 && memory.activeMiB != memory.nextStartMiB())
                || (demo && !items.isEmpty())
                || (!demo
                    && !control.optString("sourceVersion").isEmpty()
                    && !SourceVersion.of(configured).equals(control.optString("sourceVersion"))));
    return new DashboardState(
        phase,
        items,
        addresses(),
        message,
        journal,
        preferences.getString("ui_mode", "auto"),
        preferred,
        port,
        demo,
        changed,
        false,
        context.getFilesDir().getUsableSpace(),
        memory,
        percent);
  }

  private JSONObject readiness(int port) {
    HttpURLConnection connection = null;
    try {
      connection =
          (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/ready").openConnection();
      connection.setConnectTimeout(700);
      connection.setReadTimeout(700);
      connection.setInstanceFollowRedirects(false);
      int code = connection.getResponseCode();
      if (code != 200 && code != 503) return new JSONObject();
      try (InputStream input = code == 200 ? connection.getInputStream() : connection.getErrorStream()) {
        if (input == null) return new JSONObject();
        byte[] buffer = new byte[16384];
        int size = 0, n;
        while (size < buffer.length && (n = input.read(buffer, size, buffer.length - size)) != -1)
          size += n;
        JSONObject result = new JSONObject(new String(buffer, 0, size, StandardCharsets.UTF_8));
        if (code != 200) result.put("ready", false);
        return result;
      }
    } catch (Exception ignored) {
      return new JSONObject();
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private int serverPid() {
    ActivityManager manager = context.getSystemService(ActivityManager.class);
    if (manager != null)
      for (ActivityManager.RunningServiceInfo service : manager.getRunningServices(16))
        if (ServerService.class.getName().equals(service.service.getClassName())) return service.pid;
    return 0;
  }

  private List<String> addresses() {
    LinkedHashSet<String> result = new LinkedHashSet<>();
    try {
      for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces()))
        if (network.isUp() && !network.isLoopback())
          for (java.net.InetAddress address : Collections.list(network.getInetAddresses()))
            if (address instanceof Inet4Address
                && !address.isLoopbackAddress()
                && address.isSiteLocalAddress()) result.add(address.getHostAddress());
    } catch (Exception ignored) {
    }
    return new ArrayList<>(result);
  }

  @Override
  public void start(boolean demo) throws Exception {
    if (!demo && new JSONArray(Vault.read(context)).length() == 0)
      throw new IllegalStateException("Сначала добавьте папку библиотеки или источник SMB.");
    if (ServerControl.read(context).optBoolean("stopOnBattery") && !ServerControl.charging(context))
      throw new IllegalStateException(
          "Для запуска подключите питание или измените настройку фоновой работы.");
    ServerControl.start(context, demo, DashboardState.port(preferences.getString("port", "12380")));
    try {
      ServerControl.requestService(context);
    } catch (Exception error) {
      ServerControl.stop(context);
      throw error;
    }
  }

  @Override
  public void stop() throws Exception {
    ServerControl.stop(context);
  }

  @Override
  public void checkSources() throws Exception {
    if (serverPid() > 0) ServerControl.checkSources(context);
    else {
      JSONArray sources = new JSONArray(Vault.read(context));
      try (StorageBridge bridge = new StorageBridge(context, sources)) {
        IndexCache.refresh(context, bridge, sources);
      }
    }
  }

  private SourceDraft draft(JSONObject source) {
    return new SourceDraft(
        source.optString("id"),
        source.optString("kind"),
        source.optString("name"),
        source.optString("uri"),
        source.optString("host"),
        source.optString("share"),
        source.optString("folder"),
        source.optString("user"),
        source.optString("password"),
        source.optString("domain"));
  }

  @Override
  public synchronized SourceDraft source(String id) throws Exception {
    JSONArray sources = new JSONArray(Vault.read(context));
    for (int i = 0; i < sources.length(); i++)
      if (id.equals(sources.getJSONObject(i).optString("id")))
        return draft(sources.getJSONObject(i));
    throw new IllegalArgumentException("Источник уже удалён. Обновите список библиотек.");
  }

  @Override
  public synchronized void saveSource(SourceDraft source) throws Exception {
    if (source.name.trim().isEmpty())
      throw new IllegalArgumentException("Укажите название библиотеки");
    if (!source.kind.equals("tree") && !source.kind.equals("smb"))
      throw new IllegalArgumentException("Неизвестный тип источника");
    if (source.kind.equals("smb")
        && (source.host.trim().isEmpty() || source.share.trim().isEmpty()))
      throw new IllegalArgumentException("Укажите сервер и общую папку SMB");
    if (source.kind.equals("tree") && source.uri.isEmpty())
      throw new IllegalArgumentException("Выберите папку библиотеки");
    JSONArray sources = new JSONArray(Vault.read(context));
    JSONObject value =
        new JSONObject()
            .put("id", source.id.isEmpty() ? UUID.randomUUID().toString() : source.id)
            .put("kind", source.kind)
            .put("name", source.name.trim());
    if (source.kind.equals("tree")) value.put("uri", source.uri);
    else
      value
          .put("host", source.host.trim())
          .put("share", source.share.trim())
          .put("folder", source.folder.trim())
          .put("user", source.user.trim())
          .put("password", source.password)
          .put("domain", source.domain.trim());
    int index = -1;
    for (int i = 0; i < sources.length(); i++)
      if (value.getString("id").equals(sources.getJSONObject(i).optString("id"))) {
        index = i;
        break;
      }
    if (index < 0) sources.put(value);
    else sources.put(index, value);
    Vault.write(context, sources.toString());
  }

  @Override
  public synchronized void removeSource(String id) throws Exception {
    JSONArray sources = new JSONArray(Vault.read(context));
    for (int i = 0; i < sources.length(); i++)
      if (id.equals(sources.getJSONObject(i).optString("id"))) {
        sources.remove(i);
        Vault.write(context, sources.toString());
        return;
      }
  }

  @Override
  public void savePort(int port) throws Exception {
    if (!preferences
        .edit()
        .putString("port", String.valueOf(DashboardState.port(String.valueOf(port))))
        .commit()) throw new IllegalStateException("Не удалось сохранить порт");
  }

  @Override
  public void saveMode(String mode) throws Exception {
    if (!mode.equals("auto") && !mode.equals("touch") && !mode.equals("tv"))
      throw new IllegalArgumentException("Неизвестный режим интерфейса");
    if (!preferences.edit().putString("ui_mode", mode).commit())
      throw new IllegalStateException("Не удалось сохранить режим");
  }

  @Override
  public void saveMemoryLimit(int mib) throws Exception {
    ServerMemory memory = ServerDiagnostics.memory(context, ServerControl.read(context), false, false);
    if (mib != 0 && java.util.Arrays.stream(memory.choices()).noneMatch(value -> value == mib))
      throw new IllegalArgumentException("Этот лимит недоступен на устройстве.");
    ServerControl.memoryLimit(context, mib);
  }

  @Override
  public PowerSettings power() throws Exception {
    JSONObject state = ServerControl.read(context);
    PowerManager manager = context.getSystemService(PowerManager.class);
    return new PowerSettings(
        state.optBoolean("keepAwake", true),
        state.optBoolean("autoBoot"),
        state.optBoolean("stopOnBattery"),
        ServerControl.charging(context),
        manager.isIgnoringBatteryOptimizations(context.getPackageName()),
        Build.VERSION.SDK_INT >= 33 && manager.isLowPowerStandbyEnabled(),
        Build.VERSION.SDK_INT >= 34 && manager.isExemptFromLowPowerStandby());
  }

  @Override
  public void savePower(boolean awake, boolean boot, boolean stopOnBattery) throws Exception {
    ServerControl.settings(context, awake, boot, stopOnBattery);
  }
}
