package ru.inpx.server;

import android.app.ActivityManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.PowerManager;
import java.io.File;
import java.io.RandomAccessFile;
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
    boolean running = serviceRunning();
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
    boolean ready = running && ready(port);
    DashboardState.Phase phase;
    if (running && !control.optBoolean("requested")) {
      phase = DashboardState.Phase.STOPPING;
      message = "Завершаем работу сервера…";
    } else if (ready) phase = DashboardState.Phase.RUNNING;
    else if (control.optBoolean("blocked") || message.startsWith("Ошибка"))
      phase = DashboardState.Phase.ERROR;
    else if (running
        || (control.optBoolean("requested")
            && System.currentTimeMillis() - control.optLong("explicitStart") < 30000))
      phase = DashboardState.Phase.STARTING;
    else phase = DashboardState.Phase.STOPPED;
    boolean demo = control.optBoolean("demo");
    boolean changed =
        running
            && (port != preferred
                || (demo && !items.isEmpty())
                || (!demo
                    && !control.optString("sourceVersion").isEmpty()
                    && !SourceVersion.of(configured).equals(control.optString("sourceVersion"))));
    return new DashboardState(
        phase,
        items,
        addresses(),
        message,
        journal(),
        preferences.getString("ui_mode", "auto"),
        preferred,
        port,
        demo,
        changed,
        false,
        context.getFilesDir().getUsableSpace());
  }

  private boolean ready(int port) {
    HttpURLConnection connection = null;
    try {
      connection =
          (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/ready").openConnection();
      connection.setConnectTimeout(700);
      connection.setReadTimeout(700);
      return connection.getResponseCode() == 200;
    } catch (Exception ignored) {
      return false;
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private String journal() {
    try (RandomAccessFile log = new RandomAccessFile(file("data/node.log"), "r")) {
      log.seek(Math.max(0, log.length() - 14000));
      byte[] bytes = new byte[(int) (log.length() - log.getFilePointer())];
      log.readFully(bytes);
      return new String(bytes, StandardCharsets.UTF_8);
    } catch (Exception ignored) {
      return "";
    }
  }

  private boolean serviceRunning() {
    ActivityManager manager = context.getSystemService(ActivityManager.class);
    if (manager != null)
      for (ActivityManager.RunningServiceInfo service : manager.getRunningServices(16))
        if (ServerService.class.getName().equals(service.service.getClassName())) return true;
    return false;
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
    if (serviceRunning()) ServerControl.checkSources(context);
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
