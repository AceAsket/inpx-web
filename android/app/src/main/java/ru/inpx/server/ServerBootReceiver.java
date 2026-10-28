package ru.inpx.server;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import org.json.JSONObject;

/** Runs after credential storage is unlocked; does not start a manually stopped server. */
public final class ServerBootReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    String action = intent.getAction();
    if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
        && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
    PendingResult pending = goAsync();
    new Thread(
            () -> {
              try {
                JSONObject state = ServerControl.read(context);
                boolean enabled =
                    Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                        || state.optBoolean("autoBoot");
                if (enabled
                    && state.optBoolean("requested")
                    && !state.optBoolean("blocked")
                    && !ServerControl.userStopped(context)) {
                  if (state.optBoolean("stopOnBattery") && !ServerControl.charging(context)) return;
                  ServerControl.requestService(context);
                }
              } catch (Exception e) {
                try {
                  Io.write(
                      new java.io.File(context.getFilesDir(), "status.txt"),
                      "Автозапуск недоступен. Откройте INPX Server: " + e.getMessage());
                } catch (Exception ignored) {
                }
              } finally {
                pending.finish();
              }
            },
            "inpx-boot")
        .start();
  }
}
