package ru.inpx.server;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.UiModeManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.graphics.drawable.StateListDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.io.File;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

public final class MainActivity extends Activity implements DashboardView.Actions {
  private static final String COMMUNITY_URL = "https://t.me/inpxweb";
  private JSONArray sources = new JSONArray();
  private JSONArray sourceHealth = new JSONArray();
  private TextView diagnosticText;
  private Button diagnosticCheck;
  private boolean sourceChecking;
  private DashboardView dashboard;
  private String port = "12380",
      journal = "",
      detail = "Подключите книги и читайте с любого устройства дома.",
      serverUrl = "";
  private boolean tv, online, starting, visible, checking, destroyed;
  private int activePort = 12380;
  private String[] lan = new String[0];
  private final Handler handler = new Handler();
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private final ExecutorService sourceExecutor = Executors.newSingleThreadExecutor();
  private final Runnable poll = this::refresh;

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    port = getPreferences(0).getString("port", "12380");
    try {
      sources = new JSONArray(Vault.read(this));
    } catch (Exception e) {
      handler.post(() -> error(e));
    }
    render("primary");
    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
            != PackageManager.PERMISSION_GRANTED)
      requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS"}, 11);
  }

  private boolean automaticTv() {
    UiModeManager mode = getSystemService(UiModeManager.class);
    return (mode != null && mode.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION)
        || getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK)
        || getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEVISION);
  }

  private void render(String focus) {
    String choice = getPreferences(0).getString("ui_mode", "auto");
    tv = choice.equals("tv") || (choice.equals("auto") && automaticTv());
    dashboard =
        new DashboardView(
            this, tv, choice.equals("auto") ? "Авто" : tv ? "ТВ" : "Сенсор", sources, this);
    setContentView(dashboard.root);
    // Target SDK 36 draws behind system bars. Keep all controls inside safe insets.
    int l = dashboard.root.getPaddingLeft(),
        t = dashboard.root.getPaddingTop(),
        r = dashboard.root.getPaddingRight(),
        b = dashboard.root.getPaddingBottom();
    dashboard.root.setOnApplyWindowInsetsListener(
        (view, insets) -> {
          if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets bars =
                insets.getInsets(
                    android.view.WindowInsets.Type.systemBars()
                        | android.view.WindowInsets.Type.displayCutout());
            view.setPadding(l + bars.left, t + bars.top, r + bars.right, b + bars.bottom);
          } else {
            view.setPadding(
                l + insets.getSystemWindowInsetLeft(),
                t + insets.getSystemWindowInsetTop(),
                r + insets.getSystemWindowInsetRight(),
                b + insets.getSystemWindowInsetBottom());
          }
          return insets;
        });
    dashboard.root.requestApplyInsets();
    updateDashboard();
    dashboard.root.post(
        () -> {
          if (!destroyed) dashboard.focus(focus);
        });
  }

  private void updateDashboard() {
    dashboard.updateSources(sourceHealth, online || starting);
    if (diagnosticText != null) diagnosticText.setText(diagnosticReport());
    String metric =
        (sources.length() == 0
                ? "Демо-библиотека"
                : sources.length() + (sources.length() == 1 ? " источник" : " источника"))
            + " · Каталог и OPDS в домашней сети";
    dashboard.update(
        online,
        starting,
        detail,
        lan.length > 0 ? serverUrl : "Подключите Wi-Fi или Ethernet",
        metric,
        lan.length > 0);
  }

  private int readPort() {
    try {
      int p = Integer.parseInt(port);
      if (p >= 1024 && p <= 65535) return p;
    } catch (NumberFormatException ignored) {
    }
    throw new IllegalArgumentException("Порт должен быть от 1024 до 65535");
  }

  private void save(String focus) throws Exception {
    Vault.write(this, sources.toString());
    render(focus);
  }

  @Override
  public void mode() {
    String[] values = {"auto", "touch", "tv"};
    String selected = getPreferences(0).getString("ui_mode", "auto");
    int current = selected.equals("tv") ? 2 : selected.equals("touch") ? 1 : 0;
    AlertDialog dialog =
        new AlertDialog.Builder(this)
            .setTitle("Как управлять приложением")
            .setSingleChoiceItems(
                new String[] {
                  "Автоматически · по типу устройства",
                  "Касания · телефон и планшет",
                  "Пульт · телевизор и приставка"
                },
                current,
                (d, which) -> {
                  getPreferences(0).edit().putString("ui_mode", values[which]).apply();
                  d.dismiss();
                  render("mode");
                })
            .setNegativeButton("Назад", null)
            .create();
    show(dialog);
  }

  @Override
  public void toggle() {
    if (starting) {
      toast("Сервер запускается. Состояние можно посмотреть в журнале.");
      return;
    }
    if (!online) {
      launch(false);
      return;
    }
    AlertDialog d =
        new AlertDialog.Builder(this)
            .setTitle("Остановить сервер?")
            .setMessage(
                "Каталог станет недоступен другим устройствам. Библиотека и настройки сохранятся.")
            .setPositiveButton("Остановить", (dialog, which) -> stop())
            .setNegativeButton("Продолжить работу", null)
            .create();
    show(d);
    if (tv) d.getButton(AlertDialog.BUTTON_NEGATIVE).requestFocus();
  }

  private void stop() {
    try {
      ServerControl.stop(this);
      detail = "Останавливаем сервер…";
      updateDashboard();
    } catch (Exception e) {
      error(e);
    }
  }

  @Override
  public void demo() {
    if (online || starting) {
      toast("Сначала остановите текущий сервер.");
      return;
    }
    launch(true);
  }

  private void launch(boolean demo) {
    try {
      int p = readPort();
      if (!demo && sources.length() == 0) {
        error(
            new Exception(
                "Добавьте папку с INPX и архивами или сетевую папку SMB. Для знакомства можно"
                    + " запустить демо-библиотеку."));
        return;
      }
      if (ServerControl.read(this).optBoolean("stopOnBattery") && !ServerControl.charging(this))
        throw new Exception(
            "Для запуска подключите питание или измените настройку фоновой работы.");
      ServerControl.start(this, demo, p);
      ServerControl.requestService(this);
      starting = true;
      detail = "Подготовка файлов и каталога. Это может занять некоторое время.";
      updateDashboard();
    } catch (Exception e) {
      starting = false;
      error(e);
    }
  }

  @Override
  public void folder() {
    try {
      startActivityForResult(
          new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
              .addFlags(
                  Intent.FLAG_GRANT_READ_URI_PERMISSION
                      | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION),
          10);
    } catch (ActivityNotFoundException e) {
      error(
          new Exception(
              "На этой приставке нет системного выбора папок. Для локальных накопителей нужен"
                  + " файловый провайдер Android; сейчас можно подключить библиотеку по SMB."));
    }
  }

  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request != 10 || result != RESULT_OK || data == null) return;
    try {
      Uri uri = data.getData();
      if (uri == null) throw new Exception("Android не вернул папку");
      if ((data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0)
        throw new SecurityException("Провайдер не разрешил чтение папки");
      getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
      EditText name = field("Название библиотеки", false);
      name.setText("Библиотека " + (sources.length() + 1));
      LinearLayout form = form();
      fieldRow(form, "Как назвать источник", name);
      AlertDialog dialog =
          new AlertDialog.Builder(this)
              .setTitle("Папка подключена")
              .setView(form)
              .setPositiveButton("Добавить", null)
              .setNegativeButton("Отмена", null)
              .create();
      show(dialog);
      wireFields(new EditText[] {name}, dialog);
      dialog
          .getButton(AlertDialog.BUTTON_POSITIVE)
          .setOnClickListener(
              v -> {
                try {
                  String title = name.getText().toString().trim();
                  if (title.isEmpty()) {
                    name.setError("Укажите название");
                    name.requestFocus();
                    return;
                  }
                  sources.put(
                      new JSONObject()
                          .put("id", UUID.randomUUID().toString())
                          .put("kind", "tree")
                          .put("name", title)
                          .put("uri", uri.toString()));
                  dialog.dismiss();
                  save("folder");
                } catch (Exception e) {
                  error(e);
                }
              });
    } catch (Exception e) {
      error(e);
    }
  }

  @Override
  public void smb() {
    smbDialog(-1);
  }

  private void smbDialog(int index) {
    LinearLayout form = form();
    String[] keys = {"name", "host", "share", "folder", "user", "password", "domain"};
    String[] labels = {
      "Название",
      "Сервер",
      "Общая папка",
      "Подпапка · необязательно",
      "Логин",
      "Пароль",
      "Домен · необязательно"
    };
    String[] hints = {
      "Домашняя библиотека",
      "192.168.1.10 или nas.local",
      "books",
      "Папка внутри общей папки",
      "Имя пользователя",
      "Пароль SMB",
      "WORKGROUP"
    };
    EditText[] fields = new EditText[keys.length];
    JSONObject previous = index >= 0 ? sources.optJSONObject(index) : null;
    for (int i = 0; i < keys.length; i++) {
      fields[i] = field(hints[i], keys[i].equals("password"));
      if (previous != null) fields[i].setText(previous.optString(keys[i]));
      fieldRow(form, labels[i], fields[i]);
    }
    form.addView(
        text(
            "Учётные данные сохраняются с шифрованием. Подключение — SMB2 / SMB3.",
            12,
            DashboardView.MUTED));
    ScrollView scroll = new ScrollView(this);
    scroll.addView(form);
    AlertDialog dialog =
        new AlertDialog.Builder(this)
            .setTitle(index >= 0 ? "Настройки SMB" : "Библиотека на NAS")
            .setView(scroll)
            .setPositiveButton(index >= 0 ? "Сохранить" : "Подключить", null)
            .setNegativeButton("Отмена", null)
            .create();
    show(dialog);
    wireFields(fields, dialog);
    dialog
        .getButton(AlertDialog.BUTTON_POSITIVE)
        .setOnClickListener(
            v -> {
              try {
                JSONObject source =
                    previous == null
                        ? new JSONObject()
                            .put("id", UUID.randomUUID().toString())
                            .put("kind", "smb")
                        : new JSONObject(previous.toString());
                for (int i = 0; i < keys.length; i++)
                  source.put(
                      keys[i],
                      keys[i].equals("password")
                          ? fields[i].getText().toString()
                          : fields[i].getText().toString().trim());
                if (source.getString("host").isEmpty()) {
                  fields[1].setError("Укажите сервер");
                  fields[1].requestFocus();
                  return;
                }
                if (source.getString("share").isEmpty()) {
                  fields[2].setError("Укажите общую папку");
                  fields[2].requestFocus();
                  return;
                }
                if (source.getString("name").isEmpty())
                  source.put("name", source.getString("host") + "/" + source.getString("share"));
                if (index >= 0) sources.put(index, source);
                else sources.put(source);
                dialog.dismiss();
                save("source:" + source.getString("id"));
              } catch (Exception e) {
                error(e);
              }
            });
  }

  @Override
  public void source(int index) {
    JSONObject source = sources.optJSONObject(index);
    if (source == null) return;
    AlertDialog d =
        new AlertDialog.Builder(this)
            .setTitle(source.optString("name"))
            .setItems(
                new String[] {
                  source.optString("kind").equals("smb")
                      ? "Настроить подключение"
                      : "Переименовать",
                  "Удалить источник"
                },
                (dialog, which) -> {
                  if (which == 0) {
                    if (source.optString("kind").equals("smb")) smbDialog(index);
                    else rename(index);
                  } else {
                    AlertDialog confirm =
                        new AlertDialog.Builder(this)
                            .setTitle("Удалить источник?")
                            .setMessage(
                                "«"
                                    + source.optString("name")
                                    + "» будет удалён из настроек. Книги останутся на месте.")
                            .setPositiveButton(
                                "Удалить",
                                (a, b) -> {
                                  sources.remove(index);
                                  try {
                                    save("folder");
                                  } catch (Exception e) {
                                    error(e);
                                  }
                                })
                            .setNegativeButton("Отмена", null)
                            .create();
                    show(confirm);
                    if (tv) confirm.getButton(-2).requestFocus();
                  }
                })
            .setNegativeButton("Назад", null)
            .create();
    show(d);
  }

  private void rename(int index) {
    JSONObject source = sources.optJSONObject(index);
    EditText name = field("Название библиотеки", false);
    name.setText(source.optString("name"));
    LinearLayout form = form();
    fieldRow(form, "Название", name);
    AlertDialog d =
        new AlertDialog.Builder(this)
            .setTitle("Название источника")
            .setView(form)
            .setPositiveButton("Сохранить", null)
            .setNegativeButton("Отмена", null)
            .create();
    show(d);
    wireFields(new EditText[] {name}, d);
    d.getButton(-1)
        .setOnClickListener(
            v -> {
              try {
                String value = name.getText().toString().trim();
                if (value.isEmpty()) {
                  name.setError("Укажите название");
                  return;
                }
                source.put("name", value);
                d.dismiss();
                save("source:" + source.optString("id"));
              } catch (Exception e) {
                error(e);
              }
            });
  }

  @Override
  public void community() {
    LinearLayout content = form();
    content.addView(
        text(
            "Обсуждение INPX Web в Telegram. Откройте ссылку на устройстве или отсканируйте QR-код"
                + " телефоном.",
            14,
            DashboardView.MUTED));
    QrView qr = new QrView(this);
    qr.setUrl(COMMUNITY_URL);
    LinearLayout.LayoutParams size = new LinearLayout.LayoutParams(dp(180), dp(180));
    size.gravity = Gravity.CENTER_HORIZONTAL;
    size.topMargin = dp(12);
    size.bottomMargin = dp(12);
    content.addView(qr, size);
    TextView link = text(COMMUNITY_URL, tv ? 18 : 16, DashboardView.MINT);
    link.setGravity(Gravity.CENTER);
    content.addView(link);
    ScrollView scroll = new ScrollView(this);
    scroll.addView(content);
    AlertDialog d =
        new AlertDialog.Builder(this)
            .setTitle("Сообщество INPX Web")
            .setView(scroll)
            .setPositiveButton(
                "Открыть",
                (dialog, which) -> {
                  try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(COMMUNITY_URL)));
                  } catch (ActivityNotFoundException e) {
                    getSystemService(ClipboardManager.class)
                        .setPrimaryClip(ClipData.newPlainText("Telegram INPX Web", COMMUNITY_URL));
                    toast("Нет приложения для открытия ссылки. Ссылка скопирована.");
                  }
                })
            .setNeutralButton(
                "Скопировать",
                (dialog, which) -> {
                  getSystemService(ClipboardManager.class)
                      .setPrimaryClip(ClipData.newPlainText("Telegram INPX Web", COMMUNITY_URL));
                  toast("Ссылка скопирована");
                })
            .setNegativeButton("Закрыть", null)
            .create();
    show(d);
    if (tv) {
      Button open = d.getButton(-1);
      open.setFocusableInTouchMode(true);
      open.post(open::requestFocus);
    }
  }

  @Override
  public void diagnostics() {
    LinearLayout content = form();
    TextView description =
        text(
            "Проверьте подключение накопителей и доступ к NAS. Сохранённый каталог остаётся"
                + " доступен при временной потере источника. Для загрузки книг вне кэша нужен сам"
                + " источник.",
            13,
            DashboardView.MUTED);
    content.addView(description);
    diagnosticText = text(diagnosticReport(), tv ? 16 : 15, DashboardView.TEXT);
    diagnosticText.setTag("diagnostic-report");
    content.addView(diagnosticText);
    ScrollView scroll = new ScrollView(this);
    scroll.addView(content);
    scroll.setFocusable(tv);
    AlertDialog d =
        new AlertDialog.Builder(this)
            .setTitle("Состояние источников")
            .setView(scroll)
            .setPositiveButton("Проверить сейчас", null)
            .setNegativeButton("Закрыть", null)
            .setNeutralButton(
                "Скопировать отчёт",
                (dialog, which) -> {
                  getSystemService(ClipboardManager.class)
                      .setPrimaryClip(
                          ClipData.newPlainText("INPX: состояние источников", diagnosticReport()));
                  toast("Отчёт скопирован");
                })
            .create();
    show(d);
    diagnosticCheck = d.getButton(-1);
    diagnosticCheck.setFocusableInTouchMode(tv);
    diagnosticCheck.setEnabled(!sourceChecking);
    diagnosticCheck.setOnClickListener(v -> checkSources());
    d.setOnDismissListener(
        dialog -> {
          diagnosticText = null;
          diagnosticCheck = null;
        });
    if (tv) diagnosticCheck.post(diagnosticCheck::requestFocus);
  }

  private String time(long value) {
    return value > 0
        ? java.text.DateFormat.getDateTimeInstance(
                java.text.DateFormat.SHORT, java.text.DateFormat.SHORT)
            .format(new java.util.Date(value))
        : "ещё не было";
  }

  private String diagnosticReport() {
    StringBuilder text =
        new StringBuilder("Сервер: ")
            .append(online ? "работает" : starting ? "запускается" : "остановлен")
            .append("\nСвободно для данных приложения: ")
            .append(
                android.text.format.Formatter.formatFileSize(this, getFilesDir().getUsableSpace()));
    if (sourceChecking) text.append("\nПроверка источников…");
    if (sources.length() == 0) text.append("\n\nИсточники пока не добавлены.");
    for (int i = 0; i < sources.length(); i++) {
      JSONObject source = sources.optJSONObject(i);
      if (source == null) continue;
      JSONObject status = SourceHealth.find(sourceHealth, source.optString("id"));
      text.append("\n\n")
          .append(source.optString("name", "Библиотека"))
          .append(" · ")
          .append(source.optString("kind").equals("smb") ? "SMB" : "SD / USB")
          .append("\n")
          .append(SourceHealth.label(status));
      if (!status.optString("message").isEmpty())
        text.append("\n").append(status.optString("message"));
      if (status.optBoolean("cachedIndex"))
        text.append("\nINPX сохранён: ")
            .append(
                android.text.format.Formatter.formatFileSize(this, status.optLong("indexBytes")))
            .append(" · ")
            .append(time(status.optLong("indexUpdatedAt")));
      text.append("\nПроверка: ")
          .append(time(status.optLong("checkedAt")))
          .append("\nУспешный доступ: ")
          .append(time(status.optLong("lastSuccess")));
      if ((online || starting)
          && status.optBoolean("online")
          && status.optBoolean("restartRequired"))
        text.append(
            "\n"
                + "Источник впервые стал доступен. Перезапустите сервер, чтобы включить его в"
                + " каталог.");
    }
    return text.toString();
  }

  private void checkSources() {
    if (sourceChecking) return;
    sourceChecking = true;
    final boolean restoreFocus = tv && diagnosticCheck != null && diagnosticCheck.hasFocus();
    if (diagnosticCheck != null) diagnosticCheck.setEnabled(false);
    updateDashboard();
    final boolean running = serviceRunning();
    final android.content.Context context = getApplicationContext();
    sourceExecutor.execute(
        () -> {
          Exception failure = null;
          try {
            if (running) ServerControl.checkSources(context);
            else {
              JSONArray configured = new JSONArray(Vault.read(context));
              try (StorageBridge bridge = new StorageBridge(context, configured)) {
                IndexCache.refresh(context, bridge, configured);
              }
            }
          } catch (Exception e) {
            failure = e;
          }
          final Exception result = failure;
          handler.post(
              () -> {
                sourceChecking = false;
                if (destroyed) return;
                if (diagnosticCheck != null) diagnosticCheck.setEnabled(true);
                if (restoreFocus && diagnosticCheck != null) diagnosticCheck.requestFocus();
                if (result != null)
                  toast("Проверка завершена. Причина недоступности показана у источника.");
                else if (running) toast("Проверка запрошена. Состояние обновится автоматически.");
                updateDashboard();
              });
        });
  }

  @Override
  public void power() {
    try {
      JSONObject state = ServerControl.read(this);
      PowerManager manager = getSystemService(PowerManager.class);
      LinearLayout content = form();
      CheckBox awake =
          powerOption(
              content,
              "Поддерживать работу с выключенным экраном",
              state.optBoolean("keepAwake", true));
      CheckBox boot =
          powerOption(
              content, "Запускать после включения устройства", state.optBoolean("autoBoot"));
      CheckBox battery =
          powerOption(
              content, "Останавливать при отключении питания", state.optBoolean("stopOnBattery"));
      content.addView(
          text(
              "Автозапуск восстанавливает только ранее запущенный сервер. После ручной остановки он"
                  + " остаётся выключенным. После отключения питания запуск выполняется вручную.",
              13,
              DashboardView.MUTED));
      boolean exempt = manager.isIgnoringBatteryOptimizations(getPackageName());
      String diagnostic =
          (ServerControl.charging(this) ? "Питание подключено" : "Работа от аккумулятора")
              + " · Оптимизация батареи: "
              + (exempt ? "без ограничений" : "включена");
      if (Build.VERSION.SDK_INT >= 33 && manager.isLowPowerStandbyEnabled()) {
        diagnostic += "\nОжидание низкого потребления включено";
        if (Build.VERSION.SDK_INT >= 34)
          diagnostic +=
              manager.isExemptFromLowPowerStandby()
                  ? " · приложение исключено"
                  : " · сеть может отключаться";
      }
      content.addView(text(diagnostic, 13, DashboardView.MINT));
      content.addView(
          text(
              "Для постоянного доступа оставьте приставку на питании и разрешите приложению работу"
                  + " без ограничений в настройках Android. Режим сна устройства может отключать"
                  + " сеть даже у фоновой службы.",
              13,
              DashboardView.MUTED));
      ScrollView scroll = new ScrollView(this);
      scroll.addView(content);
      AlertDialog d =
          new AlertDialog.Builder(this)
              .setTitle("Фоновая работа")
              .setView(scroll)
              .setPositiveButton(
                  "Сохранить",
                  (dialog, which) -> {
                    try {
                      ServerControl.settings(
                          this, awake.isChecked(), boot.isChecked(), battery.isChecked());
                      toast("Настройки фоновой работы сохранены");
                    } catch (Exception e) {
                      error(e);
                    }
                  })
              .setNegativeButton("Отмена", null)
              .setNeutralButton("Настройки Android", null)
              .create();
      show(d);
      d.getButton(-3)
          .setOnClickListener(
              v -> {
                try {
                  startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                } catch (ActivityNotFoundException e) {
                  startActivity(
                      new Intent(
                          Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                          Uri.parse("package:" + getPackageName())));
                }
              });
      awake.setNextFocusDownId(boot.getId());
      boot.setNextFocusUpId(awake.getId());
      boot.setNextFocusDownId(battery.getId());
      battery.setNextFocusUpId(boot.getId());
      d.getButton(-1).setId(View.generateViewId());
      battery.setNextFocusDownId(d.getButton(-1).getId());
      d.getButton(-1).setNextFocusUpId(battery.getId());
      if (tv) awake.post(awake::requestFocus);
    } catch (Exception e) {
      error(e);
    }
  }

  private CheckBox powerOption(LinearLayout form, String label, boolean checked) {
    CheckBox box = new CheckBox(this);
    box.setId(View.generateViewId());
    box.setFocusableInTouchMode(true);
    box.setText(label);
    box.setTextColor(DashboardView.TEXT);
    box.setTextSize(tv ? 17 : 16);
    box.setMinHeight(dp(56));
    box.setChecked(checked);
    box.setButtonTintList(ColorStateList.valueOf(DashboardView.MINT));
    StateListDrawable background = new StateListDrawable();
    background.addState(
        new int[] {android.R.attr.state_focused},
        dashboard.shape(DashboardView.SURFACE, DashboardView.MINT, 2, 8));
    background.addState(
        new int[] {}, dashboard.shape(DashboardView.SURFACE, DashboardView.SURFACE, 0, 8));
    box.setBackground(background);
    form.addView(box);
    return box;
  }

  @Override
  public void settings() {
    LinearLayout form = form();
    EditText input = field("12380", false);
    input.setInputType(InputType.TYPE_CLASS_NUMBER);
    input.setText(port);
    fieldRow(form, "Порт сервера", input);
    form.addView(
        text(
            "От 1024 до 65535. Новое значение применяется при следующем запуске сервера.",
            13,
            DashboardView.MUTED));
    AlertDialog d =
        new AlertDialog.Builder(this)
            .setTitle("Настройки сервера")
            .setView(form)
            .setPositiveButton("Сохранить", null)
            .setNegativeButton("Отмена", null)
            .create();
    show(d);
    wireFields(new EditText[] {input}, d);
    d.getButton(-1)
        .setOnClickListener(
            v -> {
              String old = port;
              try {
                port = input.getText().toString().trim();
                readPort();
                getPreferences(0).edit().putString("port", port).apply();
                d.dismiss();
                toast(online ? "Порт изменится после перезапуска сервера" : "Порт сохранён");
              } catch (Exception e) {
                port = old;
                input.setError(e.getMessage());
                input.requestFocus();
              }
            });
  }

  @Override
  public void connect() {
    LinearLayout content = form();
    if (online && lan.length > 0) {
      QrView code = new QrView(this);
      code.setUrl(serverUrl);
      LinearLayout.LayoutParams size = new LinearLayout.LayoutParams(dp(190), dp(190));
      size.gravity = Gravity.CENTER_HORIZONTAL;
      size.bottomMargin = dp(18);
      content.addView(code, size);
      TextView url = text(serverUrl, tv ? 22 : 20, DashboardView.MINT);
      url.setGravity(Gravity.CENTER);
      url.setTypeface(Typeface.MONOSPACE);
      content.addView(url);
      content.addView(
          text(
              "Откройте камеру телефона и сканируйте QR-код. Устройства должны быть в одной"
                  + " домашней сети.",
              14,
              DashboardView.MUTED));
      for (int i = 1; i < lan.length; i++)
        content.addView(text("http://" + lan[i] + ":" + activePort, 13, DashboardView.MUTED));
    } else
      content.addView(
          text(
              online
                  ? "Подключите приставку к Wi-Fi или Ethernet, чтобы открыть каталог с других"
                      + " устройств."
                  : "Сначала запустите сервер. После запуска здесь появятся адрес и QR-код.",
              16,
              DashboardView.TEXT));
    AlertDialog.Builder builder =
        new AlertDialog.Builder(this)
            .setTitle("Читать на другом устройстве")
            .setView(content)
            .setNegativeButton("Назад", null);
    if (online && lan.length > 0)
      builder.setPositiveButton(
          "Скопировать адрес",
          (d, w) -> {
            getSystemService(ClipboardManager.class)
                .setPrimaryClip(ClipData.newPlainText("INPX Server", serverUrl));
            toast("Адрес скопирован");
          });
    show(builder.create());
  }

  @Override
  public void catalog() {
    if (!online) {
      toast("Сначала запустите сервер.");
      return;
    }
    try {
      startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("http://127.0.0.1:" + activePort)));
    } catch (ActivityNotFoundException e) {
      connect();
    }
  }

  @Override
  public void journal() {
    TextView output =
        text(
            journal.isEmpty() ? "Журнал появится после первого запуска сервера." : journal,
            12,
            DashboardView.MUTED);
    output.setTypeface(Typeface.MONOSPACE);
    output.setPadding(dp(20), dp(8), dp(20), dp(12));
    output.setTextIsSelectable(!tv);
    ScrollView scroll = new ScrollView(this);
    scroll.addView(output);
    scroll.setFocusable(true);
    scroll.setContentDescription("Журнал сервера");
    AlertDialog d =
        new AlertDialog.Builder(this)
            .setTitle("Журнал сервера")
            .setView(scroll)
            .setNegativeButton("Назад", null)
            .create();
    show(d);
    if (tv) {
      scroll.requestFocus();
      scroll.setOnKeyListener(
          (v, key, event) -> {
            if (event.getAction() == KeyEvent.ACTION_DOWN
                && (key == KeyEvent.KEYCODE_DPAD_DOWN || key == KeyEvent.KEYCODE_DPAD_UP)) {
              scroll.smoothScrollBy(0, dp(key == KeyEvent.KEYCODE_DPAD_DOWN ? 100 : -100));
              return true;
            }
            return false;
          });
    }
  }

  private int dp(float n) {
    return Math.round(n * getResources().getDisplayMetrics().density);
  }

  private LinearLayout form() {
    LinearLayout l = new LinearLayout(this);
    l.setOrientation(LinearLayout.VERTICAL);
    l.setPadding(dp(24), dp(8), dp(24), dp(16));
    return l;
  }

  private TextView text(String value, float size, int color) {
    TextView t = new TextView(this);
    t.setText(value);
    t.setTextSize(size);
    t.setTextColor(color);
    t.setPadding(0, dp(6), 0, dp(10));
    return t;
  }

  private EditText field(String hint, boolean password) {
    EditText f = new EditText(this);
    f.setId(View.generateViewId());
    f.setHint(hint);
    f.setTextSize(tv ? 17 : 16);
    f.setTextColor(DashboardView.TEXT);
    f.setHintTextColor(DashboardView.MUTED);
    f.setSingleLine(true);
    f.setMinHeight(dp(tv ? 56 : 50));
    f.setInputType(
        InputType.TYPE_CLASS_TEXT
            | (password
                ? InputType.TYPE_TEXT_VARIATION_PASSWORD
                : InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS));
    f.setShowSoftInputOnFocus(!tv);
    f.setOnKeyListener(
        (v, key, event) -> {
          if (!tv) return false;
          if (key == KeyEvent.KEYCODE_DPAD_CENTER || key == KeyEvent.KEYCODE_ENTER) {
            if (event.getAction() == KeyEvent.ACTION_UP)
              getSystemService(InputMethodManager.class)
                  .showSoftInput(f, InputMethodManager.SHOW_IMPLICIT);
            return true;
          }
          if ((key == KeyEvent.KEYCODE_DPAD_DOWN || key == KeyEvent.KEYCODE_DPAD_UP)
              && event.getAction() == KeyEvent.ACTION_DOWN) {
            View next =
                f.focusSearch(key == KeyEvent.KEYCODE_DPAD_DOWN ? View.FOCUS_DOWN : View.FOCUS_UP);
            if (next != null && next != f) {
              next.requestFocus();
              return true;
            }
          }
          return false;
        });
    return f;
  }

  private void fieldRow(LinearLayout form, String title, EditText field) {
    TextView label = text(title, 12, DashboardView.MUTED);
    label.setPadding(0, dp(8), 0, 0);
    label.setLabelFor(field.getId());
    form.addView(label);
    form.addView(field);
  }

  private void wireFields(EditText[] fields, AlertDialog dialog) {
    Button positive = dialog.getButton(-1), negative = dialog.getButton(-2);
    positive.setId(View.generateViewId());
    negative.setId(View.generateViewId());
    for (int i = 0; i < fields.length; i++) {
      final int next = i + 1;
      EditText f = fields[i];
      f.setNextFocusDownId(i + 1 < fields.length ? fields[i + 1].getId() : positive.getId());
      f.setNextFocusForwardId(i + 1 < fields.length ? fields[i + 1].getId() : positive.getId());
      f.setNextFocusUpId(i == 0 ? negative.getId() : fields[i - 1].getId());
      f.setImeOptions(
          i + 1 < fields.length ? EditorInfo.IME_ACTION_NEXT : EditorInfo.IME_ACTION_DONE);
      f.setOnEditorActionListener(
          (v, action, event) -> {
            if (action == EditorInfo.IME_ACTION_NEXT || action == EditorInfo.IME_ACTION_DONE) {
              if (next < fields.length) fields[next].requestFocus();
              else {
                getSystemService(InputMethodManager.class)
                    .hideSoftInputFromWindow(f.getWindowToken(), 0);
                positive.requestFocus();
              }
              return true;
            }
            return false;
          });
    }
    positive.setNextFocusUpId(fields[fields.length - 1].getId());
    negative.setNextFocusUpId(fields[fields.length - 1].getId());
    if (tv) fields[0].requestFocus();
  }

  private void show(AlertDialog dialog) {
    dialog.show();
    dialog
        .getWindow()
        .setSoftInputMode(
            WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN
                | WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    dialog
        .getWindow()
        .setBackgroundDrawable(dashboard.shape(DashboardView.SURFACE, DashboardView.BORDER, 1, 20));
    int available = getResources().getConfiguration().screenWidthDp;
    dialog
        .getWindow()
        .setLayout(
            dp(Math.min(tv ? 650 : 560, available - 40)), WindowManager.LayoutParams.WRAP_CONTENT);
    for (int id : new int[] {-1, -2, -3}) {
      Button button = dialog.getButton(id);
      if (button == null) continue;
      StateListDrawable bg = new StateListDrawable();
      bg.addState(
          new int[] {android.R.attr.state_focused},
          dashboard.shape(DashboardView.MINT, android.graphics.Color.WHITE, 2, 10));
      bg.addState(
          new int[] {}, dashboard.shape(DashboardView.SURFACE, DashboardView.BORDER, 1, 10));
      button.setBackground(bg);
      button.setMinHeight(dp(48));
      button.setPadding(dp(14), dp(4), dp(14), dp(4));
      button.setAllCaps(false);
      button.setTextColor(
          new ColorStateList(
              new int[][] {new int[] {android.R.attr.state_focused}, new int[] {}},
              new int[] {DashboardView.BG, DashboardView.MINT}));
    }
    if (dialog.getListView() != null)
      dialog
          .getListView()
          .setSelector(
              dashboard.shape(android.graphics.Color.rgb(39, 77, 72), DashboardView.MINT, 2, 10));
  }

  private void error(Throwable e) {
    if (!destroyed)
      show(
          new AlertDialog.Builder(this)
              .setTitle("INPX Server")
              .setMessage(e.getMessage() == null ? "Не удалось выполнить действие" : e.getMessage())
              .setPositiveButton("Понятно", null)
              .create());
  }

  private void toast(String value) {
    Toast.makeText(this, value, Toast.LENGTH_LONG).show();
  }

  @Override
  public void onResume() {
    super.onResume();
    visible = true;
    handler.removeCallbacks(poll);
    handler.post(poll);
  }

  @Override
  public void onPause() {
    super.onPause();
    visible = false;
    handler.removeCallbacks(poll);
  }

  @Override
  public void onDestroy() {
    destroyed = true;
    handler.removeCallbacks(poll);
    executor.shutdownNow();
    sourceExecutor.shutdownNow();
    super.onDestroy();
  }

  private void refresh() {
    if (!visible || checking || destroyed) return;
    checking = true;
    final int preferred = readPort();
    executor.execute(
        () -> {
          boolean available = false, busy = serviceRunning();
          String message = detail, tail = "";
          int p = preferred;
          String[] ips = new String[0];
          JSONArray health = sourceHealth;
          try {
            health = SourceHealth.read(getApplicationContext());
          } catch (Exception ignored) {
          }
          try {
            File configFile = new File(getFilesDir(), "data/config.json");
            if (configFile.exists())
              p =
                  new JSONObject(Io.read(configFile))
                      .getJSONObject("server")
                      .optInt("port", preferred);
          } catch (Exception ignored) {
          }
          try {
            File state = new File(getFilesDir(), "status.txt");
            if (state.exists()) message = Io.read(state);
            if (message.startsWith("Ошибка") || message.contains("остановлен")) busy = false;
            HttpURLConnection connection =
                (HttpURLConnection) new URL("http://127.0.0.1:" + p + "/health").openConnection();
            connection.setConnectTimeout(700);
            connection.setReadTimeout(700);
            try {
              available = connection.getResponseCode() == 200;
            } finally {
              connection.disconnect();
            }
            if (available) {
              busy = false;
              ips = addresses();
            }
          } catch (Exception ignored) {
          }
          if (!available && !busy && !message.startsWith("Ошибка"))
            message = "Запустите сервер, чтобы читать книги с любого устройства в вашей сети.";
          try (RandomAccessFile file =
              new RandomAccessFile(new File(getFilesDir(), "data/node.log"), "r")) {
            file.seek(Math.max(0, file.length() - 14000));
            byte[] bytes = new byte[(int) (file.length() - file.getFilePointer())];
            file.readFully(bytes);
            tail = new String(bytes, StandardCharsets.UTF_8);
          } catch (Exception ignored) {
          }
          final boolean live = available, pending = busy;
          final String note = message, logs = tail;
          final int endpoint = p;
          final String[] network = ips;
          final JSONArray diagnostics = health;
          handler.post(
              () -> {
                checking = false;
                if (destroyed) return;
                online = live;
                starting = pending;
                detail = note;
                journal = logs;
                sourceHealth = diagnostics;
                activePort = endpoint;
                lan = network;
                serverUrl = network.length > 0 ? "http://" + network[0] + ":" + endpoint : "";
                updateDashboard();
                if (visible) handler.postDelayed(poll, 2000);
              });
        });
  }

  private boolean serviceRunning() {
    android.app.ActivityManager manager = getSystemService(android.app.ActivityManager.class);
    if (manager != null)
      for (android.app.ActivityManager.RunningServiceInfo service : manager.getRunningServices(16))
        if (ServerService.class.getName().equals(service.service.getClassName())) return true;
    return false;
  }

  private String[] addresses() throws Exception {
    LinkedHashSet<String> result = new LinkedHashSet<>();
    for (NetworkInterface n : Collections.list(NetworkInterface.getNetworkInterfaces()))
      if (n.isUp() && !n.isLoopback())
        for (java.net.InetAddress a : Collections.list(n.getInetAddresses()))
          if (a instanceof Inet4Address && !a.isLoopbackAddress() && a.isSiteLocalAddress())
            result.add(a.getHostAddress());
    return result.toArray(new String[0]);
  }
}
