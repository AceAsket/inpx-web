package ru.inpx.server;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;

final class EmbeddedReader {
  private static final String ACTIVITY = "ru.inpx.reader.MainActivity";
  private static final String LOCAL_PORT = "ru.inpx.reader.LOCAL_PORT";

  private EmbeddedReader() {}

  private static ComponentName component(Context context) {
    return new ComponentName(context.getPackageName(), ACTIVITY);
  }

  static boolean available(Context context) {
    try {
      context.getPackageManager().getActivityInfo(component(context), 0);
      return true;
    } catch (PackageManager.NameNotFoundException ignored) {
      return false;
    }
  }

  static void open(Context context, int port) {
    context.startActivity(new Intent().setComponent(component(context)).putExtra(LOCAL_PORT, port));
  }
}
