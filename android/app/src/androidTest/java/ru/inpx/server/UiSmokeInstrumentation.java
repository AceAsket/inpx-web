package ru.inpx.server;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Device UI checks use real D-pad events and leave sources, credentials and port untouched. */
public final class UiSmokeInstrumentation extends Instrumentation {
  private Activity activity;
  private final JSONArray checks = new JSONArray();
  private boolean background;
  private boolean storage;
  private boolean storageOnly;

  @Override
  public void onCreate(Bundle args) {
    super.onCreate(args);
    background = "true".equals(args.getString("background"));
    storage = "true".equals(args.getString("storage"));
    storageOnly = "true".equals(args.getString("storageOnly"));
    start();
  }

  @Override
  public void onStart() {
    SharedPreferences preferences = getTargetContext().getSharedPreferences("MainActivity", 0);
    String previous = preferences.getString("ui_mode", null);
    Bundle result = new Bundle();
    int resultCode = Activity.RESULT_OK;
    try {
      if (storageOnly) {
        JSONObject report = StorageChecks.run(getTargetContext());
        result.putString("stream", report.toString(2));
        finish(report.optBoolean("passed") ? Activity.RESULT_OK : Activity.RESULT_CANCELED, result);
        return;
      }
      JSONObject repositoryReport = RepositoryChecks.run(getTargetContext());
      require(
          repositoryReport.optBoolean("passed"), "Isolated repository checks: " + repositoryReport);
      open(preferences, "tv");
      noOverlay("TV home keeps controls inside the content area");
      require("primary".equals(focused()), "TV starts with visible focus on primary action");
      focusBounds("Primary focus outline is fully visible");
      key(KeyEvent.KEYCODE_DPAD_DOWN);
      require("connection".equals(focused()), "Down reaches connection details");
      key(KeyEvent.KEYCODE_DPAD_DOWN);
      require("catalog".equals(focused()), "Down reaches catalog");
      key(KeyEvent.KEYCODE_DPAD_DOWN);
      require("demo".equals(focused()), "Down reaches demo");
      focus("primary");
      key(KeyEvent.KEYCODE_DPAD_RIGHT);
      require("folder".equals(focused()), "Right moves into sources");
      key(KeyEvent.KEYCODE_DPAD_DOWN);
      require("smb".equals(focused()), "Down reaches SMB");
      List<String> sources = new ArrayList<>();
      runOnMainSync(() -> collectSourceTags(activity.getWindow().getDecorView(), sources));
      for (String source : sources) {
        key(KeyEvent.KEYCODE_DPAD_DOWN);
        require(source.equals(focused()), "D-pad reaches saved source");
      }
      key(KeyEvent.KEYCODE_DPAD_DOWN);
      require("diagnostics".equals(focused()), "D-pad reaches source diagnostics");
      focusBounds("Focus outline inside source card is fully visible");
      key(KeyEvent.KEYCODE_DPAD_CENTER);
      require(
          awaitFocusedClass("Button"),
          "Diagnostics starts with a focused action: " + activeFocusedClass());
      key(KeyEvent.KEYCODE_DPAD_CENTER);
      SystemClock.sleep(2400);
      require(
          activeFocusedClass().contains("Button"), "Manual source check preserves remote focus");
      screenshot("diagnostics");
      key(KeyEvent.KEYCODE_BACK);
      require("diagnostics".equals(focused()), "Closing diagnostics restores remote focus");
      key(KeyEvent.KEYCODE_DPAD_DOWN);
      require("power".equals(focused()), "D-pad reaches background settings");
      key(KeyEvent.KEYCODE_DPAD_CENTER);
      require(
          awaitFocusedClass("CheckBox"), "Background settings load without blocking the screen");
      screenshot("power-open");
      require(
          activeFocusedClass().contains("CheckBox"),
          "Background options have remote focus: " + activeFocusedClass());
      for (int i = 0; i < 2; i++) {
        key(KeyEvent.KEYCODE_DPAD_DOWN);
        require(
            activeFocusedClass().contains("CheckBox"), "Background option is reachable by remote");
      }
      key(KeyEvent.KEYCODE_DPAD_DOWN);
      require(activeFocusedClass().contains("Button"), "Background settings reach Save");
      screenshot("power");
      key(KeyEvent.KEYCODE_BACK);
      key(KeyEvent.KEYCODE_DPAD_DOWN);
      require("settings".equals(focused()), "D-pad reaches settings");
      key(KeyEvent.KEYCODE_DPAD_RIGHT);
      require("journal".equals(focused()), "Right reaches journal in the same row");
      key(KeyEvent.KEYCODE_DPAD_RIGHT);
      require("community".equals(focused()), "Right reaches Telegram community");
      focusBounds("Telegram button focus outline is fully visible");
      key(KeyEvent.KEYCODE_DPAD_CENTER);
      require(awaitFocusedClass("Button"), "Community dialog focuses its open action");
      AccessibilityNodeInfo communityRoot = getUiAutomation().getRootInActiveWindow();
      require(
          !communityRoot.findAccessibilityNodeInfosByText("https://t.me/inpxweb").isEmpty(),
          "Community dialog includes the requested Telegram URL");
      screenshot("community");
      key(KeyEvent.KEYCODE_BACK);
      require(
          "community".equals(focused()),
          "Community dialog returns focus without opening external apps");
      key(KeyEvent.KEYCODE_DPAD_LEFT);
      key(KeyEvent.KEYCODE_DPAD_LEFT);
      require("settings".equals(focused()), "Left returns to settings");
      String before = focused();
      SystemClock.sleep(2400);
      require(before.equals(focused()), "Status polling preserves remote focus");
      focusBounds("Bottom-row focus outline is fully visible");
      noOverlay("TV source-column scrolling does not cover header or footer");
      screenshot("tv");
      key(KeyEvent.KEYCODE_DPAD_CENTER);
      require(activeFocusedClass().contains("EditText"), "OK opens settings with field focused");
      key(KeyEvent.KEYCODE_DPAD_DOWN);
      require(
          activeFocusedClass().contains("Button"),
          "Field Down reaches Save without opening keyboard");
      key(KeyEvent.KEYCODE_BACK);
      require("settings".equals(focused()), "Back dismisses dialog and restores focus");
      focus("smb");
      key(KeyEvent.KEYCODE_DPAD_CENTER);
      for (int i = 0; i < 7; i++) {
        require(
            activeFocusedClass().contains("EditText"),
            "SMB field " + (i + 1) + " is reachable by remote");
        key(KeyEvent.KEYCODE_DPAD_DOWN);
      }
      require(activeFocusedClass().contains("Button"), "SMB form reaches submit without touch");
      key(KeyEvent.KEYCODE_BACK);
      require("smb".equals(focused()), "SMB cancel returns to original control");
      open(preferences, "touch");
      require(
          find("primary") != null && find("folder") != null && find("mode") != null,
          "Touch layout exposes main actions");
      require(
          !(activity.getCurrentFocus() instanceof android.widget.EditText),
          "Touch home never opens a keyboard");
      screenshot("touch");
      noOverlay("Touch layout keeps controls separate from header and footer");
      runOnMainSync(() -> find("mode").performClick());
      waitForIdleSync();
      AccessibilityNodeInfo root = getUiAutomation().getRootInActiveWindow();
      List<AccessibilityNodeInfo> choices =
          root.findAccessibilityNodeInfosByText("Пульт · телевизор и приставка");
      require(!choices.isEmpty(), "Manual interface switch is available");
      AccessibilityNodeInfo choice = choices.get(0);
      while (!choice.isClickable() && choice.getParent() != null) choice = choice.getParent();
      choice.performAction(AccessibilityNodeInfo.ACTION_CLICK);
      waitForIdleSync();
      long modeDeadline = SystemClock.elapsedRealtime() + 3000;
      while (SystemClock.elapsedRealtime() < modeDeadline
          && (!"tv".equals(preferences.getString("ui_mode", ""))
              || !"mode".equals(focused())
              || !String.valueOf(find("mode").getContentDescription()).contains("ТВ")))
        SystemClock.sleep(50);
      waitForIdleSync();
      require(
          "tv".equals(preferences.getString("ui_mode", "")), "Manual switch persists TV choice");
      require("mode".equals(focused()), "Switching layout restores focus to mode control");
      focusBounds("Header focus outline is fully visible");
      if (background) {
        JSONObject backgroundReport = BackgroundChecks.run(getTargetContext());
        require(
            backgroundReport.optBoolean("passed"),
            "Background and converter device checks: " + backgroundReport);
      }
      if (storage) {
        JSONObject storageReport = StorageChecks.run(getTargetContext());
        require(storageReport.optBoolean("passed"), "Source reconnect checks: " + storageReport);
      }
      JSONObject report = new JSONObject().put("passed", true).put("checks", checks);
      writeReport(report);
      result.putString("stream", report.toString(2));
    } catch (Throwable error) {
      try {
        writeReport(
            new JSONObject()
                .put("passed", false)
                .put("checks", checks)
                .put("error", error.toString()));
      } catch (Exception ignored) {
      }
      result.putString("stream", "UI CHECK FAILED: " + error);
      resultCode = Activity.RESULT_CANCELED;
    } finally {
      if (activity != null) runOnMainSync(() -> activity.finish());
      SharedPreferences.Editor edit = preferences.edit();
      if (previous == null) edit.remove("ui_mode");
      else edit.putString("ui_mode", previous);
      edit.commit();
    }
    finish(resultCode, result);
  }

  private void open(SharedPreferences p, String mode) {
    if (activity != null) {
      runOnMainSync(() -> activity.finish());
      waitForIdleSync();
    }
    p.edit().putString("ui_mode", mode).commit();
    activity =
        startActivitySync(
            new Intent(getTargetContext(), MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    waitForIdleSync();
    long deadline = SystemClock.elapsedRealtime() + 5000;
    String modeLabel = mode.equals("tv") ? "ТВ" : "Сенсор";
    while (SystemClock.elapsedRealtime() < deadline) {
      View modeControl = find("mode");
      if (modeControl != null
          && String.valueOf(modeControl.getContentDescription()).contains(modeLabel)
          && (!mode.equals("tv") || "primary".equals(focused()))) break;
      SystemClock.sleep(50);
    }
    waitForIdleSync();
  }

  private View find(String key) {
    return activity.getWindow().getDecorView().findViewWithTag(key);
  }

  private void focusBounds(String label) throws Exception {
    SystemClock.sleep(180);
    final boolean[] valid = {false};
    runOnMainSync(
        () -> {
          View focused = activity.getCurrentFocus();
          if (focused == null) return;
          android.graphics.Matrix matrix = new android.graphics.Matrix();
          if (android.os.Build.VERSION.SDK_INT >= 29) focused.transformMatrixToGlobal(matrix);
          else {
            int[] origin = new int[2];
            focused.getLocationOnScreen(origin);
            matrix.set(focused.getMatrix());
            android.graphics.RectF offset =
                new android.graphics.RectF(0, 0, focused.getWidth(), focused.getHeight());
            matrix.mapRect(offset);
            matrix.postTranslate(origin[0] - offset.left, origin[1] - offset.top);
          }
          android.graphics.RectF full =
              new android.graphics.RectF(0, 0, focused.getWidth(), focused.getHeight());
          matrix.mapRect(full);
          android.graphics.Rect visible = new android.graphics.Rect();
          valid[0] =
              focused.getGlobalVisibleRect(visible)
                  && full.left >= visible.left - 1.1f
                  && full.top >= visible.top - 1.1f
                  && full.right <= visible.right + 1.1f
                  && full.bottom <= visible.bottom + 1.1f;
        });
    require(valid[0], label);
  }

  private void noOverlay(String label) throws Exception {
    final boolean[] valid = {true};
    runOnMainSync(
        () -> {
          android.graphics.Rect header = new android.graphics.Rect(),
              footer = new android.graphics.Rect();
          View top = find("dashboard-header"), bottom = find("dashboard-footer");
          boolean topVisible = top != null && top.getGlobalVisibleRect(header),
              bottomVisible = bottom != null && bottom.getGlobalVisibleRect(footer);
          checkBounds(
              activity.getWindow().getDecorView(),
              header,
              footer,
              topVisible,
              bottomVisible,
              valid);
        });
    require(valid[0], label);
  }

  private void checkBounds(
      View view,
      android.graphics.Rect header,
      android.graphics.Rect footer,
      boolean top,
      boolean bottom,
      boolean[] valid) {
    if (view instanceof android.widget.Button && !"mode".equals(view.getTag())) {
      android.graphics.Rect bounds = new android.graphics.Rect();
      if (view.getGlobalVisibleRect(bounds)
          && (top && android.graphics.Rect.intersects(bounds, header)
              || bottom && android.graphics.Rect.intersects(bounds, footer))) valid[0] = false;
    }
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++)
        checkBounds(group.getChildAt(i), header, footer, top, bottom, valid);
    }
  }

  private String focused() {
    final String[] key = {""};
    runOnMainSync(
        () -> {
          View v = activity.getCurrentFocus();
          if (v != null && v.getTag() != null) key[0] = v.getTag().toString();
        });
    return key[0];
  }

  private void focus(String key) {
    runOnMainSync(() -> find(key).requestFocus());
    waitForIdleSync();
  }

  private void key(int key) {
    sendKeyDownUpSync(key);
    waitForIdleSync();
    SystemClock.sleep(160);
  }

  private boolean awaitFocusedClass(String expected) {
    long end = SystemClock.elapsedRealtime() + 2500;
    do {
      if (activeFocusedClass().contains(expected)) return true;
      SystemClock.sleep(50);
    } while (SystemClock.elapsedRealtime() < end);
    return false;
  }

  private String activeFocusedClass() {
    AccessibilityNodeInfo root = getUiAutomation().getRootInActiveWindow();
    AccessibilityNodeInfo f =
        root == null ? null : root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
    return f == null ? "" : String.valueOf(f.getClassName());
  }

  private void collectSourceTags(View v, List<String> list) {
    if (v.getTag() instanceof String && v.getTag().toString().startsWith("source:"))
      list.add(v.getTag().toString());
    if (v instanceof ViewGroup) {
      ViewGroup g = (ViewGroup) v;
      for (int i = 0; i < g.getChildCount(); i++) collectSourceTags(g.getChildAt(i), list);
    }
  }

  private void require(boolean condition, String label) throws Exception {
    if (!condition) throw new AssertionError(label);
    checks.put(label);
  }

  private File directory() {
    File d = new File(getTargetContext().getExternalFilesDir(null), "ui-checks");
    d.mkdirs();
    return d;
  }

  private void screenshot(String name) throws Exception {
    Bitmap image = getUiAutomation().takeScreenshot();
    if (image == null) throw new AssertionError("No screenshot");
    try (FileOutputStream out = new FileOutputStream(new File(directory(), name + ".png"))) {
      image.compress(Bitmap.CompressFormat.PNG, 100, out);
    }
    image.recycle();
  }

  private void writeReport(JSONObject report) throws Exception {
    try (FileOutputStream out = new FileOutputStream(new File(directory(), "report.json"))) {
      out.write(report.toString(2).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
  }
}
