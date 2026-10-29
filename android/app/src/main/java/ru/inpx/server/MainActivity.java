package ru.inpx.server;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.UiModeManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import ru.inpx.server.presentation.*;

/** Android lifecycle and navigation only. State and commands are owned by DashboardPresenter. */
public final class MainActivity extends Activity
    implements DashboardView.Actions, DashboardPresenter.View {
  private DashboardState state = DashboardState.initial();
  private DashboardPresenter presenter;
  private DashboardView dashboard;
  private DialogUi ui;
  private SourceDialogs sources;
  private ConnectionDialogs connections;
  private SettingsDialogs settings;
  private String layout = "", nextFocus = "primary";
  private boolean tv;
  private final Handler handler = new Handler();
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private final ExecutorService sourceWorker = Executors.newSingleThreadExecutor();

  @Override
  public void onCreate(Bundle saved) {
    super.onCreate(saved);
    presenter =
        new DashboardPresenter(
            new AndroidServerRepository(this),
            worker,
            sourceWorker,
            new HandlerScheduler(handler),
            this);
    render(state);
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
    String choice = state.uiMode;
    tv = choice.equals("tv") || (choice.equals("auto") && automaticTv());
    dashboard =
        new DashboardView(
            this, tv, choice.equals("auto") ? "Авто" : tv ? "ТВ" : "Сенсор", state.sources, this);
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
    ui = new DialogUi(this, tv, dashboard, presenter, () -> state, key -> nextFocus = key);
    sources = new SourceDialogs(ui, this::folder, this::demo);
    connections = new ConnectionDialogs(ui);
    settings = new SettingsDialogs(ui);
    dashboard.update(state);
    DashboardView rendered = dashboard;
    FocusRequests.whenReady(
        dashboard.root,
        () -> {
          if (!isDestroyed() && dashboard == rendered) rendered.focus(focus);
        });
  }

  @Override
  public void render(DashboardState next) {
    boolean firstLoad = state.phase == DashboardState.Phase.LOADING;
    state = next;
    if (dashboard == null || !layout.equals(next.layoutKey())) {
      String target =
          nextFocus != null
              ? nextFocus
              : firstLoad || dashboard == null ? "primary" : dashboard.focusKey();
      layout = next.layoutKey();
      nextFocus = null;
      render(target);
    } else dashboard.update(state);
    if (sources != null) sources.updateDiagnostics();
  }

  @Override
  public void toggle() {
    if (state.busy()) {
      ui.toast(state.detail);
      return;
    }
    if (!state.online()) {
      if (state.sources.isEmpty()) sources.add();
      else presenter.start(false);
      return;
    }
    AlertDialog dialog =
        new AlertDialog.Builder(this)
            .setTitle("Остановить сервер?")
            .setMessage(
                "Каталог станет недоступен другим устройствам. Библиотека и настройки сохранятся.")
            .setPositiveButton("Остановить", (d, w) -> presenter.stop())
            .setNegativeButton("Продолжить работу", null)
            .create();
    ui.show(dialog);
    if (tv) dialog.getButton(-2).requestFocus();
  }

  @Override
  public void demo() {
    if (state.online() || state.busy()) {
      ui.toast("Сначала остановите текущий сервер.");
      return;
    }
    presenter.start(true);
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
    } catch (ActivityNotFoundException error) {
      ui.error(
          new Exception(
              "На этой приставке нет системного выбора папок. Подключите библиотеку по SMB."));
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
      sources.tree(uri.toString());
    } catch (Exception error) {
      ui.error(error);
    }
  }

  @Override
  public void mode() {
    settings.mode();
  }

  @Override
  public void smb() {
    sources.smb(null);
  }

  @Override
  public void source(String id) {
    sources.open(id);
  }

  @Override
  public void diagnostics() {
    sources.diagnostics();
  }

  @Override
  public void power() {
    settings.power();
  }

  @Override
  public void settings() {
    settings.settings();
  }

  @Override
  public void connect() {
    connections.connect();
  }

  @Override
  public void catalog() {
    connections.catalog();
  }

  @Override
  public void journal() {
    connections.journal();
  }

  @Override
  public void community() {
    connections.community();
  }

  @Override
  public void error(Throwable error) {
    ui.error(error);
  }

  @Override
  public void message(String message) {
    ui.toast(message);
  }

  @Override
  public void onResume() {
    super.onResume();
    presenter.resume();
  }

  @Override
  public void onPause() {
    presenter.pause();
    super.onPause();
  }

  @Override
  public void onDestroy() {
    presenter.close();
    worker.shutdownNow();
    sourceWorker.shutdownNow();
    super.onDestroy();
  }
}
