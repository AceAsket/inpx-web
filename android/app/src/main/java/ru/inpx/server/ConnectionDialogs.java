package ru.inpx.server;

import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.view.Gravity;
import android.view.KeyEvent;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import ru.inpx.server.presentation.*;

/** Connection sharing, catalog, logs and community. All content comes from screen state. */
final class ConnectionDialogs extends DialogUi {
  private static final String COMMUNITY_URL = "https://t.me/inpxweb";

  ConnectionDialogs(DialogUi base) {
    super(base);
  }

  public void community() {
    LinearLayout content = form();
    content.addView(
        text(
            "Обсуждение INPX Web в Telegram. Откройте ссылку на устройстве или отсканируйте QR-код"
                + " телефоном.",
            14,
            DashboardView.MUTED));
    QrView qr = new QrView(activity);
    qr.setUrl(COMMUNITY_URL);
    LinearLayout.LayoutParams size = new LinearLayout.LayoutParams(dp(180), dp(180));
    size.gravity = Gravity.CENTER_HORIZONTAL;
    size.topMargin = dp(12);
    size.bottomMargin = dp(12);
    content.addView(qr, size);
    TextView link = text(COMMUNITY_URL, tv ? 18 : 16, DashboardView.MINT);
    link.setGravity(Gravity.CENTER);
    content.addView(link);
    ScrollView scroll = new ScrollView(activity);
    scroll.addView(content);
    AlertDialog d =
        new AlertDialog.Builder(activity)
            .setTitle("Сообщество INPX Web")
            .setView(scroll)
            .setPositiveButton(
                "Открыть",
                (dialog, which) -> {
                  try {
                    activity.startActivity(
                        new Intent(Intent.ACTION_VIEW, Uri.parse(COMMUNITY_URL)));
                  } catch (ActivityNotFoundException e) {
                    activity
                        .getSystemService(ClipboardManager.class)
                        .setPrimaryClip(ClipData.newPlainText("Telegram INPX Web", COMMUNITY_URL));
                    toast("Нет приложения для открытия ссылки. Ссылка скопирована.");
                  }
                })
            .setNeutralButton(
                "Скопировать",
                (dialog, which) -> {
                  activity
                      .getSystemService(ClipboardManager.class)
                      .setPrimaryClip(ClipData.newPlainText("Telegram INPX Web", COMMUNITY_URL));
                  toast("Ссылка скопирована");
                })
            .setNegativeButton("Закрыть", null)
            .create();
    show(d);
    if (tv) {
      Button open = d.getButton(-1);
      open.setFocusableInTouchMode(true);
      FocusRequests.whenReady(open, open::requestFocus);
    }
  }

  public void connect() {
    DashboardState state = current.get();
    boolean online = state.online();
    String serverUrl = state.url();
    int activePort = state.activePort;
    String[] lan = state.addresses.toArray(new String[0]);
    LinearLayout content = form();
    if (online && lan.length > 0) {
      QrView code = new QrView(activity);
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
        new AlertDialog.Builder(activity)
            .setTitle("Читать на другом устройстве")
            .setView(content)
            .setNegativeButton("Назад", null);
    if (online && lan.length > 0)
      builder.setPositiveButton(
          "Скопировать адрес",
          (d, w) -> {
            activity
                .getSystemService(ClipboardManager.class)
                .setPrimaryClip(ClipData.newPlainText("INPX Server", serverUrl));
            toast("Адрес скопирован");
          });
    show(builder.create());
  }

  public void catalog() {
    boolean online = current.get().online();
    int activePort = current.get().activePort;
    if (!online) {
      toast("Сначала запустите сервер.");
      return;
    }
    try {
      activity.startActivity(
          new Intent(Intent.ACTION_VIEW, Uri.parse("http://127.0.0.1:" + activePort)));
    } catch (ActivityNotFoundException e) {
      connect();
    }
  }

  public void journal() {
    String journal = current.get().journal;
    TextView output =
        text(
            journal.isEmpty() ? "Журнал появится после первого запуска сервера." : journal,
            12,
            DashboardView.MUTED);
    output.setTypeface(Typeface.MONOSPACE);
    output.setPadding(dp(20), dp(8), dp(20), dp(12));
    output.setTextIsSelectable(!tv);
    ScrollView scroll = new ScrollView(activity);
    scroll.addView(output);
    scroll.setFocusable(true);
    scroll.setContentDescription("Журнал сервера");
    AlertDialog d =
        new AlertDialog.Builder(activity)
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
}
