package ru.inpx.server;

import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.drawable.StateListDrawable;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import ru.inpx.server.presentation.*;

/** Port, input mode and background policy forms. Commands go through the presenter. */
final class SettingsDialogs extends DialogUi {
  SettingsDialogs(DialogUi base) {
    super(base);
  }

  public void mode() {
    String[] values = {"auto", "touch", "tv"};
    String selected = current.get().uiMode;
    int current = selected.equals("tv") ? 2 : selected.equals("touch") ? 1 : 0;
    AlertDialog dialog =
        new AlertDialog.Builder(activity)
            .setTitle("Как управлять приложением")
            .setSingleChoiceItems(
                new String[] {
                  "Автоматически · по типу устройства",
                  "Касания · телефон и планшет",
                  "Пульт · телевизор и приставка"
                },
                current,
                (d, which) -> {
                  focus.accept("mode");
                  presenter.saveMode(values[which], d::dismiss);
                })
            .setNegativeButton("Назад", null)
            .create();
    show(dialog);
  }

  public void power() {
    presenter.power(this::showPower);
  }

  private void showPower(PowerSettings state) {
    try {
      LinearLayout content = form();
      CheckBox awake =
          powerOption(content, "Поддерживать работу с выключенным экраном", state.keepAwake);
      CheckBox boot = powerOption(content, "Запускать после включения устройства", state.autoBoot);
      CheckBox battery =
          powerOption(content, "Останавливать при отключении питания", state.stopOnBattery);
      content.addView(
          text(
              "Автозапуск восстанавливает только ранее запущенный сервер. После ручной остановки он"
                  + " остаётся выключенным. После отключения питания запуск выполняется вручную.",
              13,
              DashboardView.MUTED));
      boolean exempt = state.batteryExempt;
      String diagnostic =
          (state.charging ? "Питание подключено" : "Работа от аккумулятора")
              + " · Оптимизация батареи: "
              + (exempt ? "без ограничений" : "включена");
      if (state.lowPowerStandby) {
        diagnostic += "\nОжидание низкого потребления включено";
        if (Build.VERSION.SDK_INT >= 34)
          diagnostic +=
              state.lowPowerExempt ? " · приложение исключено" : " · сеть может отключаться";
      }
      content.addView(text(diagnostic, 13, DashboardView.MINT));
      content.addView(
          text(
              "Для постоянного доступа оставьте приставку на питании и разрешите приложению работу"
                  + " без ограничений в настройках Android. Режим сна устройства может отключать"
                  + " сеть даже у фоновой службы.",
              13,
              DashboardView.MUTED));
      ScrollView scroll = new ScrollView(activity);
      scroll.addView(content);
      AlertDialog d =
          new AlertDialog.Builder(activity)
              .setTitle("Фоновая работа")
              .setView(scroll)
              .setPositiveButton(
                  "Сохранить",
                  (dialog, which) -> {
                    try {
                      presenter.savePower(
                          awake.isChecked(),
                          boot.isChecked(),
                          battery.isChecked(),
                          () -> toast("Настройки фоновой работы сохранены"));
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
                  activity.startActivity(
                      new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                } catch (ActivityNotFoundException e) {
                  activity.startActivity(
                      new Intent(
                          Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                          Uri.parse("package:" + activity.getPackageName())));
                }
              });
      awake.setNextFocusDownId(boot.getId());
      boot.setNextFocusUpId(awake.getId());
      boot.setNextFocusDownId(battery.getId());
      battery.setNextFocusUpId(boot.getId());
      d.getButton(-1).setId(View.generateViewId());
      battery.setNextFocusDownId(d.getButton(-1).getId());
      d.getButton(-1).setNextFocusUpId(battery.getId());
      if (tv) FocusRequests.whenReady(awake, awake::requestFocus);
    } catch (Exception e) {
      error(e);
    }
  }

  private CheckBox powerOption(LinearLayout form, String label, boolean checked) {
    CheckBox box = new CheckBox(activity);
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

  public void settings() {
    LinearLayout form = form();
    EditText input = field("12380", false);
    input.setInputType(InputType.TYPE_CLASS_NUMBER);
    input.setText(String.valueOf(current.get().preferredPort));
    fieldRow(form, "Порт сервера", input);
    form.addView(
        text(
            "От 1024 до 65535. Новое значение применяется при следующем запуске сервера.",
            13,
            DashboardView.MUTED));
    AlertDialog d =
        new AlertDialog.Builder(activity)
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
              try {
                presenter.savePort(
                    input.getText().toString(),
                    () -> {
                      d.dismiss();
                      toast(
                          current.get().online()
                              ? "Порт изменится после перезапуска сервера"
                              : "Порт сохранён");
                    });
              } catch (Exception e) {
                input.setError(e.getMessage());
                input.requestFocus();
              }
            });
  }
}
